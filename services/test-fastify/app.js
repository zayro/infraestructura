const { context, propagation, SpanKind, trace } = require("@opentelemetry/api");
const { logs, SeverityNumber } = require("@opentelemetry/api-logs");
const amqp = require("amqplib");
const client = require("prom-client");
const { Pool } = require("pg");
const { createClient } = require("redis");
const fastify = require("fastify")();

const SERVICE_NAME = process.env.SERVICE_NAME || "test-fastify-service";
const PORT = Number(process.env.SERVICE_PORT || 8084);
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://demo:demo@postgres:5432/demo";
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379/0";
const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://demo:demo@rabbitmq:5672/";
const RABBITMQ_QUEUE = process.env.RABBITMQ_QUEUE || "test.events";
const CACHE_KEY = "node:items";
const CACHE_TTL_SECONDS = 30;

const pool = new Pool({ connectionString: DATABASE_URL });
pool.on("error", (err) => console.error(JSON.stringify({ event: "pg_pool_error", error: err.message })));
const cache = createClient({ url: REDIS_URL });
cache.on("error", (err) => console.error(JSON.stringify({ event: "redis_error", error: err.message })));
let rabbitConnection;
let rabbitChannel;
let stopping = false;

const tracer = trace.getTracer(SERVICE_NAME);
const otelLogger = logs.getLogger(SERVICE_NAME);

const REQUESTS = new client.Counter({
  name: "demo_http_requests_total",
  help: "Total de solicitudes HTTP del demo",
  labelNames: ["service", "route", "status"],
});
const DURATION = new client.Histogram({
  name: "demo_http_request_duration_seconds",
  help: "Duracion de solicitudes HTTP del demo",
  labelNames: ["service", "route"],
});

function currentTraceId() {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx ? ctx.traceId : null;
}

function structuredLog(event, fields = {}) {
  const payload = { event, ...fields };
  const ctx = trace.getActiveSpan()?.spanContext();
  if (ctx) {
    payload.trace_id = ctx.traceId;
    payload.span_id = ctx.spanId;
  }
  const body = JSON.stringify(payload);
  console.log(body);
  otelLogger.emit({ severityNumber: SeverityNumber.INFO, severityText: "INFO", body });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fastify.get("/api/node", async (request, reply) => {
  const end = DURATION.startTimer({ service: SERVICE_NAME, route: "/api/node" });
  let status = 200;

  const parsed = Number.parseInt(request.query.delay_ms ?? "100", 10);
  const delayMs = Number.isNaN(parsed) ? 100 : Math.max(0, Math.min(parsed, 2000));
  const forceFail = request.query.fail === "1";

  try {
    return await tracer.startActiveSpan("node.business_logic", async (span) => {
      try {
        span.setAttribute("demo.delay_ms", delayMs);
        await sleep(delayMs);

        if (forceFail) {
          status = 500;
          structuredLog("node_simulated_error");
          return reply.code(status).send({
            ok: false,
            service: SERVICE_NAME,
            trace_id: currentTraceId(),
            error: "Error simulado para validar observabilidad.",
          });
        }

        structuredLog("node_ok", { delay_ms: delayMs });
        return { ok: true, service: SERVICE_NAME, trace_id: currentTraceId(), message: "pong" };
      } finally {
        span.end();
      }
    });
  } finally {
    REQUESTS.inc({ service: SERVICE_NAME, route: "/api/node", status: String(status) });
    end();
  }
});

function withSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      span.setAttributes(attributes);
      return await fn();
    } finally {
      span.end();
    }
  });
}

function track(route) {
  const end = DURATION.startTimer({ service: SERVICE_NAME, route });
  return (status) => {
    REQUESTS.inc({ service: SERVICE_NAME, route, status: String(status) });
    end();
  };
}

fastify.post(
  "/api/node/items",
  {
    schema: {
      body: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
      },
    },
  },
  async (request, reply) => {
    const done = track("/api/node/items");
    let status = 500;
    try {
      const { rows } = await withSpan("node.db_insert", { "db.system": "postgresql" }, () =>
        pool.query("INSERT INTO node_items (name) VALUES ($1) RETURNING id, name, created_at", [request.body.name])
      );
      // El cache queda obsoleto tras escribir
      await cache.del(CACHE_KEY);
      structuredLog("item_created", { item_id: rows[0].id });
      status = 201;
      return reply.code(status).send(rows[0]);
    } finally {
      done(status);
    }
  }
);

