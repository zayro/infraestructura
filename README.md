# App Etapa 1 - Microservicios, Traefik y observabilidad con Docker Compose

Entorno autocontenido de desarrollo para validar un API Gateway, dos microservicios HTTP, datos, mensajeria y observabilidad.

- Traefik como punto unico de entrada.
- Servicios de prueba en FastAPI y Fastify.
- PostgreSQL, Redis y Kafka.
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

FastAPI -- eventos Kafka --> Kafka --> Fastify --> PostgreSQL
   |                         |
   `-- PostgreSQL + Redis ---'

Servicios -- metricas --> Prometheus --\
Servicios -- OTLP -------> Collector --> Tempo + Loki --> Grafana
Traefik -- metricas ------------------/
```

Todos los contenedores comparten la red Docker `app-observability-net`. Los microservicios no publican puertos al host.

## Componentes

| Componente | Responsabilidad | Exposicion |
|---|---|---|
| `traefik` | Gateway HTTP, enrutado, JWT/RBAC, rate limit y headers | `:8000`, dashboard `:8088` |
| `test-fastapi-service` | API Python/FastAPI y publicador Kafka | Interna, `:8083` |
| `test-fastify-service` | API Node/Fastify y consumidor Kafka | Interna, `:8084` |
| `postgres` | Persistencia de items y eventos | `127.0.0.1:5432` |
| `redis` | Cache-aside con TTL de 30 s | `127.0.0.1:6379` |
| `kafka` | Topic retenido `test.events` | `127.0.0.1:29092` |
| `otel-collector` | Recibe OTLP y reenvia senales | Interna |
| `prometheus` | Metricas | `:9090` |
| `loki` / `tempo` | Logs / trazas | `:3100` / `:3200` |
| `grafana` | Visualizacion unificada | `:3000` |

Los dos servicios exponen `/metrics`, `/health/live` y `/health/ready` dentro de la red Docker. Las APIs incluyen CRUD de items, cache Redis y un flujo asincrono FastAPI -> Kafka -> Fastify.

## Mensajeria Kafka

Kafka 4.1.2 utiliza KRaft con un broker/controlador para desarrollo. No requiere ZooKeeper.
Los topics `test.events` y `test.events.dlq` tienen tres particiones, replica unica y retencion de siete dias; `kafka-init` los crea antes de iniciar las aplicaciones.
Los nombres se configuran con `KAFKA_TOPIC` y `KAFKA_DLQ_TOPIC`; el grupo con `KAFKA_CONSUMER_GROUP`.
Los clientes de contenedores usan `kafka:9092`; los del host, `localhost:29092`.

Compose incluye los checkouts locales de ambos repositorios. Si no existen, prepararlos desde la raiz:

```powershell
git clone https://github.com/zayro/api-telemetria-fastapi.git services/test-fastapi
git clone https://github.com/zayro/api-telemetria-fastify.git services/test-fastify
```

Ambos checkouts deben contener la migracion Kafka. Cada servicio conserva su propio repositorio Git: sus cambios se versionan alli, porque `/services/*` esta excluido del repositorio de infraestructura.

FastAPI publica con `aiokafka`, idempotencia y `acks=all`. Fastify consume con KafkaJS, grupo estable y confirmacion manual del siguiente offset despues de PostgreSQL. La entrega es al menos una vez; el `event_id` unico evita duplicar filas. Los grupos nuevos leen desde el principio del historial retenido. El orden es por particion, usando `event_id` como clave.

La escritura de FastAPI en PostgreSQL y su publicacion siguen siendo dos operaciones separadas; la migracion no implementa un outbox transaccional. Una interrupcion entre ambas puede requerir reconciliacion.

No se transfieren automaticamente mensajes pendientes de RabbitMQ ni se elimina su volumen anterior. Antes de migrar un entorno con mensajes pendientes, detener publicaciones y drenar la cola con los servicios anteriores.

