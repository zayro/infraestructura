const test = require("node:test");
const assert = require("node:assert/strict");
const { createUseCases } = require("../src/application/use-cases");
const { parseEventMessage } = require("../src/application/event-message");
const { EventNotFoundError } = require("../src/domain/errors");

function fakes() {
  const events = new Map();
  const state = { cache: null, cacheSet: null, invalidated: false, itemsRequested: 0, delay: null };
  const item = { id: 1, name: "demo", createdAt: new Date("2026-01-01T00:00:00Z") };

  const itemsRepository = {
    create: async () => item,
    listRecent: async () => {
      state.itemsRequested += 1;
      return [item];
    },
  };
  const itemsCache = {
    get: async () => state.cache,
    set: async (items, ttl) => {
      state.cacheSet = { items, ttl };
    },
    invalidate: async () => {
      state.invalidated = true;
    },
  };
  const eventsRepository = {
    create: async (event) => {
      const stored = { ...event, receivedAt: new Date(), updatedAt: null };
      events.set(event.eventId, stored);
      return stored;
    },
    createIfAbsent: async (event) => {
      if (!events.has(event.eventId)) events.set(event.eventId, { ...event });
    },
    get: async (id) => events.get(id) ?? null,
    listRecent: async () => [...events.values()],
    update: async (id, name) => {
      if (!events.has(id)) return null;
      events.set(id, { ...events.get(id), name });
      return events.get(id);
    },
    delete: async (id) => events.delete(id),
  };

  const useCases = createUseCases({
    itemsRepository,
    itemsCache,
    eventsRepository,
    generateId: () => "11111111-1111-4111-8111-111111111111",
    sleep: async (ms) => {
      state.delay = ms;
    },
  });
  return { useCases, state, item, events };
}

test("listItems lee de la base y puebla el cache", async () => {
  const { useCases, state, item } = fakes();
  const result = await useCases.listItems();

  assert.equal(result.source, "db");
  assert.deepEqual(result.items, [item]);
  assert.deepEqual(state.cacheSet, { items: [item], ttl: 30 });
});

test("listItems usa el cache sin consultar la base", async () => {
  const { useCases, state, item } = fakes();
  state.cache = [item];
  const result = await useCases.listItems();

  assert.equal(result.source, "cache");
  assert.equal(state.itemsRequested, 0);
});

test("createItem invalida el cache", async () => {
  const { useCases, state, item } = fakes();

  assert.deepEqual(await useCases.createItem("demo"), item);
  assert.equal(state.invalidated, true);
});

test("simulate delega la espera", async () => {
  const { useCases, state } = fakes();
  await useCases.simulate(250);

  assert.equal(state.delay, 250);
});

test("CRUD de eventos", async () => {
  const { useCases } = fakes();
  const created = await useCases.createEvent("demo");
  assert.equal(created.eventId, "11111111-1111-4111-8111-111111111111");

  assert.equal((await useCases.getEvent(created.eventId)).name, "demo");
  assert.equal((await useCases.listEvents()).length, 1);
  assert.equal((await useCases.updateEvent(created.eventId, "nuevo")).name, "nuevo");

  await useCases.deleteEvent(created.eventId);
  await assert.rejects(useCases.getEvent(created.eventId), EventNotFoundError);
});

test("update y delete de un evento inexistente lanzan EventNotFoundError", async () => {
  const { useCases } = fakes();

  await assert.rejects(useCases.updateEvent("x", "y"), EventNotFoundError);
  await assert.rejects(useCases.deleteEvent("x"), EventNotFoundError);
});

test("recordConsumedEvent es idempotente", async () => {
  const { useCases, events } = fakes();
  const event = { eventId: "22222222-2222-4222-8222-222222222222", name: "a" };

  await useCases.recordConsumedEvent(event);
  await useCases.recordConsumedEvent({ ...event, name: "b" });

  assert.equal(events.size, 1);
  assert.equal(events.get(event.eventId).name, "a");
});

test("parseEventMessage acepta un mensaje valido", () => {
  const raw = JSON.stringify({ event_id: "22222222-2222-4222-8222-222222222222", name: "demo" });

  assert.deepEqual(parseEventMessage(raw), { eventId: "22222222-2222-4222-8222-222222222222", name: "demo" });
});

test("parseEventMessage rechaza mensajes invalidos", () => {
  const uuid = "22222222-2222-4222-8222-222222222222";
  const invalid = [
    "no es json",
    "null",
    JSON.stringify({ event_id: "no-uuid", name: "demo" }),
    JSON.stringify({ event_id: uuid, name: "" }),
    JSON.stringify({ event_id: uuid, name: "x".repeat(101) }),
    JSON.stringify({ event_id: uuid }),
  ];

  for (const raw of invalid) assert.throws(() => parseEventMessage(raw), raw);
});
