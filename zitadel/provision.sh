#!/bin/sh
# Aprovisiona ZITADEL por API (Management API v1). Idempotente: se puede ejecutar las veces que haga falta.
# Crea: proyecto `demo`, roles, app OIDC `demo-client` (PKCE), usuarios humanos y la cuenta de servicio `demo-service`.
set -eu

BOOT=/bootstrap
log() { echo "[zitadel-setup] $*"; }

for i in $(seq 1 60); do [ -s "$BOOT/admin.pat" ] && break; sleep 1; done
[ -s "$BOOT/admin.pat" ] || { log "no existe $BOOT/admin.pat"; exit 1; }
PAT=$(tr -d '\r\n' < "$BOOT/admin.pat")

# api METODO RUTA [JSON]: ZITADEL resuelve la instancia por el header Host
api() {
  m=$1; p=$2; b=${3:-}
  if [ -n "$b" ]; then
    curl -sS -X "$m" "$ZITADEL_URL$p" -H "Authorization: Bearer $PAT" -H "Host: $ZITADEL_HOST" -H 'Content-Type: application/json' -d "$b"
  else
    curl -sS -X "$m" "$ZITADEL_URL$p" -H "Authorization: Bearer $PAT" -H "Host: $ZITADEL_HOST" -H 'Content-Type: application/json'
  fi
}
need() { [ -n "$1" ] && [ "$1" != null ] || { log "fallo: $2"; exit 1; }; }

# Proyecto
PID=$(api POST /management/v1/projects/_search '{"queries":[{"nameQuery":{"name":"demo","method":"TEXT_QUERY_METHOD_EQUALS"}}]}' | jq -r '.result[0].id // empty')
if [ -z "$PID" ]; then
  PID=$(api POST /management/v1/projects '{"name":"demo","projectRoleAssertion":true}' | jq -r '.id // empty')
fi
need "$PID" "crear proyecto"
log "proyecto demo: $PID"

# Roles
for r in user admin service; do
  api POST "/management/v1/projects/$PID/roles" "{\"roleKey\":\"$r\",\"displayName\":\"$r\"}" >/dev/null || true
done

# App OIDC publica con PKCE para usuarios (Postman / frontends)
APPID=$(api POST "/management/v1/projects/$PID/apps/_search" '{"queries":[{"nameQuery":{"name":"demo-client","method":"TEXT_QUERY_METHOD_EQUALS"}}]}' | jq -r '.result[0].id // empty')
if [ -z "$APPID" ]; then
  APP=$(api POST "/management/v1/projects/$PID/apps/oidc" '{
    "name":"demo-client","appType":"OIDC_APP_TYPE_NATIVE","authMethodType":"OIDC_AUTH_METHOD_TYPE_NONE",
    "responseTypes":["OIDC_RESPONSE_TYPE_CODE"],"grantTypes":["OIDC_GRANT_TYPE_AUTHORIZATION_CODE","OIDC_GRANT_TYPE_REFRESH_TOKEN"],
    "redirectUris":["https://oauth.pstmn.io/v1/callback","http://localhost:8000/callback"],
    "postLogoutRedirectUris":["http://localhost:8000/"],
    "accessTokenType":"OIDC_TOKEN_TYPE_JWT","accessTokenRoleAssertion":true,"idTokenRoleAssertion":true,"devMode":true}')
  CLIENT_ID=$(echo "$APP" | jq -r '.clientId // empty')
  need "$CLIENT_ID" "crear app demo-client"
else
  CLIENT_ID=$(api GET "/management/v1/projects/$PID/apps/$APPID" | jq -r '.app.oidcConfig.clientId // empty')
fi
log "app demo-client (PKCE): $CLIENT_ID"

