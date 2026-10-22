# Demo Etapa 1 - Microservicios, Traefik y observabilidad con Docker Compose

Entorno autocontenido de desarrollo para validar un API Gateway, dos microservicios HTTP, datos, mensajeria y observabilidad.

- Traefik como punto unico de entrada.
- Servicios de prueba en FastAPI y Fastify.
- PostgreSQL, Redis y RabbitMQ.
- OpenTelemetry Collector, Prometheus, Loki, Tempo y Grafana.
- JWT y RBAC validados directamente en Traefik.

> El proyecto no despliega un proveedor de identidad. Los JWT para desarrollo se generan localmente con `scripts/jwt_tool.py` y Traefik valida su firma HMAC y sus roles.

## Arquitectura

```text
Cliente
  |
  | HTTP :8000
  v
Traefik (JWT/RBAC, rate limit, concurrencia, headers)
  |-- /api/test --> test-fastapi-service :8083
  `-- /api/node --> test-fastify-service :8084

FastAPI -- eventos AMQP --> RabbitMQ --> Fastify --> PostgreSQL
   |                         |
   `-- PostgreSQL + Redis ---'

Servicios -- metricas --> Prometheus --\
Servicios -- OTLP -------> Collector --> Tempo + Loki --> Grafana
Traefik -- metricas ------------------/
```

Todos los contenedores comparten la red Docker `demo-observability-net`. Los microservicios no publican puertos al host.

## Componentes

| Componente | Responsabilidad | Exposicion |
|---|---|---|
| `traefik` | Gateway HTTP, enrutado, JWT/RBAC, rate limit y headers | `:8000`, dashboard `:8088` |
| `test-fastapi-service` | API Python/FastAPI y publicador AMQP | Interna, `:8083` |
| `test-fastify-service` | API Node/Fastify y consumidor AMQP | Interna, `:8084` |
| `postgres` | Persistencia de items y eventos | `127.0.0.1:5432` |
| `redis` | Cache-aside con TTL de 30 s | `127.0.0.1:6379` |
| `rabbitmq` | Cola durable `test.events` | `127.0.0.1:5672`, consola `:15672` |
| `otel-collector` | Recibe OTLP y reenvia senales | Interna |
| `prometheus` | Metricas | `:9090` |
| `loki` / `tempo` | Logs / trazas | `:3100` / `:3200` |
| `grafana` | Visualizacion unificada | `:3000` |

Los dos servicios exponen `/metrics`, `/health/live` y `/health/ready` dentro de la red Docker. Las APIs incluyen CRUD de items, cache Redis y un flujo asincrono FastAPI -> RabbitMQ -> Fastify.

## Organizacion de Compose

`docker-compose.yml` compone una unica plataforma:

| Archivo o directorio | Contenido |
|---|---|
| `compose/infra.yml` | PostgreSQL, RabbitMQ y Redis |
| `compose/gateway.yml` | Traefik y sus middlewares compartidos |
| `compose/observability.yml` | Collector, Prometheus, cAdvisor, Loki, Tempo y Grafana |
| `traefik/dynamic/jwt-middlewares.yml` | Middlewares JWT/RBAC de Traefik |
| `services/<servicio>/compose.yaml` | Contenedor, healthcheck y routers de cada servicio |

El servicio Fastify se incluye desde `https://github.com/zayro/api-telemetria-fastify.git#main:compose.yaml`; Compose lo clona en su cache. Para fijar una version, sustituya `main` por un tag o commit.

## Requisitos e inicio

- Docker Engine o Docker Desktop.
- Docker Compose v2.
- Puertos libres: 8000, 3000, 3100, 3200, 8088 y 9090.

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
```

Logs principales:

```bash
docker compose logs -f traefik test-fastapi-service test-fastify-service otel-collector
```

## Autenticacion y RBAC

Traefik utiliza el plugin `agilezebra/jwt-middleware` para validar JWT firmados con `JWT_SECRET`. Valida la expiracion, exige los roles configurados e inyecta `X-Auth-User`, `X-Auth-Email` y `X-Auth-Roles` al servicio de destino.

Los middlewares de `traefik/dynamic/jwt-middlewares.yml` son:

| Middleware | Uso |
|---|---|
| `demo-jwt-auth@file` | Rutas protegidas |
| `demo-jwt-admin@file` | Requiere `admin` |
| `demo-jwt-service@file` | Requiere `service` |
| `demo-jwt-user@file` | Requiere `user` o `admin` |

Las rutas `/api/test/public` y `/api/node/public` no requieren token. El resto de las rutas de los servicios requiere un JWT Bearer.

Genere tokens de desarrollo sin dependencias externas:

```bash
make token        # demo-service, rol service
make token-admin  # demo-admin, roles admin,user
make token-user   # demo-user, rol user
```

En PowerShell:

```powershell
$token = make token
curl.exe -H "Authorization: Bearer $token" "http://localhost:8000/api/node?delay_ms=150"
```

En shells POSIX:

```bash
TOKEN=$(make token)
curl -H "Authorization: Bearer $TOKEN" "http://localhost:8000/api/node?delay_ms=150"
```

`JWT_SECRET` debe cambiarse en `.env` antes de compartir el entorno. El generador debe usar el mismo valor; exporte la variable de entorno antes de ejecutar `make token` si modifico el secreto.

## Pruebas funcionales

Primero cree un token (`TOKEN=$(make token)` o `$token = make token`).

```bash
# Ruta protegida sin token: 401
curl -i http://localhost:8000/api/node

