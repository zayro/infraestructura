import { EventNotFoundError } from "../domain/errors.js";

export const CACHE_TTL_SECONDS = 30;
export const LIST_LIMIT = 20;

// Los puertos (repositorios, cache, generador de ids) se inyectan; este modulo no conoce frameworks ni drivers.
export function createUseCases({ itemsRepository, itemsCache, eventsRepository, generateId, sleep }) {
  return {
    simulate: (delayMs) => sleep(delayMs),

    async createItem(name) {
      const item = await itemsRepository.create(name);
      // El cache queda obsoleto tras escribir
      await itemsCache.invalidate();
      return item;
    },

    async listItems() {
      const cached = await itemsCache.get();
      if (cached) return { source: "cache", items: cached };

      const items = await itemsRepository.listRecent(LIST_LIMIT);
      await itemsCache.set(items, CACHE_TTL_SECONDS);
      return { source: "db", items };
    },

    createEvent: (name) => eventsRepository.create({ eventId: generateId(), name }),

    listEvents: () => eventsRepository.listRecent(LIST_LIMIT),

    async getEvent(eventId) {
      const event = await eventsRepository.get(eventId);
      if (!event) throw new EventNotFoundError(eventId);
      return event;
    },

    async updateEvent(eventId, name) {
      const event = await eventsRepository.update(eventId, name);
      if (!event) throw new EventNotFoundError(eventId);
      return event;
    },

    async deleteEvent(eventId) {
      if (!(await eventsRepository.delete(eventId))) throw new EventNotFoundError(eventId);
    },

    // Idempotente: reintentos del broker no duplican eventos
    recordConsumedEvent: (event) => eventsRepository.createIfAbsent(event),
  };
}
