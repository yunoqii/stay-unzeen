#!/usr/bin/env bash
# Extra Postgres instances for MAINNET (the ledger is not split by network or chain; infra/README.md).
# Own compose project per instance => own container and volume. Never prints secrets.
#   infra/pg-mainnet.sh [--hood] up | down | psql | roles | status
#     (default)  Solana mainnet: project unzeen-main, 127.0.0.1:${POSTGRES_PORT_MAINNET:-55433}
#     --hood     Robinhood Chain mainnet (GAP-10): project unzeen-hood, 127.0.0.1:${POSTGRES_PORT_HOOD:-55434}
# Role passwords: DATABASE_URL_RELAYER / DATABASE_URL_INDEXER from the process environment if set
# (e.g. after `set -a; . ~/.unzeen/hood.env; set +a`), else from the env file
# (UNZEEN_PG_ENV_FILE, default .env). POSTGRES_PASSWORD etc. come from the same env file.
set -euo pipefail
cd "$(dirname "$0")/.."
INSTANCE=main
if [ "${1:-}" = "--hood" ]; then INSTANCE=hood; shift; fi
ENV_FILE="${UNZEEN_PG_ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || { echo "env file $ENV_FILE not found (set UNZEEN_PG_ENV_FILE)" >&2; exit 2; }
case "$INSTANCE" in
  main) PROJECT=unzeen-main; PORT="${POSTGRES_PORT_MAINNET:-55433}";;
  hood) PROJECT=unzeen-hood; PORT="${POSTGRES_PORT_HOOD:-55434}";;
esac
# Never the devnet instance (55432, project unzeen): a mix-up would put mainnet rows next to devnet ones.
if [ "$PORT" = "55432" ]; then echo "refusing: port 55432 is the devnet Postgres" >&2; exit 2; fi
dc() { POSTGRES_PORT="$PORT" docker compose -p "$PROJECT" -f infra/docker-compose.yml --env-file "$ENV_FILE" "$@"; }
# One variable: process environment first, else the env file. Never echoed.
envval() {
  local v="${!1:-}"
  if [ -n "$v" ]; then printf '%s' "$v"; return; fi
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true
}
user() { v="$(envval POSTGRES_USER)"; echo "${v:-unzeen}"; }
db() { v="$(envval POSTGRES_DB)"; echo "${v:-unzeen}"; }
pw_of() { # password of a postgres:// URL variable (URL-decoded)
  local url; url="$(envval "$1")"
  [ -n "$url" ] || { echo "$1 is not set" >&2; exit 2; }
  node -e 'const u=new URL(process.argv[1]);process.stdout.write(decodeURIComponent(u.password))' "$url"
}
# URL variables exported in the process environment (a sourced main.env / hood.env) must point at
# THIS instance's port: a mix-up means the services use another database than the roles go to.
# Values read from the env file are only a password source (same passwords as devnet) and not checked.
check_port() {
  local url="${!1:-}"
  [ -z "$url" ] && return 0
  local p; p="$(node -e 'const u=new URL(process.argv[1]);process.stdout.write(u.port||"5432")' "$url")"
  if [ "$p" != "$PORT" ]; then echo "refusing: $1 points at port $p, this instance ($PROJECT) is $PORT" >&2; exit 2; fi
}
case "${1:-}" in
  up) dc up -d postgres && echo "$INSTANCE mainnet Postgres on 127.0.0.1:$PORT (project $PROJECT)";;
  down) dc stop postgres;;
  psql) dc exec postgres psql -U "$(user)" -d "$(db)";;
  status) dc ps postgres;;
  roles)
    for v in DATABASE_URL DATABASE_URL_RELAYER DATABASE_URL_INDEXER; do check_port "$v"; done
    dc exec -T postgres psql -v ON_ERROR_STOP=1 -U "$(user)" -d "$(db)" -v pw="'$(pw_of DATABASE_URL_RELAYER)'" < infra/relayer-role.sql >/dev/null
    if [ "$INSTANCE" = main ] || [ -n "$(envval DATABASE_URL_INDEXER)" ]; then
      dc exec -T postgres psql -v ON_ERROR_STOP=1 -U "$(user)" -d "$(db)" -v pw="'$(pw_of DATABASE_URL_INDEXER)'" < infra/indexer-role.sql >/dev/null
    fi
    echo "roles applied on $PROJECT (127.0.0.1:$PORT); run again after new migrations";;
  *) echo "usage: $0 [--hood] up|down|psql|status|roles" >&2; exit 2;;
esac
