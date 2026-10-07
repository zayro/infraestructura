# Demo Etapa 1 - Microservicios, Traefik y observabilidad con Docker Compose

Entorno de desarrollo autocontenido para validar:

- Traefik como punto unico de entrada / API Gateway ligero;
- microservicios HTTP (`student-service` y servicios de prueba en FastAPI y Fastify);
- propagacion de trazas entre servicios;
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
  | HTTP :80
  v
Traefik
  |  reverse proxy / routing
  v
student-service :8081 (solo red Docker)

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
- `student-service`: microservicio de aplicacion (Flask). Atiende `/`, `/api/demo`, `/students/<id>` y los health checks.
- `test-fastapi-service` (`/api/test`) y `test-fastify-service` (`/api/node`): servicios de prueba.

El antiguo `gateway-service` se elimino porque Traefik ya cumple ese papel.

## Requisitos

- Docker Engine o Docker Desktop
- Docker Compose v2 (`docker compose`)
- Puertos libres: 80, 3000, 3100, 3200, 8088 y 9090

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
docker compose logs -f traefik student-service otel-collector
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
Traefik :80
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

## Interfaces

| Componente | URL local | Uso |
|---|---|---|
| Traefik / API | http://localhost | Entrada unica a la API |
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

El `student-service` se publica mediante labels y Traefik enruta todo `PathPrefix(`/`)` hacia el puerto interno `8081`.

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

Student service:

```text
GET /health/live
GET /health/ready
```

### Validar dependencia caida

```bash
docker compose stop student-service
curl -i http://localhost:8000/health/ready
```

Traefik deja de enrutar al servicio no saludable y responde 404/503.

Para restaurar:

```bash
docker compose start student-service
```

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
- Traefik aplica rate limit, limite de concurrencia y cabeceras de seguridad (middlewares `demo-*`). No se agrega autenticacion ni TLS.
- No se usa una base de datos: no existe una regla funcional ni un esquema suministrado que justifique agregarla.
- No se usa RabbitMQ/Kafka: no existe todavia un flujo asincrono que lo requiera.
- No se usa Kubernetes/Istio: corresponden a una evolucion posterior del laboratorio.
- Se mantienen los tags existentes `latest` y se fija Traefik en `v3.7.13` para admitir el descubrimiento de servicios con Docker Engine 29. Antes de un ambiente compartido o productivo se deben fijar y validar todas las versiones.
- La clave de Grafana y el dashboard inseguro de Traefik son solo de desarrollo; no deben reutilizarse en produccion.

## Pruebas sugeridas

1. Levantar todos los contenedores y verificar `docker compose ps`.
2. Confirmar que `student-service` no tenga puertos publicados al host.
3. Abrir `http://localhost:8088/dashboard/` y confirmar el router `demo-student`.
4. Ejecutar 10 solicitudes correctas mediante `http://localhost:8000/api/demo`.
5. Ejecutar 3 solicitudes con `fail=1`.
6. Ejecutar 3 solicitudes con `delay_ms=1200`.
7. Confirmar el target `traefik` como `UP` en Prometheus.
8. Confirmar metricas de Traefik en Prometheus.
9. Confirmar metricas de las aplicaciones en Prometheus.
10. Confirmar logs de aplicaciones en Loki desde Grafana.
11. Confirmar trazas en Tempo desde Grafana.
12. Detener `student-service` y validar que `/health/ready` retorne 503 atravesando Traefik.
