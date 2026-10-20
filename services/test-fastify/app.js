import { randomUUID } from "node:crypto";
import fastify from "fastify";
import { loadConfig } from "./src/config.js";
import { createUseCases } from "./src/application/use-cases.js";
import { createTracing, createStructuredLogger } from "./src/infrastructure/observability.js";
import { createMetrics } from "./src/infrastructure/metrics.js";
import {
  createPool,
  ensureSchema,
  PostgresItemsRepository,
  PostgresEventsRepository,
} from "./src/infrastructure/postgres.js";
import { createRedisClient, RedisItemsCache } from "./src/infrastructure/redis.js";
import { RabbitMQEventConsumer } from "./src/infrastructure/rabbitmq.js";
import { registerRoutes } from "./src/interfaces/http/routes.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Punto de composicion: unico lugar que conoce las implementaciones concretas.
async function main() {
  const config = loadConfig();
  const tracing = createTracing(config.serviceName);
  const log = createStructuredLogger(config.serviceName);
  const metrics = createMetrics(config.serviceName);

  const pool = createPool(config.databaseUrl);
  const cache = createRedisClient(config.redisUrl);

  const useCases = createUseCases({
    itemsRepository: new PostgresItemsRepository(pool, tracing, log),
    itemsCache: new RedisItemsCache(cache, tracing, config.itemsCacheKey),
    eventsRepository: new PostgresEventsRepository(pool, tracing, log),
    generateId: randomUUID,
    sleep,
  });

  const consumer = new RabbitMQEventConsumer({
    url: config.rabbitmqUrl,
    queue: config.rabbitmqQueue,
    tracing,
    log,
    onEvent: (event) => useCases.recordConsumedEvent(event),
  });

  const app = fastify();
  registerRoutes(app, {
    serviceName: config.serviceName,
    useCases,
    metrics,
    tracing,
    log,
    async checkReadiness() {
      await pool.query("SELECT 1");
      await cache.ping();
      if (!consumer.isConnected()) throw new Error("RabbitMQ consumer disconnected");
    },
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await consumer.stop();
    await app.close();
    await cache.quit();
    await pool.end();
  }
  process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
  process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));

  await ensureSchema(pool);
  await cache.connect();
  consumer.start();
  await app.listen({ host: "0.0.0.0", port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
