import { context, propagation, SpanKind } from "@opentelemetry/api";
import amqp from "amqplib";
import { parseEventMessage } from "../application/event-message.js";
import { logError } from "./observability.js";

const RECONNECT_DELAY_MS = 5000;
const PREFETCH = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Consume la cola con ack manual: confirma tras procesar, reencola ante fallos transitorios
// y descarta (sin reencolar) los mensajes invalidos.
export class RabbitMQEventConsumer {
  constructor({ url, queue, tracing, log, onEvent }) {
    this.url = url;
    this.queue = queue;
    this.tracing = tracing;
    this.log = log;
    this.onEvent = onEvent;
    this.connection = undefined;
    this.channel = undefined;
    this.stopping = false;
  }

  isConnected() {
    return Boolean(this.channel);
  }

  start() {
    void this.#run();
  }

  async stop() {
    this.stopping = true;
    if (this.connection) await this.connection.close().catch(() => {});
  }

  async #run() {
    while (!this.stopping) {
      try {
        this.connection = await amqp.connect(this.url);
        this.connection.on("error", (err) => logError("rabbitmq_error", err));
        const channel = await this.connection.createChannel();
        await channel.assertQueue(this.queue, { durable: true });
        await channel.prefetch(PREFETCH);
        await channel.consume(this.queue, (message) => this.#handle(channel, message));
        this.channel = channel;
        await new Promise((resolve) => this.connection.once("close", resolve));
      } catch (err) {
        if (!this.stopping) {
          logError("rabbitmq_connection_failed", err);
          await sleep(RECONNECT_DELAY_MS);
        }
      } finally {
        this.channel = undefined;
        this.connection = undefined;
      }
    }
  }

  async #handle(channel, message) {
    if (!message) return;

    let event;
    try {
      event = parseEventMessage(message.content.toString());
    } catch (err) {
      logError("rabbitmq_invalid_message", err);
      channel.nack(message, false, false);
      return;
    }

    const parentContext = propagation.extract(context.active(), message.properties.headers || {});
    try {
      await this.tracing.tracer.startActiveSpan(
        "node.consume.test_event",
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            "messaging.system": "rabbitmq",
            "messaging.destination.name": this.queue,
            "messaging.operation.type": "process",
          },
        },
        parentContext,
        async (span) => {
          try {
            await this.onEvent(event);
            this.log("event_consumed", { event_id: event.eventId });
          } finally {
            span.end();
          }
        }
      );
      channel.ack(message);
    } catch (err) {
      logError("rabbitmq_consume_failed", err);
      channel.nack(message, false, true);
    }
  }
}
