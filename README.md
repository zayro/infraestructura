# Demo Etapa 1 - Microservicios, Traefik y observabilidad con Docker Compose

Entorno de desarrollo autocontenido para validar:

- Traefik como punto unico de entrada / API Gateway ligero;
- microservicios HTTP (`student-service` y servicios de prueba en FastAPI y Fastify);
- trazas, metricas y logs de cada servicio, escritos en distintos lenguajes (Python/Flask, Python/FastAPI y Node.js/Fastify);
- OpenTelemetry Collector;
- Prometheus para metricas;
- Loki para logs;
- Tempo para trazas;
- Grafana para visualizacion.

> Este demo es deliberadamente pequeno. No incluye RabbitMQ, Kafka, Kubernetes, Istio, Oracle ni autenticacion porque pertenecen a etapas posteriores o requieren una necesidad funcional concreta.

## Arquitectura

```text
Cliente
  |
  | HTTP :8000 (host) -> :80 (contenedor)
  v
Traefik  (rate limit + limite de concurrencia + cabeceras de seguridad)
  |  reverse proxy / routing por PathPrefix
  |-- /api/test --> test-fastapi-service :8083 (solo red Docker)
  |-- /api/node --> test-fastify-service :8084 (solo red Docker)
  `-- /         --> student-service        :8081 (solo red Docker)

Traefik
  `-- /metrics :8082 -------------> Prometheus

Cada microservicio
  |-- /metrics --------------------> Prometheus
  |-- OTLP traces/logs ------------> OpenTelemetry Collector
                                        |-- traces --> Tempo
                                        `-- logs ----> Loki

Prometheus + Loki + Tempo ----------> Grafana
```

### Rol de cada componente

- `traefik`: API gateway. Es el unico punto HTTP publicado para las APIs, decide a que servicio enrutar y aplica rate limit, limite de concurrencia y cabeceras de seguridad.
- `student-service`, `test-fastapi-service` y `test-fastify-service`: microservicios (ver tabla).

El antiguo `gateway-service` se elimino porque Traefik ya cumple ese papel.

### Servicios

| Servicio | Tecnologia | Puerto interno | Ruta en Traefik | Endpoints |
|---|---|---|---|---|
| `student-service` | Python 3.12 / Flask | 8081 | `/` (catch-all) | `/`, `/api/demo`, `/students/<id>` |
| `test-fastapi-service` | Python 3.12 / FastAPI + Uvicorn | 8083 | `/api/test` | `/api/test` |
| `test-fastify-service` | Node.js 22 / Fastify 5 | 8084 | `/api/node` | `/api/node` |

Todos exponen tambien `/metrics`, `/health/live` y `/health/ready`, envian trazas y logs por OTLP al collector y publican las metricas `demo_http_requests_total` y `demo_http_request_duration_seconds`.

Los servicios de prueba aceptan los parametros `delay_ms` (0-2000, latencia simulada) y `fail=1` (error 500 simulado). Las rutas `/api/test` y `/api/node` son mas especificas que `/`, por lo que Traefik las prioriza.

Codigo en `services/student`, `services/test-fastapi` y `services/test-fastify`. Cada servicio tiene su propio `Dockerfile` y su copia de la configuracion de telemetria.

## Requisitos

- Docker Engine o Docker Desktop
- Docker Compose v2 (`docker compose`)
- Puertos libres: 8000, 3000, 3100, 3200, 8088 y 9090

## Inicio

```bash
cp .env.example .env
docker compose up -d --build
```

Estado:

```bash
docker compose ps
```

Logs principales:

```bash
docker compose logs -f traefik student-service test-fastapi-service test-fastify-service otel-collector
```

## Pruebas funcionales

### 1. Flujo correcto pasando obligatoriamente por Traefik

```bash
curl "http://localhost:8000/api/demo?student_id=U00185589&delay_ms=150&fail=0"
```

Flujo esperado:

```text
curl
  |
  v
Traefik :80 (publicado en :8000)
  |
  v
student-service :8081
```

Debe responder HTTP 200 e incluir un `trace_id` generado por el microservicio.

### 2. Error controlado

```bash
curl -i "http://localhost:8000/api/demo?student_id=U00185589&delay_ms=100&fail=1"
```

El `student-service` retorna 500 y Traefik reenvia esa respuesta al cliente.

### 3. Latencia

```bash
curl "http://localhost:8000/api/demo?student_id=U00185589&delay_ms=1200&fail=0"
```

Esto incrementa la latencia observada sin modificar infraestructura.

### 4. Health check a traves de Traefik

```bash
curl -i http://localhost:8000/health/live
curl -i http://localhost:8000/health/ready
```

### 5. Servicios de prueba (FastAPI y Fastify)

```bash
curl "http://localhost:8000/api/test?delay_ms=50"
curl -i "http://localhost:8000/api/test?fail=1"

