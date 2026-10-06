.PHONY: up down reset ps logs traefik-logs test-ok test-fail

up:
	docker compose up -d --build

down:
	docker compose down

reset:
	docker compose down -v

ps:
	docker compose ps

logs:
	docker compose logs -f traefik gateway student-service otel-collector

traefik-logs:
	docker compose logs -f traefik

test-ok:
	curl "http://localhost/api/demo?student_id=U00185589&delay_ms=150&fail=0"

test-fail:
	curl -i "http://localhost/api/demo?student_id=U00185589&delay_ms=100&fail=1"
