-- Se ejecuta solo la primera vez que se inicializa el volumen postgres-data.
-- Mismo esquema que crean los servicios test-fastapi y test-fastify (idempotente).

CREATE TABLE IF NOT EXISTS test_items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS node_items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS node_events (
    event_id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO test_items (name) VALUES
    ('seed-fastapi-1'),
    ('seed-fastapi-2'),
    ('seed-fastapi-3');

INSERT INTO node_items (name) VALUES
    ('seed-fastify-1'),
    ('seed-fastify-2'),
    ('seed-fastify-3');
