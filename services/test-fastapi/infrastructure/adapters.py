import json
from datetime import datetime

import aio_pika
from opentelemetry import propagate, trace
from psycopg_pool import AsyncConnectionPool
from redis.asyncio import Redis

from domain.models import Event, Item

CACHE_KEY = "test:items"


class PostgresItemsRepository:
    def __init__(self, pool: AsyncConnectionPool, tracer: trace.Tracer):
        self._pool = pool
        self._tracer = tracer

    async def create(self, name: str) -> Item:
        with self._tracer.start_as_current_span("test.db_insert") as span:
            span.set_attribute("db.system", "postgresql")
            async with self._pool.connection() as conn:
                cursor = await conn.execute(
                    "INSERT INTO test_items (name) VALUES (%s) "
                    "RETURNING id, name, created_at",
                    (name,),
                )
                row = await cursor.fetchone()
        return Item(id=row[0], name=row[1], created_at=row[2])

    async def list_recent(self, limit: int) -> list[Item]:
        with self._tracer.start_as_current_span("test.db_select") as span:
            span.set_attribute("db.system", "postgresql")
            async with self._pool.connection() as conn:
                cursor = await conn.execute(
                    "SELECT id, name, created_at FROM test_items "
                    "ORDER BY id DESC LIMIT %s",
                    (limit,),
                )
                rows = await cursor.fetchall()
        return [Item(id=row[0], name=row[1], created_at=row[2]) for row in rows]


class RedisItemsCache:
    def __init__(self, client: Redis, tracer: trace.Tracer):
        self._client = client
        self._tracer = tracer

    async def get(self) -> list[Item] | None:
        with self._tracer.start_as_current_span("test.cache_lookup") as span:
            span.set_attribute("db.system", "redis")
            cached = await self._client.get(CACHE_KEY)
        if cached is None:
            return None
        values = json.loads(cached)
        return [
            Item(
                id=value["id"],
                name=value["name"],
                created_at=datetime.fromisoformat(value["created_at"]),
            )
            for value in values
        ]

    async def set(self, items: list[Item], ttl_seconds: int) -> None:
        payload = json.dumps(
            [
                {
                    "id": item.id,
                    "name": item.name,
                    "created_at": item.created_at.isoformat(),
                }
                for item in items
            ],
            separators=(",", ":"),
        )
        await self._client.set(CACHE_KEY, payload, ex=ttl_seconds)

    async def invalidate(self) -> None:
        await self._client.delete(CACHE_KEY)


class RabbitMQEventPublisher:
    def __init__(
        self,
        channel: aio_pika.abc.AbstractChannel,
        queue_name: str,
        tracer: trace.Tracer,
    ):
        self._channel = channel
        self._queue_name = queue_name
        self._tracer = tracer

    async def publish(self, event: Event) -> None:
        payload = json.dumps(
            {"event_id": event.event_id, "name": event.name},
            separators=(",", ":"),
        ).encode()
        with self._tracer.start_as_current_span("test.rabbitmq_publish") as span:
            span.set_attribute("messaging.system", "rabbitmq")
            span.set_attribute("messaging.destination.name", self._queue_name)
            headers = {}
            propagate.inject(headers)
            await self._channel.default_exchange.publish(
                aio_pika.Message(
                    body=payload,
                    headers=headers,
                    delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                    content_type="application/json",
                ),
                routing_key=self._queue_name,
            )
