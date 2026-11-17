// Ejecutar desde la raiz: node scripts/verify_kafka.cjs
// Usa los secretos locales sin imprimir tokens ni credenciales.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const env = {};
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}
Object.assign(env, process.env);
const base = env.API_BASE_URL || 'http://localhost:8000';
const prometheus = env.PROMETHEUS_URL || 'http://localhost:9090';
const tempo = env.TEMPO_URL || 'http://localhost:3200';
const loki = env.LOKI_URL || 'http://localhost:3100';
const grafana = env.GRAFANA_URL || 'http://localhost:3000';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({
    iss: env.JWT_ISSUER || 'app-traefik', sub: 'kafka-smoke', roles: ['service'], iat: now, exp: now + 300,
  })}`;
  const signature = crypto.createHmac('sha256', env.JWT_SECRET || 'super-secret-jwt-token-key-32-chars-long').update(body).digest('base64url');
  return `${body}.${signature}`;
}
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  const body = await response.text();
  assert(response.ok, `${url}: HTTP ${response.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}
async function eventually(description, fn) {
  let error;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { const result = await fn(); console.log(`OK ${description}`); return result; }
    catch (err) { error = err; await sleep(1000); }
  }
  throw new Error(`${description}: ${error.message}`);
}
async function main() {
  const headers = { Authorization: `Bearer ${jwt()}`, 'Content-Type': 'application/json' };
  const published = await json(`${base}/api/test/events`, {
    method: 'POST', headers, body: JSON.stringify({ name: `kafka-smoke-${Date.now()}` }),
  });
  assert(published.event_id, 'La API debe devolver event_id');
  console.log(`OK publicacion Kafka: ${published.event_id}`);
  await eventually('persistencia Fastify por event_id', async () => {
    const event = await json(`${base}/api/node/events/${published.event_id}`, { headers });
    assert(JSON.stringify(event).includes(published.event_id));
  });
  await eventually('metricas Kafka en Prometheus', async () => {
    const response = await json(`${prometheus}/api/v1/query?query=${encodeURIComponent('kafka_brokers')}`);
    assert(response.data.result.some(series => Number(series.value[1]) >= 1));
  });
  await eventually('metricas de consumo en Prometheus', async () => {
    const response = await json(`${prometheus}/api/v1/query?query=${encodeURIComponent('app_messaging_processed_total{outcome="success"}')}`);
    assert(response.data.result.some(series => Number(series.value[1]) >= 1));
  });
  let traceId;
  await eventually('logs de consumo correlacionados en Loki', async () => {
    const query = `{service_name="test-fastify-service"} |= "${published.event_id}"`;
    const response = await json(`${loki}/loki/api/v1/query_range?query=${encodeURIComponent(query)}&since=10m&limit=20`);
    const lines = response.data.result.flatMap(series => series.values.map(([, line]) => line));
    const record = lines.map(line => { try { return JSON.parse(line); } catch { return {}; } }).find(record => record.event === 'event_consumed' && record.trace_id);
    assert(record, 'Falta log event_consumed con trace_id');
    traceId = record.trace_id;
  });
  await eventually('traza productor y consumidor en Tempo', async () => {
    const response = await json(`${tempo}/api/traces/${traceId}`, { headers: { Accept: 'application/json' } });
    const batches = response.batches || response.resourceSpans || [];
    const spans = batches.flatMap(batch => (batch.scopeSpans || batch.instrumentationLibrarySpans || []).flatMap(scope => scope.spans || []));
    const producer = spans.find(span => span.name === 'test.kafka_publish');
    const consumer = spans.find(span => span.name === 'node.consume.test_event');
    assert(producer && consumer, 'Faltan spans Kafka en la misma traza');
    assert.equal(consumer.parentSpanId, producer.spanId);
  });
  const health = await json(`${grafana}/api/health`);
  assert.equal(health.database, 'ok');
  console.log('OK Grafana disponible');
  if (env.GRAFANA_API_TOKEN) {
    const dashboard = await json(`${grafana}/api/dashboards/uid/app-kafka`, { headers: {
      Authorization: `Bearer ${env.GRAFANA_API_TOKEN}`,
    } });
    assert.equal(dashboard.dashboard.panels.length, 8);
    console.log('OK dashboard Kafka provisionado en Grafana');
  }
  console.log(JSON.stringify({ event_id: published.event_id, trace_id: traceId }));
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