`kafka-exporter` expone metricas de brokers, topics y offsets a Prometheus; Grafana incluye **Kafka - Mensajeria** con lag por grupo/particion, tasas, errores, DLQ y latencias. No incluye metricas JVM/JMX.
Las cabeceras W3C de OpenTelemetry conectan el span productor con el consumidor en Tempo; los logs de consumo en Loki incluyen el mismo `trace_id`.

```powershell
docker compose up -d --build
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 --describe --group test-fastify-service
```

Validacion reproducible (Node.js en el host para el primer comando):

```powershell
node scripts/verify_kafka.cjs
docker compose cp scripts/verify_kafka_delivery.py test-fastapi-service:/tmp/verify_kafka_delivery.py
docker compose exec -T test-fastapi-service python /tmp/verify_kafka_delivery.py
```

La primera prueba comprueba HTTP, persistencia, metricas, logs, trazas y salud de Grafana;
si se proporciona `GRAFANA_API_TOKEN`, tambien valida el dashboard mediante su API.
la segunda comprueba duplicados, DLQ y offsets. Crean eventos de prueba y conservan sus registros.

Es un despliegue local con PLAINTEXT y replica unica, sin alta disponibilidad. OpenTelemetry Collector, Tempo, Loki y Grafana conservan sus responsabilidades.

## Organizacion de Compose

`docker-compose.yml` compone una unica plataforma:

| Archivo o directorio | Contenido |
|---|---|
| `compose/infra.yml` | PostgreSQL, Kafka y Redis |
| `compose/gateway.yml` | Traefik y sus middlewares compartidos |
| `compose/observability.yml` | Collector, Prometheus, cAdvisor, Loki, Tempo y Grafana |
| `traefik/dynamic/jwt-middlewares.yml` | Middlewares JWT/RBAC de Traefik |
| `services/<servicio>/compose.yaml` | Contenedor, healthcheck y routers de cada servicio |

Los dos microservicios se incluyen desde sus checkouts locales en `services/`. Deben actualizarse junto con la infraestructura para conservar el contrato Kafka.

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
| `app-jwt-auth@file` | Rutas protegidas |
| `app-jwt-admin@file` | Requiere `admin` |
| `app-jwt-service@file` | Requiere `service` |
| `app-jwt-user@file` | Requiere `user` o `admin` |

Las rutas `/api/test/public` y `/api/node/public` no requieren token. El resto de las rutas de los servicios requiere un JWT Bearer.

Genere tokens de desarrollo sin dependencias externas:

Con `make`:

```bash
make token        # app-service, rol service
make token-admin  # app-admin, roles admin,user
make token-user   # app-user, rol user
```

O directamente con Python (recomendado en Windows PowerShell o para definir tiempo de expiración `--ttl`):

```bash
# Token de servicio (sub: app-service, rol: service, TTL: 1 año = 31536000 s)
python scripts/jwt_tool.py generate --sub app-service --roles service --ttl 31536000

# Token de administrador (sub: app-admin, roles: admin, user, TTL: 1 año)
python scripts/jwt_tool.py generate --sub app-admin --roles admin,user --ttl 31536000

# Token de usuario regular (sub: app-user, rol: user, TTL: 1 año)
python scripts/jwt_tool.py generate --sub app-user --roles user --ttl 31536000
```

En PowerShell:

```powershell
$token = python scripts/jwt_tool.py generate --sub app-service --roles service
curl.exe -i -H "Authorization: Bearer $token" "http://localhost:8000/api/node?delay_ms=0&fail=0"
```

En shells POSIX:

```bash
TOKEN=$(python scripts/jwt_tool.py generate --sub app-service --roles service)
curl -i -H "Authorization: Bearer $TOKEN" "http://localhost:8000/api/node?delay_ms=0&fail=0"
```

`JWT_SECRET` debe cambiarse en `.env` antes de compartir el entorno. El generador debe usar el mismo valor; exporte la variable de entorno antes de ejecutar la generación si modificó el secreto.

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
  -d '{"name":"app"}'
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/test/items

