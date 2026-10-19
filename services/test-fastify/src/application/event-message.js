const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX_LENGTH = 100;

// Valida el cuerpo de un mensaje publicado por otros servicios; lanza Error si es invalido.
export function parseEventMessage(raw) {
  const event = JSON.parse(raw);
  if (
    !event ||
    typeof event.event_id !== "string" ||
    !UUID_PATTERN.test(event.event_id) ||
    typeof event.name !== "string" ||
    event.name.length < 1 ||
    event.name.length > NAME_MAX_LENGTH
  ) {
    throw new Error("Invalid event payload");
  }
  return { eventId: event.event_id, name: event.name };
}
