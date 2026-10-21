.PHONY: up down reset ps logs traefik-logs token test-ok test-fail

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

TOKEN_CMD = curl -s -X POST http://localhost:7000/realms/demo/protocol/openid-connect/token -d "client_id=demo-client&grant_type=password&username=demo-user&password=demo" | sed -E 's/.*"access_token":"([^"]+)".*/\1/'

token:
	@$(TOKEN_CMD)

test-ok:
	curl -H "Authorization: Bearer $$($(TOKEN_CMD))" "http://localhost:8000/api/node?delay_ms=150&fail=0"

test-fail:
	curl -i -H "Authorization: Bearer $$($(TOKEN_CMD))" "http://localhost:8000/api/node?delay_ms=100&fail=1"
