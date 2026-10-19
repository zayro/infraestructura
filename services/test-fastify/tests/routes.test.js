import test from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import { registerRoutes } from "../src/interfaces/http/routes.js";
import { createUseCases } from "../src/application/use-cases.js";

const ID = "11111111-1111-4111-8111-111111111111";

function buildApp({ checkReadiness = async () => {} } = {}) {
  const events = new Map();
  const recorded = [];
  const useCases = createUseCases({
    itemsRepository: {
      create: async () => ({ id: 1, name: "demo", createdAt: new Date("2026-01-01T00:00:00Z") }),
      listRecent: async () => [],
    },
    itemsCache: { get: async () => null, set: async () => {}, invalidate: async () => {} },
    eventsRepository: {
      create: async (event) => {
        const stored = { ...event, receivedAt: new Date("2026-01-01T00:00:00Z"), updatedAt: null };
        events.set(event.eventId, stored);
        return stored;
      },
      createIfAbsent: async () => {},
      get: async (id) => events.get(id) ?? null,
      listRecent: async () => [...events.values()],
      update: async (id, name) => (events.has(id) ? { ...events.get(id), name } : null),
      delete: async (id) => events.delete(id),
    },
    generateId: () => ID,
    sleep: async () => {},
  });

  const app = fastify();
  registerRoutes(app, {
    serviceName: "test-svc",
    useCases,
    metrics: {
      contentType: "text/plain",
      render: async () => "# metrics",
      track: (route) => (status) => recorded.push([route, status]),
    },
    tracing: { currentTraceId: () => "trace", withSpan: (_name, _attrs, fn) => fn() },
    log: () => {},
    checkReadiness,
  });
  return { app, recorded };
}

test("POST /api/node/events crea y responde 201 con el formato publico", async () => {
  const { app } = buildApp();
  const res = await app.inject({ method: "POST", url: "/api/node/events", payload: { name: "demo" } });

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json().event, {
    event_id: ID,
    name: "demo",
    received_at: "2026-01-01T00:00:00.000Z",
    updated_at: null,
  });
});

test("un evento inexistente responde 404 y se registra en metricas", async () => {
  const { app, recorded } = buildApp();
  const res = await app.inject({ method: "GET", url: `/api/node/events/${ID}` });

  assert.equal(res.statusCode, 404);
  assert.equal(res.json().ok, false);
  assert.deepEqual(recorded.at(-1), ["/api/node/events/:event_id", 404]);
});

test("PUT y DELETE del evento", async () => {
  const { app } = buildApp();
  await app.inject({ method: "POST", url: "/api/node/events", payload: { name: "demo" } });

  const put = await app.inject({ method: "PUT", url: `/api/node/events/${ID}`, payload: { name: "nuevo" } });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().event.name, "nuevo");

  const del = await app.inject({ method: "DELETE", url: `/api/node/events/${ID}` });
  assert.equal(del.statusCode, 204);
  const again = await app.inject({ method: "DELETE", url: `/api/node/events/${ID}` });
  assert.equal(again.statusCode, 404);
});

test("valida UUID y cuerpo con 400", async () => {
  const { app } = buildApp();

  assert.equal((await app.inject({ method: "GET", url: "/api/node/events/no-uuid" })).statusCode, 400);
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/node/events", payload: { name: "" } })).statusCode,
    400
  );
});

test("POST /api/node/items responde 201 con created_at", async () => {
  const { app } = buildApp();
  const res = await app.inject({ method: "POST", url: "/api/node/items", payload: { name: "demo" } });

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json(), { id: 1, name: "demo", created_at: "2026-01-01T00:00:00.000Z" });
});

test("GET /api/node responde pong y fail=1 responde 500", async () => {
  const { app, recorded } = buildApp();

  const ok = await app.inject({ method: "GET", url: "/api/node?delay_ms=0" });
  assert.equal(ok.json().message, "pong");

  const fail = await app.inject({ method: "GET", url: "/api/node?delay_ms=0&fail=1" });
  assert.equal(fail.statusCode, 500);
  assert.deepEqual(recorded.at(-1), ["/api/node", 500]);
});

test("/health/ready responde 503 si una dependencia falla", async () => {
  const healthy = buildApp();
  assert.equal((await healthy.app.inject({ url: "/health/ready" })).statusCode, 200);

  const broken = buildApp({
    checkReadiness: async () => {
      throw new Error("db down");
    },
  });
  const res = await broken.app.inject({ url: "/health/ready" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().status, "DOWN");
});
