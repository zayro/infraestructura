# Tempo

`tempo.yaml` configura Tempo como backend local de trazas distribuidas. Recibe OTLP y permite que Grafana consulte trazas por identificador, servicio o rango de tiempo.

## Configuracion efectiva

- La API HTTP escucha en `3200`; Compose la publica en `http://localhost:3200`.
- El distribuidor recibe OTLP/gRPC en `4317` y OTLP/HTTP en `4318` dentro de la red Docker. En el flujo normal, el OpenTelemetry Collector reenvia trazas a `tempo:4317`.
- `query_frontend.search.duration_slo: 5s` expresa el objetivo de duracion para una busqueda; no es un limite de tiempo ni una politica de retencion.
- El backend `local` escribe un WAL en `/var/tempo/wal` y trazas en `/var/tempo/traces`.
- `usage_report.reporting_enabled: false` desactiva los informes de uso.

Compose monta `tempo-data` en `/var/tempo`, por lo que las trazas sobreviven a un reinicio de contenedor. Es una configuracion de instancia unica, sin replicacion, cifrado ni almacenamiento de objetos; se orienta a desarrollo.

## Uso

```bash
curl http://localhost:3200/ready
```

En Grafana, abra **Explore**, seleccione `Tempo` y busque el `trace_id` devuelto por una API. La fuente Tempo enlaza cada traza con los logs de Loki y las metricas de Prometheus dentro de una ventana de un minuto antes y despues del span.