curl "http://localhost:8000/api/node?delay_ms=50"
curl -i "http://localhost:8000/api/node?fail=1"
```

Respuesta correcta (200): `{"ok":true,"service":"...","trace_id":"...","message":"pong"}`. Con `fail=1` responden 500.

### 6. Rate limit

```bash
# 80 peticiones en paralelo (PowerShell 7)
1..80 | ForEach-Object -Parallel { (Invoke-WebRequest "http://localhost:8000/api/node?delay_ms=0" -SkipHttpErrorCheck).StatusCode } -ThrottleLimit 40 | Group-Object
```

Las peticiones que superan el limite reciben HTTP 429.

## Interfaces

| Componente | URL local | Uso |
|---|---|---|
| Traefik / API | http://localhost:8000 | Entrada unica a la API |
| Traefik Dashboard | http://localhost:8088/dashboard/ | Diagnostico del routing en desarrollo |
| Grafana | http://localhost:3000 | Dashboards, logs y trazas |
| Prometheus | http://localhost:9090 | Consulta de metricas |
| Loki | http://localhost:3100/ready | Estado de Loki |
| Tempo | http://localhost:3200/ready | Estado de Tempo |

Los microservicios no publican puertos hacia el host. Permanecen accesibles solamente dentro de `demo-observability-net`.

`http://localhost:8000/` devuelve un JSON con el nombre del servicio y sus endpoints; no es una pagina HTML. La interfaz visual de observabilidad esta en `http://localhost:3000`.

Credenciales iniciales de Grafana:

```text
usuario: admin
clave:   admin
```

Cambielas en `.env` si el entorno se comparte.

## Traefik

Traefik descubre unicamente los contenedores habilitados explicitamente porque se configura:

```text
providers.docker.exposedByDefault=false
```

Los servicios se publican mediante labels de Docker:

| Router | Regla | Servicio destino |
|---|---|---|
| `demo-student` | `PathPrefix(`/`)` | `student-service:8081` |
| `demo-test-fastapi` | `PathPrefix(`/api/test`)` | `test-fastapi-service:8083` |
| `demo-test-fastify` | `PathPrefix(`/api/node`)` | `test-fastify-service:8084` |

### Middlewares

Se definen una sola vez por labels en `student-service` y los tres routers los aplican (los otros los referencian como `<nombre>@docker`):

| Middleware | Funcion | Valor por defecto |
|---|---|---|
| `demo-ratelimit` | Rate limit por IP de origen; responde 429 al excederlo | 10 peticiones/s, rafaga de 20 |
| `demo-inflight` | Maximo de peticiones simultaneas; responde 429 al excederlo | 50 |
| `demo-secure-headers` | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, filtro XSS y elimina `Server` / `X-Powered-By` | - |

Se ajustan en `.env` con `RATE_LIMIT_AVERAGE`, `RATE_LIMIT_BURST` y `MAX_INFLIGHT_REQUESTS`. El dashboard (`:8088`) y los servicios de observabilidad no pasan por estos middlewares.

El dashboard de Traefik se expone con `api.insecure=true` exclusivamente para este entorno de desarrollo. No debe utilizarse asi en produccion.

Traefik monta:

```text
/var/run/docker.sock
```

en modo solo lectura para descubrir servicios Docker. Aunque el montaje sea `:ro`, el socket representa una superficie sensible y debe revisarse antes de usar este patron en un entorno compartido o productivo.

### Metricas de Traefik

Prometheus recoge tambien las metricas de Traefik desde la red interna:

```text
traefik:8082/metrics
```

Ejemplo PromQL:

```promql
sum by (entrypoint) (
  rate(traefik_entrypoint_requests_total[1m])
)
```

## Grafana

Los data sources se aprovisionan automaticamente:

- Prometheus
- Loki
- Tempo

Tambien se carga el dashboard:

```text
Demo Etapa 1 - Observabilidad
```

El dashboard contiene ahora una grafica adicional con solicitudes observadas por Traefik.

Para revisar trazas:

1. Abra Grafana.
2. Vaya a Explore.
3. Seleccione `Tempo`.
4. Busque trazas recientes o utilice el `trace_id` retornado por el servicio.

Para revisar logs de los microservicios:

1. Abra Explore.
2. Seleccione `Loki`.
3. Consulte, por ejemplo:

```logql
{service_name="student-service"}
```

O:

```logql
{service_name="student-service"} |= "student_lookup"
{service_name="test-fastapi-service"} |= "test_ok"
{service_name="test-fastify-service"} |= "node_ok"
```

Los access logs de Traefik se generan en JSON sobre `stdout` y se consultan en desarrollo con:

```bash
docker compose logs -f traefik
```

No se incorporaron esos access logs a Loki en este cambio para no ampliar el alcance de la Etapa 1.

