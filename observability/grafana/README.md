# Grafana

La carpeta contiene el provisioning que Grafana aplica al iniciar el contenedor y el dashboard incluido en el laboratorio. El Dockerfile copia `provisioning/` a `/etc/grafana/provisioning` y `dashboards/` a `/var/lib/grafana/dashboards`.

## Fuentes de datos

`provisioning/datasources/datasources.yaml` crea fuentes no editables:

| Nombre | URL interna | Uso |
|---|---|---|
| Prometheus | `http://prometheus:9090` | Metricas; es la fuente predeterminada. |
| Loki | `http://loki:3100` | Logs estructurados. |
| Tempo | `http://tempo:3200` | Trazas distribuidas. |

La definicion habilita navegacion entre senales: en Loki, el campo JSON `trace_id` se convierte en un enlace a Tempo; desde Tempo se puede consultar Loki por `trace_id` y Prometheus por la etiqueta `service`, con una ventana de un minuto a cada lado de la traza. Los valores con `$$` son escapes para que Grafana, y no Docker Compose, evalue las variables de plantilla.

## Dashboard

`provisioning/dashboards/dashboards.yaml` registra un proveedor de tipo archivo llamado `App observabilidad`. Carga los JSON de `/var/lib/grafana/dashboards` en la carpeta `App Etapa 1`, revisandolos cada 10 segundos. `disableDeletion: false` permite eliminar dashboards que ya no figuren en el aprovisionamiento.

El archivo `dashboards/app-overview.json` define el dashboard entregado con el stack. Para cambios reproducibles, edite el JSON y no solo el dashboard desde la interfaz web.

## Acceso

Compose publica Grafana en `http://localhost:3000`. Las credenciales iniciales se leen de `GRAFANA_ADMIN_USER` y `GRAFANA_ADMIN_PASSWORD`; vea `.env.example`. El registro de usuarios esta deshabilitado. Cambie las credenciales antes de compartir el entorno.
