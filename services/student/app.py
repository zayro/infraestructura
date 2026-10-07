import os
import time

from flask import Flask, jsonify, request
from opentelemetry import trace
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

from telemetry import setup_telemetry, structured_log

SERVICE_NAME = os.getenv("SERVICE_NAME", "student-service")
PORT = int(os.getenv("SERVICE_PORT", "8081"))

tracer, logger = setup_telemetry(SERVICE_NAME)
app = Flask(__name__)
FlaskInstrumentor().instrument_app(app)

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
            "student": "/students/U00185589",
            "metrics": "/metrics",
            "live": "/health/live",
            "ready": "/health/ready",
        },
        trace_id=current_trace_id(),
    )


@app.get("/api/demo")
def demo():
    return lookup_student(request.args.get("student_id", "U00185589"), "/api/demo")


@app.get("/students/<student_id>")
def student(student_id):
    return lookup_student(student_id, "/students/:id")


def lookup_student(student_id, route):
    started = time.perf_counter()
    status = 200

    try:
        delay_ms = max(0, min(int(request.args.get("delay_ms", "100")), 2000))
    except ValueError:
        delay_ms = 100

    force_fail = request.args.get("fail", "0") == "1"

    try:
        with tracer.start_as_current_span("student.business_lookup") as span:
            span.set_attribute("student.id", student_id)
            span.set_attribute("demo.delay_ms", delay_ms)
            time.sleep(delay_ms / 1000)

            if force_fail:
                status = 500
                structured_log(logger, "student_lookup_simulated_error", student_id=student_id)
                return jsonify(
                    ok=False,
                    service=SERVICE_NAME,
                    trace_id=current_trace_id(),
                    error="Error simulado para validar observabilidad.",
                ), status

            structured_log(logger, "student_lookup_ok", student_id=student_id, delay_ms=delay_ms)
            return jsonify(
                ok=True,
                service=SERVICE_NAME,
                trace_id=current_trace_id(),
                student={
                    "id": student_id,
                    "name": "Estudiante Demo",
                    "status": "ACTIVO",
                },
            )
    finally:
        REQUESTS.labels(SERVICE_NAME, route, str(status)).inc()
        DURATION.labels(SERVICE_NAME, route).observe(time.perf_counter() - started)


@app.get("/metrics")
def metrics():
    return generate_latest(), 200, {"Content-Type": CONTENT_TYPE_LATEST}


@app.get("/health/live")
def live():
    return jsonify(status="UP", service=SERVICE_NAME)


@app.get("/health/ready")
def ready():
    return jsonify(status="UP", service=SERVICE_NAME)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, threaded=True)