## Metricas del demo

Prometheus recoge de los microservicios:

```text
demo_http_requests_total
demo_http_request_duration_seconds
```

Ejemplos PromQL:

```promql
sum by (service) (rate(demo_http_requests_total[1m]))
```

```promql
histogram_quantile(
  0.95,
  sum by (le, service) (rate(demo_http_request_duration_seconds_bucket[5m]))
)
```

```promql
sum by (service) (rate(demo_http_requests_total{status=~"5.."}[1m]))
```

## Health checks

Traefik utiliza su `ping` interno como health check del contenedor.

Cada servicio (`student-service`, `test-fastapi-service`, `test-fastify-service`):

```text
GET /health/live
GET /health/ready
```

Las rutas `/health/*` de Traefik apuntan al `student-service` por ser el catch-all. Los healthchecks de contenedor de cada servicio se declaran en `docker-compose.yml` (el de Fastify usa `127.0.0.1` porque `localhost` resuelve a IPv6 en Alpine).

### Validar dependencia caida

```bash
docker compose stop student-service
curl -i http://localhost:8000/health/ready
```

Traefik deja de enrutar al servicio no saludable y responde 404.

Para restaurar:

```bash
docker compose start student-service
```

## Observabilidad: que hace cada componente

La observabilidad permite entender el estado interno de un sistema a partir de sus salidas. Se apoya en tres senales: **metricas** (numeros agregados en el tiempo), **logs** (eventos puntuales) y **trazas** (el recorrido de una peticion). Cada una responde una pregunta distinta y ninguna basta por si sola.

| Componente | Senal | Que hace en este demo | Ventajas |
|---|---|---|---|
| OpenTelemetry (SDK + Collector) | Todas | Los servicios se instrumentan con el SDK y envian trazas y logs por OTLP al Collector, que los reenvia a Tempo y Loki | Estandar abierto e independiente del proveedor; el mismo modelo sirve para Python y Node.js; cambiar de backend no exige tocar el codigo de los servicios |
| Prometheus | Metricas | Recoge (scrape) `/metrics` de los servicios y de Traefik cada 5 s y permite consultas PromQL | Modelo pull simple, etiquetas multidimensionales, consultas potentes (tasas, percentiles) y base natural para alertas |
| Loki | Logs | Almacena los logs JSON enviados por el Collector, indexados por etiquetas como `service_name` | Indexa solo etiquetas, no el texto completo: menor costo y operacion mas ligera; consultas con LogQL |
| Tempo | Trazas | Guarda las trazas distribuidas y permite buscarlas por `trace_id` | Solo necesita almacenamiento de objetos o disco, sin indexar todo; se correlaciona con logs y metricas |
| Grafana | Visualizacion | Unifica Prometheus, Loki y Tempo en un dashboard y en Explore | Una sola interfaz para las tres senales y para navegar entre ellas |
| Traefik | Metricas y access logs | Expone metricas de entrada (`:8082`) y access logs JSON | Visibilidad del trafico desde el borde: volumen, codigos de estado y latencia antes de llegar a la aplicacion |

### Como se complementan

```text
Servicios (Flask / FastAPI / Fastify)
  |-- /metrics ---------------------------> Prometheus --\
  |-- OTLP (trazas + logs) --> Collector --> Tempo -------+--> Grafana
  |                                     `--> Loki -------/
