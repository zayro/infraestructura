import asyncio
import os
import time

import uvicorn
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse, Response
from opentelemetry import trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

from telemetry import setup_telemetry, structured_log

SERVICE_NAME = os.getenv("SERVICE_NAME", "test-fastapi-service")
PORT = int(os.getenv("SERVICE_PORT", "8083"))

tracer, logger = setup_telemetry(SERVICE_NAME)
app = FastAPI(title=SERVICE_NAME)
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
