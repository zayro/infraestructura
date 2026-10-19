function loadConfig(env = process.env) {
  return {
    serviceName: env.SERVICE_NAME || "test-fastify-service",
    port: Number(env.SERVICE_PORT || 8084),
    databaseUrl: env.DATABASE_URL || "postgresql://demo:demo@postgres:5432/demo",
    redisUrl: env.REDIS_URL || "redis://redis:6379/0",
    rabbitmqUrl: env.RABBITMQ_URL || "amqp://demo:demo@rabbitmq:5672/",
    rabbitmqQueue: env.RABBITMQ_QUEUE || "test.events",
    // Sufijo v2: el formato cacheado cambio respecto a versiones anteriores
    itemsCacheKey: "node:items:v2",
  };
}

module.exports = { loadConfig };
