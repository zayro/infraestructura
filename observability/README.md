# Configuracion de observabilidad

Esta carpeta define el recorrido de metricas, logs y trazas del entorno de appstracion. Los servicios exponen `/metrics` y envian datos OTLP al Collector; cada backend queda desacoplado de la aplicacion.

```text
Servicios -- /metrics --> Prometheus ---------------------\\
Servicios -- OTLP --> OpenTelemetry Collector -- trazas --> Tempo --\\
                                           `-- logs -----> Loki ---+--> Grafana
Traefik y cAdvisor -- /metrics --> Prometheus ---------------------/
```

## Archivos y responsabilidades

| Archivo | Componente | Que configura |
|---|---|---|
| `otel-collector-config.yaml` | OpenTelemetry Collector | Receptores OTLP, proteccion de memoria, agrupamiento y exportacion de logs y trazas. |
| `prometheus/prometheus.yml` | Prometheus | Frecuencia de scrape y objetivos internos de metricas. |
| `loki/loki-config.yaml` | Loki | API de logs, almacenamiento local y esquema de indices. |
| `tempo/tempo.yaml` | Tempo | Recepcion OTLP de trazas, API de consultas y almacenamiento local. |
| `grafana/provisioning/datasources/datasources.yaml` | Grafana | Fuentes Prometheus, Loki y Tempo, con enlaces entre senales. |
| `grafana/provisioning/dashboards/dashboards.yaml` | Grafana | Carga automatica de dashboards JSON. |

Los Dockerfiles de esta carpeta copian cada YAML a la ruta que espera su imagen base. Los servicios, puertos publicados y volumenes se declaran en [`../docker-compose.yml`](../docker-compose.yml).

## OpenTelemetry Collector

`otel-collector-config.yaml` escucha OTLP/gRPC en `4317` y OTLP/HTTP en `4318`. Sus dos pipelines reciben `otlp`, aplican `memory_limiter` (256 MiB, picos de 64 MiB) y `batch` (un segundo). Las trazas se exportan a `tempo:4317`; los logs a `http://loki:3100/otlp`. El exportador `debug` deja un resumen de trazas en los logs del Collector.

El Collector no procesa metricas: Prometheus las obtiene directamente de los endpoints `/metrics`.

## Persistencia y limites del entorno

Compose conserva los datos de Prometheus, Loki, Tempo y Grafana en los volumenes `*-data`. Loki y Tempo usan almacenamiento local de instancia unica; son adecuados para desarrollo, no para alta disponibilidad. El stack tampoco define autenticacion para las APIs de Loki/Tempo ni politicas explicitas de retencion para Loki y Tempo. No deben exponerse tal cual a una red no confiable.

## Referencias por componente

- [Prometheus](./prometheus/README.md): objetivos y consultas de metricas.
- [Loki](./loki/README.md): recepcion y almacenamiento de logs.
- [Tempo](./tempo/README.md): recepcion y almacenamiento de trazas.
- [Grafana](./grafana/README.md): provisioning de fuentes y dashboard.

## Verificacion rapida

```bash
curl http://localhost:9090/-/healthy
curl http://localhost:3100/ready
curl http://localhost:3200/ready
```

Abra Grafana en `http://localhost:3000`. Si faltan logs o trazas, revise `docker compose logs otel-collector`; si faltan metricas, consulte `http://localhost:9090/targets`.

## Rastrear inserts y fallos de escritura

Los servicios `test-fastapi-service` y `test-fastify-service` registran cada escritura en PostgreSQL (INSERT/UPDATE/DELETE) como un log JSON con `table`, `operation`, `event_id` (en eventos), `trace_id` y `span_id`:

- `db_write_ok` (INFO) cuando la escritura termina bien.
- `db_write_failed` (ERROR) con `error_type` y `error` cuando falla. El span correspondiente queda con estado `error` y la excepcion registrada.

Consultas en Grafana → Explore:

```logql
{service_name="test-fastify-service"} |= "db_write_failed"
{service_name=~"test-.*"} | json | event="db_write_failed" | table="node_events"
{service_name=~"test-.*"} | json | event="db_write_ok" | operation="INSERT"
```

```traceql
{ name=~".*db_insert.*" && status=error }
```

Para saltar de un log a su traza, copie el `trace_id` y busquelo en Tempo (`/api/traces/<trace_id>`).