# Rutas publicas: 200 sin token
curl http://localhost:8000/api/test/public
curl http://localhost:8000/api/node/public

# Ruta protegida correcta: 200
curl -H "Authorization: Bearer $TOKEN" "http://localhost:8000/api/node?delay_ms=150&fail=0"

# Error controlado: 500
curl -i -H "Authorization: Bearer $TOKEN" "http://localhost:8000/api/node?delay_ms=100&fail=1"
```

### Datos y cache

```bash
curl -X POST http://localhost:8000/api/test/items \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"demo"}'
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/test/items

curl -X POST http://localhost:8000/api/node/items \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"demo"}'
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/node/items
```

El primer `GET` devuelve `source: "db"`; las consultas posteriores durante 30 segundos devuelven `source: "cache"`. El `POST` invalida la cache. Los datos persisten en `postgres-data` y Redis usa AOF.

### Eventos asincronos

```bash
curl -i -X POST http://localhost:8000/api/test/events \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"demo-event"}'
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/node/events
```

FastAPI publica un mensaje persistente en `test.events`. Fastify lo confirma manualmente despues de guardarlo de forma idempotente en `node_events`; si falla la persistencia, RabbitMQ lo reencola.

### Rate limit

Los limites por defecto son 10 solicitudes/s por IP, rafaga de 20 y 50 solicitudes simultaneas. Se ajustan con `RATE_LIMIT_AVERAGE`, `RATE_LIMIT_BURST` y `MAX_INFLIGHT_REQUESTS` en `.env`.

```powershell
1..80 | ForEach-Object -Parallel {
  (Invoke-WebRequest "http://localhost:8000/api/node?delay_ms=0" -SkipHttpErrorCheck).StatusCode
} -ThrottleLimit 40 | Group-Object
```

Las solicitudes que superen el limite reciben `429`.

## Observabilidad

| Senal | Flujo | Uso |
|---|---|---|
| Metricas | Servicios y Traefik -> Prometheus | Trafico, errores y latencia |
| Trazas | Servicios -> Collector -> Tempo | Recorrido de una solicitud |
| Logs | Servicios -> Collector -> Loki | Detalle de eventos |

Grafana une las tres senales por `trace_id`. Flujo de diagnostico: detecte el problema en Prometheus, ubique el tramo afectado en Tempo y consulte los logs asociados en Loki.

Traefik tambien envia sus trazas por OTLP/gRPC a `otel-collector:4317`; el Collector las reenvia a Tempo. Esta configuracion es independiente de las metricas Prometheus. `TRAEFIK_TRACING_SAMPLE_RATE` controla el muestreo (`1.0` en desarrollo, `0.1` como punto de partida para un trafico mayor).

Consultas utiles:

```promql
sum by (service) (rate(demo_http_requests_total[1m]))
```

```promql
histogram_quantile(0.95, sum by (le, service) (rate(demo_http_request_duration_seconds_bucket[5m])))
```

```logql
{service_name="test-fastify-service"}
```

## Interfaces locales

| Componente | URL |
|---|---|
| API / Traefik | http://localhost:8000 |
| Dashboard de Traefik | http://localhost:8088/dashboard/ |
| Grafana | http://localhost:3000 |
| Prometheus | http://localhost:9090 |
| cAdvisor | http://localhost:8081 |
| Loki | http://localhost:3100/ready |
| Tempo | http://localhost:3200/ready |

Grafana usa inicialmente `admin` / `admin`; cambie estas credenciales en `.env` si el entorno se comparte.

## Operacion

```bash
# Detener y conservar datos
docker compose down

# Detener y eliminar todos los volumenes del demo (destructivo)
docker compose down -v
```

El script `postgres/init/script.sql` solo se ejecuta cuando se crea `postgres-data`; para volver a cargar las filas semilla debe recrear el volumen. Los healthchecks se consultan con `docker compose ps`; `/health/*` permanece interno y no se publica por Traefik.

## Alcance y limites

- Es un entorno de demostracion y desarrollo, no una configuracion de produccion.
- El dashboard de Traefik usa `api.insecure=true` y los secretos de `.env.example` son valores de desarrollo.
- Antes de produccion se requieren TLS, gestion de secretos, control de acceso al dashboard, imagenes con versiones inmutables y alta disponibilidad.
- Traefik monta el socket Docker como solo lectura para descubrir servicios; aun asi es una superficie sensible y debe revisarse en entornos compartidos.
- No se usa Kubernetes/Istio porque esta etapa valida Compose, enrutamiento y observabilidad local.

## Referencias

- [OpenTelemetry](https://opentelemetry.io/docs/)
- [Prometheus](https://prometheus.io/docs/)
- [Grafana Loki](https://grafana.com/docs/loki/latest/)
- [Grafana Tempo](https://grafana.com/docs/tempo/latest/)
- [Traefik Proxy](https://doc.traefik.io/traefik/)
