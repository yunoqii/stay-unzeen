#!/usr/bin/env bash
# Offline checks of infra/pg-mainnet.sh guards (no Docker needed): bash infra/tests/pg-mainnet.test.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
S=infra/pg-mainnet.sh
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
printf 'POSTGRES_PASSWORD=x\nDATABASE_URL=postgres://u:p@127.0.0.1:55433/unzeen\nDATABASE_URL_RELAYER=postgres://r:p@127.0.0.1:55433/unzeen\n' > "$T/main.env"
fail=0
expect() { # expect <substring> <cmd...>: command must fail and print the substring
  local want="$1"; shift
  local out; out="$("$@" 2>&1)"; local rc=$?
  if [ $rc -eq 0 ] || [[ "$out" != *"$want"* ]]; then echo "FAIL: $* -> rc=$rc out=$out"; fail=1; else echo "ok: $want"; fi
}
bash -n "$S" || { echo "FAIL: syntax"; fail=1; }
expect "usage:" env UNZEEN_PG_ENV_FILE="$T/main.env" bash "$S" bogus
expect "usage:" env UNZEEN_PG_ENV_FILE="$T/main.env" bash "$S" --hood bogus
expect "not found" env UNZEEN_PG_ENV_FILE="$T/missing.env" bash "$S" status
expect "55432 is the devnet" env UNZEEN_PG_ENV_FILE="$T/main.env" POSTGRES_PORT_HOOD=55432 bash "$S" --hood status
# Hood roles with the Solana-mainnet URLs (55433) sourced into the shell: refused before touching Docker.
expect "points at port 55433, this instance (unzeen-hood) is 55434" env UNZEEN_PG_ENV_FILE="$T/main.env" \
  DATABASE_URL=postgres://u:p@127.0.0.1:55433/unzeen bash "$S" --hood roles
# Solana-mainnet roles with hood URLs sourced: refused too.
expect "this instance (unzeen-main) is 55433" env UNZEEN_PG_ENV_FILE="$T/main.env" \
  DATABASE_URL=postgres://u:p@127.0.0.1:55434/unzeen bash "$S" roles
# Process env (hood.env sourced) wins over the file and is checked too.
expect "DATABASE_URL_RELAYER points at port 55433" env UNZEEN_PG_ENV_FILE="$T/main.env" \
  DATABASE_URL=postgres://u:p@127.0.0.1:55434/unzeen DATABASE_URL_RELAYER=postgres://r:p@127.0.0.1:55433/unzeen \
  bash "$S" --hood roles
exit $fail
