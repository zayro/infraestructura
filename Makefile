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
	docker compose logs -f traefik test-fastapi-service test-fastify-service otel-collector

traefik-logs:
	docker compose logs -f traefik

test-ok:
	curl "http://localhost:8000/api/node?delay_ms=150&fail=0"

test-fail:
	curl -i "http://localhost:8000/api/node?delay_ms=100&fail=1"
