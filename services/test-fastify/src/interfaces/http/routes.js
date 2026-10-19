import { EventNotFoundError } from "../../domain/errors.js";

const MAX_DELAY_MS = 2000;
const DEFAULT_DELAY_MS = 100;

const nameBody = {
  type: "object",
  required: ["name"],
  properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
};
const eventBody = { ...nameBody, additionalProperties: false };
const eventParams = {
  type: "object",
  required: ["event_id"],
  properties: { event_id: { type: "string", format: "uuid" } },
};

const serializeItem = (item) => ({ id: item.id, name: item.name, created_at: item.createdAt });
const serializeEvent = (event) => ({
  event_id: event.eventId,
  name: event.name,
  received_at: event.receivedAt,
  updated_at: event.updatedAt,
});

export function toHttpStatus(err) {
  if (err instanceof EventNotFoundError) return 404;
  return err.statusCode || 500;
}

function parseDelay(value) {
  const parsed = Number.parseInt(value ?? String(DEFAULT_DELAY_MS), 10);
  return Number.isNaN(parsed) ? DEFAULT_DELAY_MS : Math.max(0, Math.min(parsed, MAX_DELAY_MS));
}

export function registerRoutes(app, { serviceName, useCases, metrics, tracing, log, checkReadiness }) {
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof EventNotFoundError) {
      return reply.code(404).send({ ok: false, error: err.message });
    }
    return reply.send(err);
  });

  // Registra metricas con el status real, incluidos los errores mapeados por toHttpStatus.
  const tracked = (route, handler) => async (request, reply) => {
    const done = metrics.track(route);
    try {
      const result = await handler(request, reply);
      done(reply.statusCode);
      return result;
    } catch (err) {
      done(toHttpStatus(err));
      throw err;
    }
  };

  app.get(
    "/api/node",
    tracked("/api/node", (request, reply) => {
      const delayMs = parseDelay(request.query.delay_ms);
      const forceFail = request.query.fail === "1";

      return tracing.withSpan("node.business_logic", { "demo.delay_ms": delayMs }, async () => {
        await useCases.simulate(delayMs);

        if (forceFail) {
          log("node_simulated_error");
          return reply.code(500).send({
            ok: false,
            service: serviceName,
            trace_id: tracing.currentTraceId(),
            error: "Error simulado para validar observabilidad.",
          });
        }

        log("node_ok", { delay_ms: delayMs });
        return { ok: true, service: serviceName, trace_id: tracing.currentTraceId(), message: "pong" };
      });
    })
  );

  app.post(
    "/api/node/items",
    { schema: { body: nameBody } },
    tracked("/api/node/items", async (request, reply) => {
      const item = await useCases.createItem(request.body.name);
      log("item_created", { item_id: item.id });
      return reply.code(201).send(serializeItem(item));
    })
  );

  app.get(
    "/api/node/items",
    tracked("/api/node/items", async () => {
      const { source, items } = await useCases.listItems();
      if (source === "cache") log("items_cache_hit");
      else log("items_cache_miss", { count: items.length });
      return { ok: true, source, items: items.map(serializeItem) };
    })
  );

  app.post(
    "/api/node/events",
    { schema: { body: eventBody } },
    tracked("/api/node/events", async (request, reply) => {
      const event = await useCases.createEvent(request.body.name);
      log("event_created", { event_id: event.eventId });
      return reply.code(201).send({ ok: true, event: serializeEvent(event) });
    })
  );

  app.get(
    "/api/node/events",
    tracked("/api/node/events", async () => {
      const events = await useCases.listEvents();
      return { ok: true, events: events.map(serializeEvent) };
    })
  );

  const eventRoute = "/api/node/events/:event_id";

  app.get(
    eventRoute,
    { schema: { params: eventParams } },
    tracked(eventRoute, async (request) => {
      const event = await useCases.getEvent(request.params.event_id);
      return { ok: true, event: serializeEvent(event) };
    })
  );

  app.put(
    eventRoute,
    { schema: { params: eventParams, body: eventBody } },
    tracked(eventRoute, async (request) => {
      const { event_id: eventId } = request.params;
      const event = await useCases.updateEvent(eventId, request.body.name);
      log("event_updated", { event_id: eventId });
      return { ok: true, event: serializeEvent(event) };
    })
  );

  app.delete(
    eventRoute,
    { schema: { params: eventParams } },
    tracked(eventRoute, async (request, reply) => {
      const { event_id: eventId } = request.params;
      await useCases.deleteEvent(eventId);
      log("event_deleted", { event_id: eventId });
      return reply.code(204).send();
    })
  );

  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", metrics.contentType);
    return metrics.render();
  });

  app.get("/health/live", async () => ({ status: "UP", service: serviceName }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      await checkReadiness();
      return { status: "UP", service: serviceName };
    } catch (err) {
      log("readiness_check_failed", { error: err.message });
      return reply.code(503).send({ status: "DOWN", service: serviceName });
    }
  });
}
