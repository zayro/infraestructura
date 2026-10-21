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

BOOT = zitadel/bootstrap
# Token de la cuenta de servicio demo-service (client_credentials); las credenciales las genera zitadel-setup
TOKEN_CMD = curl -s -X POST http://localhost:7000/oauth/v2/token -d "grant_type=client_credentials&client_id=$$(sed -nE 's/.*"clientId":"([^"]+)".*/\1/p' $(BOOT)/demo-service.json)&client_secret=$$(sed -nE 's/.*"clientSecret":"([^"]+)".*/\1/p' $(BOOT)/demo-service.json)&scope=openid urn:zitadel:iam:org:project:id:$$(sed -nE 's/.*"projectId":"([^"]+)".*/\1/p' $(BOOT)/project.json):aud urn:zitadel:iam:org:projects:roles" | sed -E 's/.*"access_token":"([^"]+)".*/\1/'

token:
	@$(TOKEN_CMD)

test-ok:
	curl -H "Authorization: Bearer $$($(TOKEN_CMD))" "http://localhost:8000/api/node?delay_ms=150&fail=0"

test-fail:
	curl -i -H "Authorization: Bearer $$($(TOKEN_CMD))" "http://localhost:8000/api/node?delay_ms=100&fail=1"
