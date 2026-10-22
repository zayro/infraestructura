# Configuracion de Loki

`loki-config.yaml` configura Loki, el backend que recibe y almacena los logs
enviados por el OpenTelemetry Collector para consultarlos desde Grafana.

## Flujo de logs

Los servicios instrumentados envian sus logs por OTLP al Collector. El pipeline
de logs del Collector los reenvia a `http://loki:3100/otlp`; Loki los recibe y
Grafana consulta Loki como fuente de datos. Esta configuracion no recoge por si
sola los logs de contenedores ni los access logs de Traefik: solo almacena lo
que efectivamente recibe.

## Que configura `loki-config.yaml`

- `auth_enabled: false`: desactiva la autenticacion de Loki. Es apropiado para
  este entorno de appstracion en una red Docker privada, no para exponer Loki
  directamente en una red publica.
- `server.http_listen_port: 3100`: habilita la API HTTP de Loki en el puerto
  `3100`.
- `common.path_prefix: /loki`: establece el directorio base para los archivos
  de Loki.
- `common.replication_factor: 1` y `ring.kvstore.store: inmemory`: configuran
  una sola instancia sin coordinacion persistente entre replicas.
- `common.storage.filesystem`: almacena los bloques de datos y las reglas en
  `/loki/chunks` y `/loki/rules`, respectivamente.
- `schema_config`: selecciona el esquema `v13`, el almacén de índices `tsdb` y
  almacenamiento de objetos en el sistema de archivos, a partir de
  `2024-01-01`. Los índices usan el prefijo `index_` y periodos de 24 horas.
- `limits_config.allow_structured_metadata: true`: permite almacenar
  metadatos estructurados junto con los registros.
- `analytics.reporting_enabled: false`: desactiva el envío de informes de
  analítica de Loki.

## Persistencia y uso

Compose monta el volumen `loki-data` en `/loki`, por lo que los datos
almacenados bajo esa ruta persisten entre reinicios del contenedor. La
configuración no define una política explícita de retención; los datos no se
eliminan según una duración configurada aquí.

El Dockerfile de Loki copia esta configuración a
`/etc/loki/local-config.yaml`, y el servicio se inicia usando ese archivo.
Para comprobar Loki, consulta `http://localhost:3100/ready`. En Grafana, abre
**Explore**, selecciona la fuente de datos Loki y ejecuta una consulta LogQL,
por ejemplo:

```logql
{service_name="test-fastify-service"}
```

Si no aparecen resultados, verifica que el Collector esté recibiendo logs y
que su pipeline los exporte a Loki.