Traefik -- /metrics :8082 ---------------> Prometheus
```

- **Metricas: detectan que algo va mal.** Un aumento de `demo_http_requests_total{status=~"5.."}` o del percentil 95 de latencia indica que existe un problema, pero no su causa.
- **Trazas: localizan donde.** Con el `trace_id` que devuelve cada respuesta se ve el recorrido de la peticion y el span (por ejemplo `test.business_logic`) donde se gasta el tiempo o falla.
- **Logs: explican por que.** Los logs estructurados incluyen `trace_id` y `span_id`, por lo que desde una traza se llega a sus logs exactos (por ejemplo `test_simulated_error`) y viceversa.
- **Flujo de diagnostico tipico:** alerta o grafica en Prometheus, luego la traza afectada en Tempo y, por ultimo, los logs de ese `trace_id` en Loki, todo desde Grafana.
- **Correlacion:** el identificador `trace_id` une las tres senales; por eso todos los servicios lo incluyen en sus respuestas y en cada log.
- **Desacople:** el Collector separa a los servicios de los backends. Los servicios solo conocen el endpoint OTLP; Tempo y Loki se pueden reemplazar o ampliar sin cambiar la aplicacion.

### Ejemplo practico con este demo

1. Ejecutar `curl -i "http://localhost:8000/api/node?fail=1"`; responde 500 y devuelve un `trace_id`.
2. En Prometheus: `sum by (service) (rate(demo_http_requests_total{status=~"5.."}[1m]))` muestra el aumento de errores en `test-fastify-service`.
3. En Grafana > Explore > Tempo: buscar el `trace_id` para ver el span `node.business_logic`.
4. En Grafana > Explore > Loki: `{service_name="test-fastify-service"} |= "node_simulated_error"` muestra el log asociado.

## Detener

Conservar volumenes:

```bash
docker compose down
```

Eliminar tambien datos del demo:

```bash
docker compose down -v
```

## Alcance y decisiones intencionales

- Traefik se agrega como capa de entrada sin modificar el codigo de los microservicios.
- No se cambia el contrato de `/api/demo`, `/health/live` ni `/health/ready`.
- Los microservicios dejan de exponerse directamente al host para evitar bypass del API Gateway.
- Los servicios de prueba (`test-fastapi-service`, `test-fastify-service`) solo existen para validar enrutado y observabilidad con distintos lenguajes.
- Traefik aplica rate limit, limite de concurrencia y cabeceras de seguridad (middlewares `demo-*`). No se agrega autenticacion ni TLS.
- No se usa una base de datos: no existe una regla funcional ni un esquema suministrado que justifique agregarla.
- No se usa RabbitMQ/Kafka: no existe todavia un flujo asincrono que lo requiera.
- No se usa Kubernetes/Istio: corresponden a una evolucion posterior del laboratorio.
- Se mantienen los tags existentes `latest` y se fija Traefik en `v3.7.13` para admitir el descubrimiento de servicios con Docker Engine 29. Antes de un ambiente compartido o productivo se deben fijar y validar todas las versiones.
- La clave de Grafana y el dashboard inseguro de Traefik son solo de desarrollo; no deben reutilizarse en produccion.

## Pruebas sugeridas

1. Levantar todos los contenedores y verificar `docker compose ps`.
2. Confirmar que ningun microservicio tenga puertos publicados al host.
3. Abrir `http://localhost:8088/dashboard/` y confirmar los routers `demo-student`, `demo-test-fastapi` y `demo-test-fastify`.
4. Ejecutar 10 solicitudes correctas mediante `http://localhost:8000/api/demo`.
5. Ejecutar 3 solicitudes con `fail=1`, tambien contra `/api/test` y `/api/node`.
6. Ejecutar 3 solicitudes con `delay_ms=1200`.
7. Confirmar el target `traefik` como `UP` en Prometheus.
8. Confirmar metricas de Traefik en Prometheus.
9. Confirmar metricas de las aplicaciones en Prometheus.
10. Confirmar logs de aplicaciones en Loki desde Grafana.
11. Confirmar trazas en Tempo desde Grafana.
12. Detener `student-service` y validar que `/health/ready` deje de responder 200 atravesando Traefik.
13. Lanzar una rafaga paralela contra `/api/node` y confirmar respuestas 429.
14. Confirmar en Prometheus los targets `student-service`, `test-fastapi-service` y `test-fastify-service` como `UP`.

## Bibliografia y referencias

Documentacion oficial:

- OpenTelemetry. *Documentation* (conceptos de senales, SDK y Collector): https://opentelemetry.io/docs/
- OpenTelemetry. *OTLP Specification*: https://opentelemetry.io/docs/specs/otlp/
- Prometheus. *Overview*: https://prometheus.io/docs/introduction/overview/
- Prometheus. *Querying basics (PromQL)*: https://prometheus.io/docs/prometheus/latest/querying/basics/
- Grafana Labs. *Grafana Loki documentation*: https://grafana.com/docs/loki/latest/
- Grafana Labs. *Grafana Tempo documentation*: https://grafana.com/docs/tempo/latest/
- Grafana Labs. *Grafana documentation*: https://grafana.com/docs/grafana/latest/
- Traefik Labs. *Traefik Proxy documentation* (routers, middlewares, RateLimit, InFlightReq, Headers): https://doc.traefik.io/traefik/
- Flask: https://flask.palletsprojects.com/ - FastAPI: https://fastapi.tiangolo.com/ - Fastify: https://fastify.dev/

Libros y articulos:

- Majors, C., Fong-Jones, L. y Miranda, G. (2022). *Observability Engineering*. O'Reilly Media.
- Parker, A., Spoonhower, D., Mace, J., Sigelman, B. y Isaacs, R. (2020). *Distributed Tracing in Practice*. O'Reilly Media.
- Beyer, B., Jones, C., Petoff, J. y Murphy, N. R. (2016). *Site Reliability Engineering*, cap. 6 "Monitoring Distributed Systems". O'Reilly Media. Disponible en https://sre.google/sre-book/monitoring-distributed-systems/
- Sigelman, B. H. et al. (2010). *Dapper, a Large-Scale Distributed Systems Tracing Infrastructure*. Google Technical Report.
