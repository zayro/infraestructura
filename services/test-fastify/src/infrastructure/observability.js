const { trace } = require("@opentelemetry/api");
const { logs, SeverityNumber } = require("@opentelemetry/api-logs");

function createTracing(serviceName) {
  const tracer = trace.getTracer(serviceName);

  return {
    tracer,

    currentTraceId() {
      const ctx = trace.getActiveSpan()?.spanContext();
      return ctx ? ctx.traceId : null;
    },

    withSpan(name, attributes, fn) {
      return tracer.startActiveSpan(name, async (span) => {
        try {
          span.setAttributes(attributes);
          return await fn();
        } finally {
          span.end();
        }
      });
    },
  };
}

// Log JSON por consola y por OTLP, correlacionado con la traza activa.
function createStructuredLogger(serviceName) {
  const otelLogger = logs.getLogger(serviceName);

  return function structuredLog(event, fields = {}) {
    const payload = { event, ...fields };
    const ctx = trace.getActiveSpan()?.spanContext();
    if (ctx) {
      payload.trace_id = ctx.traceId;
      payload.span_id = ctx.spanId;
    }
    const body = JSON.stringify(payload);
    console.log(body);
    otelLogger.emit({ severityNumber: SeverityNumber.INFO, severityText: "INFO", body });
  };
}

function logError(event, err) {
  console.error(JSON.stringify({ event, error: err.message }));
}

module.exports = { createTracing, createStructuredLogger, logError };
