# Servicio de prueba Fastify

Servicio HTTP del demo (Node.js 22 / Fastify 5) para probar observabilidad,
persistencia, cache y consumo de eventos. Se expone hacia los clientes unicamente
a traves de Traefik (`/api/node`); dentro de Docker escucha en el puerto `8084`.

## Arquitectura

```
app.js                      composicion: unico lugar que conoce las implementaciones
telemetry.js                SDK OpenTelemetry (ES modules; se carga con --import)
src/
  config.js                 variables de entorno
  domain/                   errores de negocio (EventNotFoundError)
  application/              casos de uso y validacion del mensaje de evento
  infrastructure/           PostgreSQL, Redis, RabbitMQ, metricas, trazas y logs
  interfaces/http/          rutas Fastify, esquemas y mapeo de errores a HTTP
tests/                      pruebas con node:test
```

Las dependencias apuntan hacia el centro: las rutas invocan casos de uso, y los
casos de uso reciben repositorios, cache, generador de ids y `sleep` por
inyeccion, sin conocer Fastify ni los drivers. `app.js` conecta todo.

## Endpoints

- `GET /api/node?delay_ms=100&fail=0`: responde `pong`; `delay_ms` acepta 0-2000
  y `fail=1` genera un error 500 simulado.
- `POST /api/node/items` con `{"name":"demo"}` y `GET /api/node/items`: ejemplo
  con PostgreSQL y cache Redis (cache-aside, TTL 30 s).
- CRUD de eventos sobre la tabla `node_events`:
  - `POST /api/node/events`: `201` (no publica en RabbitMQ).
  - `GET /api/node/events`: los 20 mas recientes.
  - `GET|PUT|DELETE /api/node/events/{event_id}`: `404` si no existe; `400` si
    el id no es UUID o el nombre es invalido (1-100 caracteres).
- `GET /health/live`: el proceso responde.
- `GET /health/ready`: verifica PostgreSQL, Redis y la conexion del consumidor
  RabbitMQ; responde `503` si alguno falla.
- `GET /metrics`: metricas Prometheus.

El servicio tambien consume la cola `test.events` (publicada por FastAPI) con
confirmacion manual: confirma tras guardar, reencola ante fallos transitorios y
descarta los mensajes invalidos. La insercion es idempotente por `event_id`.

## Configuracion

`SERVICE_NAME`, `SERVICE_PORT`, `DATABASE_URL`, `REDIS_URL`, `RABBITMQ_URL`,
`RABBITMQ_QUEUE`, `OTEL_EXPORTER_OTLP_ENDPOINT` y `DEPLOYMENT_ENVIRONMENT`. En
Compose apuntan a los nombres de servicio de la red Docker.

## Pruebas

Las pruebas de casos de uso no requieren dependencias; las de rutas necesitan
Fastify, por lo que se ejecutan en el contenedor:

```powershell
node --test services\test-fastify\tests\use-cases.test.js
docker compose run --rm --no-deps -v "${PWD}\services\test-fastify\tests:/app/tests" test-fastify-service node --test
```
