#!/usr/bin/env sh
# Testa as regras do banco num PostgreSQL 16 vazio: stubs do Supabase + schema + seed + testes.
# Uso: DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres supabase/tests/run.sh
# Local com Docker:
#   docker run --rm -d --name petsos-pg -e POSTGRES_HOST_AUTH_METHOD=trust -v "$PWD":/w postgres:16
#   docker exec -e DATABASE_URL=postgres://postgres@localhost/postgres petsos-pg sh /w/supabase/tests/run.sh
#   docker rm -f petsos-pg
set -e
dir=$(dirname "$0")
for f in "$dir/stubs.sql" "$dir/../schema.sql" "$dir/../seed.sql" "$dir/rules_test.sql"; do
  psql "$DATABASE_URL" -q -X -o /dev/null -v ON_ERROR_STOP=1 -f "$f"
done
