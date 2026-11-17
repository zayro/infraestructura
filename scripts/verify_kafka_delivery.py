"""Prueba real de duplicados y DLQ. Ejecutar dentro del contenedor FastAPI.

docker compose cp scripts/verify_kafka_delivery.py test-fastapi-service:/tmp/verify_kafka_delivery.py
docker compose exec -T test-fastapi-service python /tmp/verify_kafka_delivery.py
"""
import asyncio
import json
import os
import uuid

import psycopg
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer, TopicPartition
from aiokafka.admin import AIOKafkaAdminClient


async def main():
    brokers = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092").split(",")
    topic = os.getenv("KAFKA_TOPIC", "test.events")
    dlq_topic = os.getenv("KAFKA_DLQ_TOPIC", "test.events.dlq")
    event_id = str(uuid.uuid4())
    invalid = f"invalid-kafka-smoke-{uuid.uuid4()}".encode()
    producer = AIOKafkaProducer(bootstrap_servers=brokers, enable_idempotence=True)
    consumer = AIOKafkaConsumer(bootstrap_servers=brokers, group_id=None, enable_auto_commit=False)
    admin = AIOKafkaAdminClient(bootstrap_servers=brokers)
    try:
        await producer.start()
        await consumer.start()
        await admin.start()
        partitions = consumer.partitions_for_topic(dlq_topic)
        assert partitions, "La DLQ debe existir"
        consumer.assign([TopicPartition(dlq_topic, partition) for partition in partitions])
        await consumer.seek_to_end()
        payload = json.dumps({"event_id": event_id, "name": "duplicate-kafka-smoke"}).encode()
        for _ in range(2):
            duplicate_record = await producer.send_and_wait(topic, value=payload, key=event_id.encode())
        invalid_record = await producer.send_and_wait(topic, value=invalid)
        found = False
        for _ in range(20):
            batches = await consumer.getmany(timeout_ms=1000)
            for messages in batches.values():
                for message in messages:
                    if message.value == invalid:
                        headers = dict(message.headers)
                        assert headers["source-topic"].decode() == topic
                        assert headers["source-offset"].decode() == str(invalid_record.offset)
                        found = True
            if found:
                break
        assert found, "El mensaje invalido debe conservarse en la DLQ"
        print("OK mensaje invalido conservado en DLQ con metadatos de origen")
        required_offsets = {}
        for record in [duplicate_record, invalid_record]:
            partition = TopicPartition(topic, record.partition)
            required_offsets[partition] = max(required_offsets.get(partition, 0), record.offset + 1)
        for _ in range(20):
            offsets = await admin.list_consumer_group_offsets(os.getenv("KAFKA_CONSUMER_GROUP", "test-fastify-service"))
            committed = all(partition in offsets and offsets[partition].offset >= offset for partition, offset in required_offsets.items())
            if committed:
                break
            await asyncio.sleep(1)
        assert committed, "El consumidor debe confirmar ambos duplicados y el mensaje invalido"
        print("OK offsets confirmados despues de procesar duplicados y DLQ")
        async with await psycopg.AsyncConnection.connect(os.environ["DATABASE_URL"]) as conn:
            for _ in range(20):
                async with conn.cursor() as cursor:
                    await cursor.execute("SELECT COUNT(*) FROM node_events WHERE event_id = %s", (event_id,))
                    count = (await cursor.fetchone())[0]
                if count:
                    break
                await asyncio.sleep(1)
            assert count == 1, f"Se esperaba una sola fila, se encontraron {count}"
        print("OK evento repetido conserva una sola fila PostgreSQL")
    finally:
        try:
            await consumer.stop()
        finally:
            await producer.stop()
            await admin.close()


if __name__ == "__main__":
    asyncio.run(asyncio.wait_for(main(), timeout=50))
