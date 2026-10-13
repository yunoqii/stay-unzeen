#!/usr/bin/env bash
# Second Postgres instance for MAINNET (the ledger is not split by network; infra/README.md).
# Own compose project (unzeen-main) => own container and volume. Never prints secrets.
#   infra/pg-mainnet.sh up | down | psql | roles
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${POSTGRES_PORT_MAINNET:-55433}"
dc() { POSTGRES_PORT="$PORT" docker compose -p unzeen-main -f infra/docker-compose.yml --env-file .env "$@"; }
# Reads one variable from .env without echoing it.
envval() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
user() { v="$(envval POSTGRES_USER)"; echo "${v:-unzeen}"; }
db() { v="$(envval POSTGRES_DB)"; echo "${v:-unzeen}"; }
pw_of() { # password of a postgres:// URL variable in .env (URL-decoded)
  node -e 'const u=new URL(process.argv[1]);process.stdout.write(decodeURIComponent(u.password))' "$(envval "$1")"
}
case "${1:-}" in
  up) dc up -d postgres && echo "mainnet Postgres on 127.0.0.1:$PORT (project unzeen-main)";;
  down) dc stop postgres;;
  psql) dc exec postgres psql -U "$(user)" -d "$(db)";;
  roles)
    dc exec -T postgres psql -v ON_ERROR_STOP=1 -U "$(user)" -d "$(db)" -v pw="'$(pw_of DATABASE_URL_RELAYER)'" < infra/relayer-role.sql >/dev/null
    dc exec -T postgres psql -v ON_ERROR_STOP=1 -U "$(user)" -d "$(db)" -v pw="'$(pw_of DATABASE_URL_INDEXER)'" < infra/indexer-role.sql >/dev/null
    echo "roles applied on the mainnet instance (passwords taken from .env, same as devnet)";;
  *) echo "usage: $0 up|down|psql|roles" >&2; exit 2;;
esac
