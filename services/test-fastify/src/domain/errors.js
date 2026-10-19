class EventNotFoundError extends Error {
  constructor(eventId) {
    super(`Evento ${eventId} no encontrado.`);
    this.name = "EventNotFoundError";
    this.eventId = eventId;
  }
}

module.exports = { EventNotFoundError };