fastify.get("/api/node/items", async () => {
  const done = track("/api/node/items");
  let status = 500;
  try {
    const cached = await withSpan("node.cache_lookup", { "db.system": "redis" }, () => cache.get(CACHE_KEY));
    if (cached) {
      structuredLog("items_cache_hit");
      status = 200;
      return { ok: true, source: "cache", items: JSON.parse(cached) };
    }

    const { rows } = await withSpan("node.db_select", { "db.system": "postgresql" }, () =>
      pool.query("SELECT id, name, created_at FROM node_items ORDER BY id DESC LIMIT 20")
    );
    await cache.set(CACHE_KEY, JSON.stringify(rows), { EX: CACHE_TTL_SECONDS });
    structuredLog("items_cache_miss", { count: rows.length });
    status = 200;
    return { ok: true, source: "db", items: rows };
  } finally {
    done(status);
  }
});

fastify.get("/api/node/events", async () => {
  const { rows } = await pool.query(
    "SELECT event_id, name, received_at FROM node_events ORDER BY received_at DESC LIMIT 20"
  );
  return { ok: true, events: rows };
});

fastify.get("/metrics", async (_request, reply) => {
  reply.header("Content-Type", client.register.contentType);
  return client.register.metrics();
});

fastify.get("/health/live", async () => ({ status: "UP", service: SERVICE_NAME }));
fastify.get("/health/ready", async () => ({ status: "UP", service: SERVICE_NAME }));

async function consumeEvents() {
  while (!stopping) {
    try {
      rabbitConnection = await amqp.connect(RABBITMQ_URL);
      rabbitConnection.on("error", (err) =>
        console.error(JSON.stringify({ event: "rabbitmq_error", error: err.message }))
      );
      rabbitChannel = await rabbitConnection.createChannel();
      await rabbitChannel.assertQueue(RABBITMQ_QUEUE, { durable: true });
      await rabbitChannel.prefetch(10);
      await rabbitChannel.consume(RABBITMQ_QUEUE, async (message) => {
        if (!message) return;

        let event;
        try {
          event = JSON.parse(message.content.toString());
          if (
            typeof event.event_id !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.event_id) ||
            typeof event.name !== "string" ||
            event.name.length < 1 ||
            event.name.length > 100
          ) {
            throw new Error("Invalid event payload");
          }
        } catch (err) {
          console.error(JSON.stringify({ event: "rabbitmq_invalid_message", error: err.message }));
          rabbitChannel.nack(message, false, false);
          return;
        }

        const parentContext = propagation.extract(context.active(), message.properties.headers || {});
        try {
          await tracer.startActiveSpan(
            "node.consume.test_event",
            {
              kind: SpanKind.CONSUMER,
              attributes: {
                "messaging.system": "rabbitmq",
                "messaging.destination.name": RABBITMQ_QUEUE,
                "messaging.operation.type": "process",
              },
            },
            parentContext,
            async (span) => {
              try {
                await pool.query(
                  "INSERT INTO node_events (event_id, name) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING",
                  [event.event_id, event.name]
                );
                structuredLog("event_consumed", { event_id: event.event_id });
              } finally {
                span.end();
              }
            }
          );
          rabbitChannel.ack(message);
        } catch (err) {
          console.error(JSON.stringify({ event: "rabbitmq_consume_failed", error: err.message }));
          rabbitChannel.nack(message, false, true);
        }
      });
      await new Promise((resolve) => rabbitConnection.once("close", resolve));
    } catch (err) {
      if (!stopping) {
        console.error(JSON.stringify({ event: "rabbitmq_connection_failed", error: err.message }));
        await sleep(5000);
      }
    } finally {
      rabbitChannel = undefined;
      rabbitConnection = undefined;
    }
  }
}

async function main() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS node_items (" +
      "id SERIAL PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  );
  await pool.query(
    "CREATE TABLE IF NOT EXISTS node_events (" +
      "event_id UUID PRIMARY KEY, name TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  );
  await cache.connect();
  void consumeEvents();
  await fastify.listen({ host: "0.0.0.0", port: PORT });
}

async function shutdown() {
  stopping = true;
  if (rabbitConnection) await rabbitConnection.close();
  await fastify.close();
  await cache.quit();
  await pool.end();
}

process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
