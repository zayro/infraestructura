const { trace } = require("@opentelemetry/api");
const { logs, SeverityNumber } = require("@opentelemetry/api-logs");
const client = require("prom-client");
const fastify = require("fastify")();

const SERVICE_NAME = process.env.SERVICE_NAME || "test-fastify-service";
const PORT = Number(process.env.SERVICE_PORT || 8084);

const tracer = trace.getTracer(SERVICE_NAME);
const otelLogger = logs.getLogger(SERVICE_NAME);

const REQUESTS = new client.Counter({
  name: "demo_http_requests_total",
  help: "Total de solicitudes HTTP del demo",
  labelNames: ["service", "route", "status"],
});
const DURATION = new client.Histogram({
  name: "demo_http_request_duration_seconds",
  help: "Duracion de solicitudes HTTP del demo",
  labelNames: ["service", "route"],
});

function currentTraceId() {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx ? ctx.traceId : null;
}

function structuredLog(event, fields = {}) {
  const payload = { event, ...fields };
  const ctx = trace.getActiveSpan()?.spanContext();
  if (ctx) {
    payload.trace_id = ctx.traceId;
    payload.span_id = ctx.spanId;
  }
  const body = JSON.stringify(payload);
  console.log(body);
  otelLogger.emit({ severityNumber: SeverityNumber.INFO, severityText: "INFO", body });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fastify.get("/api/node", async (request, reply) => {
  const end = DURATION.startTimer({ service: SERVICE_NAME, route: "/api/node" });
  let status = 200;

  const parsed = Number.parseInt(request.query.delay_ms ?? "100", 10);
  const delayMs = Number.isNaN(parsed) ? 100 : Math.max(0, Math.min(parsed, 2000));
  const forceFail = request.query.fail === "1";

  try {
    return await tracer.startActiveSpan("node.business_logic", async (span) => {
      try {
        span.setAttribute("demo.delay_ms", delayMs);
        await sleep(delayMs);

        if (forceFail) {
          status = 500;
          structuredLog("node_simulated_error");
          return reply.code(status).send({
            ok: false,
            service: SERVICE_NAME,
            trace_id: currentTraceId(),
            error: "Error simulado para validar observabilidad.",
          });
        }

        structuredLog("node_ok", { delay_ms: delayMs });
        return { ok: true, service: SERVICE_NAME, trace_id: currentTraceId(), message: "pong" };
      } finally {
        span.end();
      }
    });
  } finally {
    REQUESTS.inc({ service: SERVICE_NAME, route: "/api/node", status: String(status) });
    end();
  }
});

fastify.get("/metrics", async (_request, reply) => {
  reply.header("Content-Type", client.register.contentType);
  return client.register.metrics();
});

fastify.get("/health/live", async () => ({ status: "UP", service: SERVICE_NAME }));
fastify.get("/health/ready", async () => ({ status: "UP", service: SERVICE_NAME }));

fastify.listen({ host: "0.0.0.0", port: PORT }).catch((err) => {
  console.error(err);
  process.exit(1);
});
