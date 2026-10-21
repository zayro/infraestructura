-- Base de datos de Keycloak (idempotente). Se ejecuta solo al inicializar el volumen postgres-data;
-- en una instalacion existente, aplicar a mano: docker exec -i demo-postgres psql -U demo -d demo < postgres/init/keycloak.sql
SELECT 'CREATE DATABASE keycloak'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keycloak')\gexec
