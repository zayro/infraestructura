import { trace, SpanStatusCode } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

export function createTracing(serviceName) {
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
        } catch (err) {
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
          throw err;
        } finally {
          span.end();
        }
      });
    },
  };
}

// Log JSON por consola y por OTLP, correlacionado con la traza activa.
export function createStructuredLogger(serviceName) {
  const otelLogger = logs.getLogger(serviceName);

  return function structuredLog(event, fields = {}, level = "INFO") {
    const payload = { event, ...fields };
    const ctx = trace.getActiveSpan()?.spanContext();
    if (ctx) {
      payload.trace_id = ctx.traceId;
      payload.span_id = ctx.spanId;
    }
    const body = JSON.stringify(payload);
    (level === "ERROR" ? console.error : console.log)(body);
    otelLogger.emit({ severityNumber: SeverityNumber[level], severityText: level, body });
  };
}

export function logError(event, err) {
  console.error(JSON.stringify({ event, error: err.message }));
}
