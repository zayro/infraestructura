import os
import time

import requests
from flask import Flask, jsonify, request
from opentelemetry import trace
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

from telemetry import setup_telemetry, structured_log

SERVICE_NAME = os.getenv("SERVICE_NAME", "gateway-service")
PORT = int(os.getenv("SERVICE_PORT", "8080"))
STUDENT_SERVICE_URL = os.getenv("STUDENT_SERVICE_URL", "http://student-service:8081").rstrip("/")

tracer, logger = setup_telemetry(SERVICE_NAME)
app = Flask(__name__)
FlaskInstrumentor().instrument_app(app)
RequestsInstrumentor().instrument()

REQUESTS = Counter(
    "demo_http_requests_total",
    "Total de solicitudes HTTP del demo",
    ["service", "route", "status"],
)
DURATION = Histogram(
    "demo_http_request_duration_seconds",
    "Duracion de solicitudes HTTP del demo",
    ["service", "route"],
)


def current_trace_id():
    ctx = trace.get_current_span().get_span_context()
    return format(ctx.trace_id, "032x") if ctx.is_valid else None


@app.get("/")
def index():
    return jsonify(
        service=SERVICE_NAME,
        endpoints={
            "demo": "/api/demo?student_id=U00185589&delay_ms=100&fail=0",
            "metrics": "/metrics",
            "live": "/health/live",
            "ready": "/health/ready",
        },
        trace_id=current_trace_id(),
    )


@app.get("/api/demo")
def demo():
    started = time.perf_counter()
    route = "/api/demo"
    status = 500
    student_id = request.args.get("student_id", "U00185589")
    delay_ms = request.args.get("delay_ms", "100")
    fail = request.args.get("fail", "0")

    try:
        with tracer.start_as_current_span("gateway.student_lookup") as span:
            span.set_attribute("student.id", student_id)
            structured_log(logger, "student_lookup_started", student_id=student_id)

            response = requests.get(
                f"{STUDENT_SERVICE_URL}/students/{student_id}",
                params={"delay_ms": delay_ms, "fail": fail},
                timeout=3,
            )
            status = response.status_code
            response.raise_for_status()
            student = response.json()

            structured_log(
                logger,
                "student_lookup_completed",
                student_id=student_id,
                downstream_status=status,
            )

        return jsonify(
            ok=True,
            service=SERVICE_NAME,
            trace_id=current_trace_id(),
            student=student,
        )
    except requests.RequestException as exc:
        structured_log(
            logger,
            "student_lookup_failed",
            student_id=student_id,
            error_type=type(exc).__name__,
        )
        return jsonify(
            ok=False,
            service=SERVICE_NAME,
            trace_id=current_trace_id(),
            error="No fue posible consultar el microservicio de estudiantes.",
        ), 502
    finally:
        duration = time.perf_counter() - started
        REQUESTS.labels(SERVICE_NAME, route, str(status if status != 500 else 502)).inc()
        DURATION.labels(SERVICE_NAME, route).observe(duration)


@app.get("/metrics")
def metrics():
    return generate_latest(), 200, {"Content-Type": CONTENT_TYPE_LATEST}


@app.get("/health/live")
def live():
    return jsonify(status="UP", service=SERVICE_NAME)


@app.get("/health/ready")
def ready():
    try:
        response = requests.get(f"{STUDENT_SERVICE_URL}/health/live", timeout=1)
        response.raise_for_status()
        return jsonify(status="UP", service=SERVICE_NAME, dependencies={"student-service": "UP"})
    except requests.RequestException:
        return jsonify(status="DOWN", service=SERVICE_NAME, dependencies={"student-service": "DOWN"}), 503


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, threaded=True)
