import asyncio
import json
import os
import time
import uuid
from contextlib import asynccontextmanager

import aio_pika
import redis.asyncio as redis
import uvicorn
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse, Response
from opentelemetry import propagate
from opentelemetry import trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, Field

from telemetry import setup_telemetry, structured_log

SERVICE_NAME = os.getenv("SERVICE_NAME", "test-fastapi-service")
PORT = int(os.getenv("SERVICE_PORT", "8083"))
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://demo:demo@postgres:5432/demo")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://demo:demo@rabbitmq:5672/")
RABBITMQ_QUEUE = os.getenv("RABBITMQ_QUEUE", "test.events")
CACHE_KEY = "test:items"
CACHE_TTL_SECONDS = 30

tracer, logger = setup_telemetry(SERVICE_NAME)


async def connect_rabbitmq():
    while True:
        try:
            return await aio_pika.connect_robust(RABBITMQ_URL)
        except aio_pika.exceptions.AMQPConnectionError as exc:
            structured_log(logger, "rabbitmq_connect_retry", error=str(exc))
            await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = AsyncConnectionPool(DATABASE_URL, open=False)
    await app.state.pool.open(wait=True)
    async with app.state.pool.connection() as conn:
        await conn.execute(
            "CREATE TABLE IF NOT EXISTS test_items ("
            "id SERIAL PRIMARY KEY, "
            "name TEXT NOT NULL, "
            "created_at TIMESTAMPTZ NOT NULL DEFAULT now())"
        )
    app.state.redis = redis.from_url(REDIS_URL, decode_responses=True)
    app.state.rabbit_connection = await connect_rabbitmq()
    app.state.rabbit_channel = await app.state.rabbit_connection.channel(
        publisher_confirms=True
    )
    await app.state.rabbit_channel.declare_queue(RABBITMQ_QUEUE, durable=True)
    yield
    await app.state.rabbit_connection.close()
    await app.state.redis.aclose()
    await app.state.pool.close()


app = FastAPI(title=SERVICE_NAME, lifespan=lifespan)
FastAPIInstrumentor.instrument_app(app, excluded_urls="metrics,health")

REQUESTS = Counter(
    "demo_http_requests_total",
    "Total de solicitudes HTTP del demo",
    ["service", "route", "status"],
)
DURATION = Histogram(
    "demo_http_request_duration_seconds",
    "Duracion de solicitudes HTTP del demo",
    ["service", "route"],
)


def current_trace_id():
    ctx = trace.get_current_span().get_span_context()
    return format(ctx.trace_id, "032x") if ctx.is_valid else None


@app.get("/api/test")
async def test(
    delay_ms: int = Query(100, ge=0, le=2000),
    fail: int = Query(0),
):
    started = time.perf_counter()
    route = "/api/test"
    status = 200

    try:
        with tracer.start_as_current_span("test.business_logic") as span:
            span.set_attribute("demo.delay_ms", delay_ms)
            await asyncio.sleep(delay_ms / 1000)

            if fail == 1:
                status = 500
                structured_log(logger, "test_simulated_error")
                return JSONResponse(
                    status_code=status,
                    content={
                        "ok": False,
                        "service": SERVICE_NAME,
                        "trace_id": current_trace_id(),
                        "error": "Error simulado para validar observabilidad.",
                    },
                )

            structured_log(logger, "test_ok", delay_ms=delay_ms)
            return {
                "ok": True,
                "service": SERVICE_NAME,
                "trace_id": current_trace_id(),
                "message": "pong",
            }
    finally:
        REQUESTS.labels(SERVICE_NAME, route, str(status)).inc()
        DURATION.labels(SERVICE_NAME, route).observe(time.perf_counter() - started)


class ItemIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class EventIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


def record(route: str, status: int, started: float):
    REQUESTS.labels(SERVICE_NAME, route, str(status)).inc()
    DURATION.labels(SERVICE_NAME, route).observe(time.perf_counter() - started)


@app.post("/api/test/items", status_code=201)
async def create_item(item: ItemIn):
    started = time.perf_counter()
    try:
        with tracer.start_as_current_span("test.db_insert") as span:
            span.set_attribute("db.system", "postgresql")
            async with app.state.pool.connection() as conn:
                cur = await conn.execute(
                    "INSERT INTO test_items (name) VALUES (%s) RETURNING id, name, created_at",
                    (item.name,),
                )
                row = await cur.fetchone()

        # El cache queda obsoleto tras escribir
        await app.state.redis.delete(CACHE_KEY)
        structured_log(logger, "item_created", item_id=row[0])
        record("/api/test/items", 201, started)
        return {"id": row[0], "name": row[1], "created_at": row[2].isoformat()}
    except Exception:
        record("/api/test/items", 500, started)
        raise


@app.post("/api/test/events", status_code=202)
async def publish_event(event: EventIn):
    started = time.perf_counter()
    route = "/api/test/events"
    try:
        event_id = str(uuid.uuid4())
        payload = json.dumps(
            {"event_id": event_id, "name": event.name},
            separators=(",", ":"),
        ).encode()
        with tracer.start_as_current_span("test.rabbitmq_publish") as span:
            span.set_attribute("messaging.system", "rabbitmq")
            span.set_attribute("messaging.destination.name", RABBITMQ_QUEUE)
            headers = {}
            propagate.inject(headers)
            await app.state.rabbit_channel.default_exchange.publish(
                aio_pika.Message(
                    body=payload,
                    headers=headers,
                    delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                    content_type="application/json",
                ),
                routing_key=RABBITMQ_QUEUE,
            )
        structured_log(logger, "event_published", event_id=event_id)
        record(route, 202, started)
        return {"accepted": True, "event_id": event_id}
    except Exception:
        record(route, 500, started)
        raise


@app.get("/api/test/items")
async def list_items():
    started = time.perf_counter()
    try:
        with tracer.start_as_current_span("test.cache_lookup") as span:
            span.set_attribute("db.system", "redis")
            cached = await app.state.redis.get(CACHE_KEY)

        if cached:
            structured_log(logger, "items_cache_hit")
            record("/api/test/items", 200, started)
            return {"ok": True, "source": "cache", "items": json.loads(cached)}

        with tracer.start_as_current_span("test.db_select") as span:
            span.set_attribute("db.system", "postgresql")
            async with app.state.pool.connection() as conn:
                cur = await conn.execute(
                    "SELECT id, name, created_at FROM test_items ORDER BY id DESC LIMIT 20"
                )
                rows = await cur.fetchall()

        items = [{"id": r[0], "name": r[1], "created_at": r[2].isoformat()} for r in rows]
        await app.state.redis.set(CACHE_KEY, json.dumps(items), ex=CACHE_TTL_SECONDS)
        structured_log(logger, "items_cache_miss", count=len(items))
        record("/api/test/items", 200, started)
        return {"ok": True, "source": "db", "items": items}
    except Exception:
        record("/api/test/items", 500, started)
        raise


@app.get("/metrics")
def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/health/live")
def live():
    return {"status": "UP", "service": SERVICE_NAME}


@app.get("/health/ready")
def ready():
    return {"status": "UP", "service": SERVICE_NAME}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
