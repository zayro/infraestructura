import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";

const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4318").replace(/\/$/, "");

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    "service.name": process.env.SERVICE_NAME || "test-fastify-service",
    "service.namespace": "demo-etapa1",
    "deployment.environment.name": process.env.DEPLOYMENT_ENVIRONMENT || "development",
  }),
  traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }) })],
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => /^\/(metrics|health)/.test(req.url || ""),
    }),
  ],
});

sdk.start();

process.on("SIGTERM", () => sdk.shutdown().finally(() => process.exit(0)));
