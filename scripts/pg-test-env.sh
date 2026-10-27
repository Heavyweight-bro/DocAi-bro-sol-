#!/usr/bin/env bash
# Local Supabase-like stack for integration tests: PostgreSQL + PostgREST (the API supabase-js talks to).
#   scripts/pg-test-env.sh up    → prints SUPABASE-style env for scripts/verify-postgres.mjs
#   scripts/pg-test-env.sh down  → removes the test containers and network
set -euo pipefail
NET=docai-test-net; PG=docai-test-pg; REST=docai-test-postgrest
PG_PORT=${PG_PORT:-55432}; REST_PORT=${REST_PORT:-53000}
JWT_SECRET=${JWT_SECRET:-docai-test-jwt-secret-at-least-32-chars}
cd "$(dirname "$0")/.."
if [[ "${1:-up}" == "down" ]]; then
  docker rm -f "$REST" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "removed"; exit 0
fi
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
docker rm -f "$REST" "$PG" >/dev/null 2>&1 || true
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=pgpw -p 127.0.0.1:${PG_PORT}:5432 postgres:17-alpine >/dev/null
for i in $(seq 1 60); do docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 0.5; done
sleep 1
docker exec -i "$PG" psql -v ON_ERROR_STOP=1 -q -U postgres < scripts/pg/bootstrap.sql
docker exec -i "$PG" psql -v ON_ERROR_STOP=1 -q -U postgres < db/schema.sql
# Running the schema twice proves it is idempotent (upgrade path).
docker exec -i "$PG" psql -v ON_ERROR_STOP=1 -q -U postgres < db/schema.sql
docker run -d --name "$REST" --network "$NET" -p 127.0.0.1:${REST_PORT}:3000 \
  -e PGRST_DB_URI="postgres://authenticator:authpw@${PG}:5432/postgres" -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$JWT_SECRET" postgrest/postgrest:v12.2.3 >/dev/null
for i in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:${REST_PORT}/" && break; sleep 0.5; done
echo "POSTGREST_URL=http://127.0.0.1:${REST_PORT}"
echo "JWT_SECRET=${JWT_SECRET}"
