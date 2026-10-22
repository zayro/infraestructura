.PHONY: up down reset ps logs traefik-logs token token-admin token-user test-ok test-unauthorized test-fail

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

# Generacion ligera de tokens JWT para pruebas RBAC (zero dependencias externas)
TOKEN_CMD = python scripts/jwt_tool.py generate --sub app-service --roles service
TOKEN_ADMIN_CMD = python scripts/jwt_tool.py generate --sub app-admin --roles admin,user
TOKEN_USER_CMD = python scripts/jwt_tool.py generate --sub app-user --roles user

token:
	@$(TOKEN_CMD)

token-admin:
	@$(TOKEN_ADMIN_CMD)

token-user:
	@$(TOKEN_USER_CMD)

test-ok:
	curl -H "Authorization: Bearer $$($(TOKEN_CMD))" "http://localhost:8000/api/node?delay_ms=150&fail=0"

test-fastapi:
	curl -H "Authorization: Bearer $$($(TOKEN_ADMIN_CMD))" "http://localhost:8000/api/test?delay_ms=50&fail=0"

test-fastify:
	curl -H "Authorization: Bearer $$($(TOKEN_CMD))" "http://localhost:8000/api/node?delay_ms=50&fail=0"

test-public-fastapi:
	curl -i "http://localhost:8000/api/test/public"

test-public-fastify:
	curl -i "http://localhost:8000/api/node/public"

test-public: test-public-fastapi test-public-fastify

test-unauthorized:
	curl -i "http://localhost:8000/api/node"

test-fail:
	curl -i -H "Authorization: Bearer $$($(TOKEN_CMD))" "http://localhost:8000/api/node?delay_ms=100&fail=1"
