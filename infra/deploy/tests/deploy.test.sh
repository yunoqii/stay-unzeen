#!/usr/bin/env bash
# shellcheck disable=SC2015  # ok/bad always return 0, so A && ok || bad is safe here
# Offline checks of infra/deploy (no VPS, no secrets): bash infra/deploy/tests/deploy.test.sh
#   - bash syntax + shellcheck (local binary or koalaman/shellcheck image)
#   - docker compose config with the env templates (all profiles)
#   - compose invariants: only Caddy publishes on 0.0.0.0, relayer/indexer never get the owner DB URL,
#     state mounts never auto-create host paths
#   - caddy validate (custom image with caddy-ratelimit, if Docker is available)
#   - unzeenctl check-env: refuses templates, accepts filled env + key files
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2     # infra/
D=deploy
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "ok: $*"; }
bad() { echo "FAIL: $*"; fail=1; }
SCRIPTS=("$D"/bin/bootstrap.sh "$D"/bin/deploy.sh "$D"/bin/unzeen-vault-init "$D"/bin/unzeen-unlock "$D"/bin/unzeen-lock "$D"/bin/unzeenctl "$D"/bin/unzeen-monitor)

for s in "${SCRIPTS[@]}"; do bash -n "$s" || bad "syntax $s"; done
ok "bash -n"

if command -v shellcheck >/dev/null; then
  shellcheck -x -S style "${SCRIPTS[@]}" && ok shellcheck || bad shellcheck
elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  docker run --rm -v "$PWD:/mnt:ro" -w /mnt koalaman/shellcheck:stable -x -S style "${SCRIPTS[@]}" && ok "shellcheck (docker)" || bad shellcheck
else
  echo "skip: shellcheck (no binary, no docker)"
fi

# Env dir from the templates.
for f in stack devnet mainnet hood; do cp "$D/env/$f.env.example" "$T/$f.env"; done
sed -i.bak "s#^UNZEEN_ETC=.*#UNZEEN_ETC=$T#" "$T/stack.env" && rm -f "$T/stack.env.bak"

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  dc() { docker compose -p unzeen-vps -f "$D/compose.yml" --env-file "$T/stack.env" "$@"; }
  dc --profile devnet --profile mainnet --profile hood --profile build config --quiet && ok "compose config" || bad "compose config"
  dc --profile devnet --profile mainnet --profile hood config --format json > "$T/c.json" 2>/dev/null
  python3 - "$T/c.json" <<'PY' && ok "compose invariants" || bad "compose invariants"
import json, sys
svc = json.load(open(sys.argv[1]))["services"]
errs = []
for name, s in svc.items():
    for p in s.get("ports", []):
        if name != "caddy" and p.get("host_ip") != "127.0.0.1":
            errs.append(f"{name}: port {p.get('published')} not on 127.0.0.1")
    for v in s.get("volumes", []):
        src = v.get("source", "")
        if v.get("type") == "bind" and not src.endswith("/Caddyfile") and v.get("bind", {}).get("create_host_path", True):
            errs.append(f"{name}: {src} may be auto-created on the unencrypted disk")
    env = s.get("environment", {}) or {}
    if name.startswith(("relayer-", "intel-")) and env.get("DATABASE_URL"):
        errs.append(f"{name}: gets the owner DATABASE_URL")
    if name.startswith("intel-") and env.get("DATABASE_URL_RELAYER"):
        errs.append(f"{name}: gets DATABASE_URL_RELAYER")
    if name.startswith(("api-", "scanner-")) and env.get("UNZEEN_DEV_PRINT"):
        errs.append(f"{name}: UNZEEN_DEV_PRINT set")
    if name.startswith(("api-", "scanner-", "relayer-", "intel-")) and s.get("user") != "10001:10001":
        errs.append(f"{name}: not running as uid 10001")
for e in errs: print("  " + e)
sys.exit(1 if errs else 0)
PY
  if docker image inspect unzeen-caddy:test >/dev/null 2>&1 || docker build -q -f "$D/docker/caddy.Dockerfile" -t unzeen-caddy:test "$D/docker" >/dev/null; then
    docker run --rm -v "$PWD/$D/Caddyfile:/etc/caddy/Caddyfile:ro" -e WEB_HOST=a.example -e API_DEVNET_HOST=b.example \
      -e API_MAINNET_HOST=c.example -e API_HOOD_HOST=d.example unzeen-caddy:test \
      caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 && ok "caddy validate" || bad "caddy validate"
  else
    echo "skip: caddy image build failed (network?)"
  fi
  grep -qE '^\s*encode' <(awk '/^\(api_site\)/,/^}/' "$D/Caddyfile") && bad "encode inside api_site" || ok "no compression on API origins"
  n_log="$(grep -v '^[[:space:]]*#' "$D/Caddyfile" | grep -cE '^[[:space:]]*log([[:space:]]|$|\{)')"
  [ "$n_log" = 1 ] && ok "no access log in sites (only the global runtime log)" || bad "log directives: $n_log (expected only 'log default')"
else
  echo "skip: docker compose / caddy (no docker)"
fi

# check-env: templates refused, filled env accepted.
mkdir -p "$T/keys"/{devnet,mainnet,hood}
UNZEEN_ETC="$T" bash "$D/bin/unzeenctl" check-env > "$T/out" 2>&1 && bad "check-env accepted templates" || {
  grep -q "SOLANA_RPC_URL_MAINNET" "$T/out" && grep -q "missing $T/keys/hood/hood-evm.agekey" "$T/out" && ok "check-env refuses templates" || { cat "$T/out"; bad "check-env output"; }
}
for f in devnet mainnet hood; do sed -i.bak -E 's/=__(SET|GENERATE)__$/=x/' "$T/$f.env" && rm -f "$T/$f.env.bak"; done
for i in devnet mainnet hood; do
  touch "$T/keys/$i/"{pg-password,chat.key,scenario.key,seed.agekey}
  if [ "$i" = hood ]; then touch "$T/keys/$i/hood-evm.agekey"; else touch "$T/keys/$i/solana.agekey"; fi
done
UNZEEN_ETC="$T" bash "$D/bin/unzeenctl" check-env > "$T/out" 2>&1 && ok "check-env accepts filled env" || { cat "$T/out"; bad "check-env filled"; }
echo 'DEVNET_ZEC_SOL_RATE=11.5' >> "$T/mainnet.env"
UNZEEN_ETC="$T" bash "$D/bin/unzeenctl" check-env > "$T/out" 2>&1 && bad "check-env accepted DEVNET_ZEC_SOL_RATE on mainnet" || ok "check-env refuses devnet rate on mainnet"

exit $fail
