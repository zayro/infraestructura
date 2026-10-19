# Prometheus

`prometheus.yml` indica a Prometheus que recoja metricas cada cinco segundos y evalua reglas con la misma frecuencia. No se definen reglas de alerta ni de grabacion en este archivo.

## Objetivos configurados

| Trabajo (`job_name`) | Destino interno | Informacion recogida |
|---|---|---|
| `traefik` | `traefik:8082/metrics` | Trafico de entrada, estados HTTP y latencia del proxy. |
| `student-service` | `student-service:8081/metrics` | Metricas de la aplicacion Flask. |
| `test-fastapi-service` | `test-fastapi-service:8083/metrics` | Metricas de la aplicacion FastAPI. |
| `test-fastify-service` | `test-fastify-service:8084/metrics` | Metricas de la aplicacion Fastify. |
| `cadvisor` | `cadvisor:8080/metrics` | CPU, memoria y uso de los contenedores Docker. |

Todos los destinos son servicios de Docker Compose dentro de `demo-observability-net`. Prometheus publica `http://localhost:9090` y almacena datos en `prometheus-data`. Compose limita la retencion a tres dias mediante `--storage.tsdb.retention.time=3d`.

## Que no hace

Esta configuracion no descubre contenedores dinamicamente, no raspa el Collector y no declara alertas. Para incorporar un servicio, agregue un `scrape_config` que apunte a su endpoint `/metrics` y reinicie Prometheus.

## Comprobacion y consultas

Abra `http://localhost:9090/targets`: todos los trabajos deben aparecer como `UP`.

```promql
sum by (service) (rate(demo_http_requests_total[1m]))

histogram_quantile(
  0.95,
  sum by (le, service) (rate(demo_http_request_duration_seconds_bucket[5m]))
)
```

La fuente de datos se aprovisiona en Grafana; vea [`../grafana/README.md`](../grafana/README.md).
