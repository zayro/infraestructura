const { createClient } = require("redis");
const { logError } = require("./observability");

function createRedisClient(url) {
  const client = createClient({ url });
  client.on("error", (err) => logError("redis_error", err));
  return client;
}

class RedisItemsCache {
  constructor(client, tracing, key) {
    this.client = client;
    this.tracing = tracing;
    this.key = key;
  }

  async get() {
    const cached = await this.tracing.withSpan("node.cache_lookup", { "db.system": "redis" }, () =>
      this.client.get(this.key)
    );
    if (!cached) return null;
    return JSON.parse(cached).map((item) => ({ ...item, createdAt: new Date(item.createdAt) }));
  }

  async set(items, ttlSeconds) {
    await this.client.set(this.key, JSON.stringify(items), { EX: ttlSeconds });
  }

  async invalidate() {
    await this.client.del(this.key);
  }
}

module.exports = { createRedisClient, RedisItemsCache };
