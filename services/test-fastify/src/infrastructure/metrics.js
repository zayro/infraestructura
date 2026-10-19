const client = require("prom-client");

function createMetrics(serviceName) {
  const requests = new client.Counter({
    name: "demo_http_requests_total",
    help: "Total de solicitudes HTTP del demo",
    labelNames: ["service", "route", "status"],
  });
  const duration = new client.Histogram({
    name: "demo_http_request_duration_seconds",
    help: "Duracion de solicitudes HTTP del demo",
    labelNames: ["service", "route"],
  });

  return {
    track(route) {
      const end = duration.startTimer({ service: serviceName, route });
      return (status) => {
        requests.inc({ service: serviceName, route, status: String(status) });
        end();
      };
    },
    contentType: client.register.contentType,
    render: () => client.register.metrics(),
  };
}

module.exports = { createMetrics };