# ensure_human USUARIO NOMBRE APELLIDO ROLES(json)
ensure_human() {
  uid=$(api POST /management/v1/users/_search "{\"queries\":[{\"userNameQuery\":{\"userName\":\"$1\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}" | jq -r '.result[0].id // empty')
  if [ -z "$uid" ]; then
    uid=$(api POST /management/v1/users/human/_import "{\"userName\":\"$1\",\"profile\":{\"firstName\":\"$2\",\"lastName\":\"$3\",\"displayName\":\"$2 $3\"},\"email\":{\"email\":\"$1@demo.local\",\"isEmailVerified\":true},\"password\":\"$DEMO_USER_PASSWORD\",\"passwordChangeRequired\":false}" | jq -r '.userId // empty')
    need "$uid" "crear usuario $1"
  fi
  api POST "/management/v1/users/$uid/grants" "{\"projectId\":\"$PID\",\"roleKeys\":$4}" >/dev/null || true
  log "usuario $1: $uid"
}
ensure_human demo-user Demo User '["user"]'
ensure_human demo-admin Demo Admin '["user","admin"]'

# Cuenta de servicio (client_credentials, tokens JWT)
SID=$(api POST /management/v1/users/_search '{"queries":[{"userNameQuery":{"userName":"demo-service","method":"TEXT_QUERY_METHOD_EQUALS"}}]}' | jq -r '.result[0].id // empty')
if [ -z "$SID" ]; then
  SID=$(api POST /management/v1/users/machine '{"userName":"demo-service","name":"demo-service","accessTokenType":"ACCESS_TOKEN_TYPE_JWT"}' | jq -r '.userId // empty')
  need "$SID" "crear cuenta demo-service"
fi
api POST "/management/v1/users/$SID/grants" "{\"projectId\":\"$PID\",\"roleKeys\":[\"service\"]}" >/dev/null || true
if [ ! -s "$BOOT/demo-service.json" ]; then
  api PUT "/management/v1/users/$SID/secret" '{}' | jq -c '{clientId, clientSecret}' > "$BOOT/demo-service.json"
  need "$(jq -r '.clientSecret // empty' "$BOOT/demo-service.json")" "generar secreto de demo-service"
fi
log "cuenta de servicio demo-service: $SID (credenciales en zitadel/bootstrap/demo-service.json)"

# Action: aplana los roles del proyecto a un claim `roles` (lista) que oauth2-proxy sabe leer
ACTION_SCRIPT='function flattenRoles(ctx, api) {
  var roles = [];
  var grants = ctx.v1.user.grants;
  if (grants && grants.grants) {
    grants.grants.forEach(function (g) { g.roles.forEach(function (r) { if (roles.indexOf(r) < 0) roles.push(r); }); });
  }
  api.v1.claims.setClaim("roles", roles);
}'
ACTID=$(api POST /management/v1/actions/_search '{"queries":[{"actionNameQuery":{"name":"flattenRoles","method":"TEXT_QUERY_METHOD_EQUALS"}}]}' | jq -r '.result[0].id // empty')
if [ -z "$ACTID" ]; then
  ACTID=$(api POST /management/v1/actions "$(jq -n --arg s "$ACTION_SCRIPT" '{name:"flattenRoles",script:$s,timeout:"10s",allowedToFail:true}')" | jq -r '.id // empty')
  need "$ACTID" "crear action flattenRoles"
fi
# Flujo "Complement Token" (2): pre access token (5) y pre userinfo (4)
for trig in 4 5; do
  api POST "/management/v1/flows/2/trigger/$trig" "{\"actionIds\":[\"$ACTID\"]}" >/dev/null || true
done
log "action flattenRoles: $ACTID"

# Configuracion que lee oauth2-proxy: el id del proyecto va en el claim `aud`
printf 'client_id = "%s"\noidc_groups_claim = "roles"\n' "$PID" > "$BOOT/oauth2-proxy.cfg"
jq -nc --arg p "$PID" --arg c "$CLIENT_ID" '{projectId:$p, demoClientId:$c}' > "$BOOT/project.json"
log "listo"