curl -X POST http://localhost:8000/api/node/items \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"app"}'
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/node/items
```

El primer `GET` devuelve `source: "db"`; las consultas posteriores durante 30 segundos devuelven `source: "cache"`. El `POST` invalida la cache. Los datos persisten en `postgres-data` y Redis usa AOF.

### Eventos asincronos

```bash
curl -i -X POST http://localhost:8000/api/test/events \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"app-event"}'
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/node/events
```

FastAPI espera la confirmacion de Kafka al publicar en `test.events`. Fastify confirma el offset despues de guardar de forma idempotente en `node_events`; ante fallos de persistencia, el consumidor reintenta desde el ultimo offset confirmado. Los mensajes invalidos se conservan en `test.events.dlq`.

### Rate limit

Los limites por defecto son 10 solicitudes/s por IP, rafaga de 20 y 50 solicitudes simultaneas. Se ajustan con `RATE_LIMIT_AVERAGE`, `RATE_LIMIT_BURST` y `MAX_INFLIGHT_REQUESTS` en `.env`.

```powershell
1..80 | ForEach-Object -Parallel {
  (Invoke-WebRequest "http://localhost:8000/api/node?delay_ms=0" -SkipHttpErrorCheck).StatusCode
} -ThrottleLimit 40 | Group-Object
```

Las solicitudes que superen el limite reciben `429`.

### Colección de Postman y pruebas automatizadas (Newman)

El proyecto incluye la colección lista para usar en `postman/app-etapa1.postman_collection.json`, con pruebas funcionales de autenticación, validación RBAC, rutas públicas vs. protegidas, operaciones CRUD con caché Redis, mensajería asíncrona Kafka y trazas en Tempo.

#### Variables requeridas en la colección

La colección requiere 3 tokens en sus variables (`Collection Variables`):
- `access_token`: JWT con rol `service` y usuario `app-service`.
- `admin_token`: JWT con roles `admin,user` y usuario `app-admin`.
- `user_token`: JWT con rol `user` y usuario `app-user`.

#### Actualizar tokens manualmente en Postman

1. Genere tokens válidos con la duración deseada (por ejemplo, 1 año con `--ttl 31536000`):
   ```bash
   python scripts/jwt_tool.py generate --sub app-service --roles service --ttl 31536000
   python scripts/jwt_tool.py generate --sub app-admin --roles admin,user --ttl 31536000
   python scripts/jwt_tool.py generate --sub app-user --roles user --ttl 31536000
   ```
2. En Postman:
   - Abra la colección **App Etapa 1 - Infraestructura Microservicios**.
   - Vaya a la pestaña **Variables**.
   - Pegue cada token correspondiente en las columnas **Initial value** y **Current value**.
   - Guarde los cambios (**Ctrl + S**).

*(Alternativa: Reimporte el archivo `postman/app-etapa1.postman_collection.json`, el cual ya cuenta con tokens válidos preconfigurados).*

#### Ejecución de la suite completa por CLI (Newman)

Para validar todos los endpoints y aserciones de la colección de Postman directamente desde la terminal:

```bash
npx -y newman run postman/app-etapa1.postman_collection.json --bail
```

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
sum by (service) (rate(app_http_requests_total[1m]))
```

```promql
histogram_quantile(0.95, sum by (le, service) (rate(app_http_request_duration_seconds_bucket[5m])))
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

# Detener y eliminar todos los volumenes del app (destructivo)
docker compose down -v
```

El script `postgres/init/script.sql` solo se ejecuta cuando se crea `postgres-data`; para volver a cargar las filas semilla debe recrear el volumen. Los healthchecks se consultan con `docker compose ps`; `/health/*` permanece interno y no se publica por Traefik.

## Alcance y limites

- Es un entorno de appstracion y desarrollo, no una configuracion de produccion.
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
