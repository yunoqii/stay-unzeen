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

# unzeenctl: helpers must not clobber the caller's loop variable. The first VPS deploy (19.10)
# migrated and applied roles for "hood" three times because dc() used a global "$i", so the
# devnet/mainnet DBs never got unzeen_relayer / unzeen_indexer.
python3 - "$D/bin/unzeenctl" <<'PY' && ok "unzeenctl: loop vars in functions are local" || bad "unzeenctl: function loop var not local"
import re, sys
src = open(sys.argv[1]).read()
errs = []
# Multi-line shell functions only (one-liners close on their own line, python helpers are not bash).
for m in re.finditer(r"^([a-z_]+)\(\) \{([^\n]*)\n(.*?)^\}$", src, re.S | re.M):
    name, head, body = m.group(1), m.group(2), m.group(3)
    if "python3" in head or "}" in head.split("#")[0]:
        continue
    local = set()
    for l in re.findall(r"^\s*local\s+(.*)$", body, re.M):
        local |= {w.split("=")[0] for w in l.split()}
    for v in set(re.findall(r"\bfor\s+([A-Za-z_]+)\s+in\b", body)) - local - {"_"}:
        errs.append(f"{name}(): 'for {v}' without 'local {v}'")
for e in errs: print("  " + e)
sys.exit(1 if errs else 0)
PY
(
  mkdir -p "$T/rel/infra/deploy"; : > "$T/rel/infra/deploy/compose.yml"
  docker() { :; }
  die() { echo "$*" >&2; exit 1; }
  ETC="$T" PROJECT=p INSTANCES=(devnet mainnet hood)
  eval "$(sed -n '/^dc() {/,/^}/p' "$D/bin/unzeenctl")"
  seen=""
  for i in "${INSTANCES[@]}"; do dc "$T/rel" ps; seen+="$i "; done
  [ "$seen" = "devnet mainnet hood " ]
) && ok "unzeenctl: dc() keeps the caller's instance" || bad "unzeenctl: dc() clobbers the caller's \$i"

# Env templates: flag values match what core / adapters compare against (core and the adapters
# only take "1" for most flags; the scanner's clap flags take 1/0 since 19.10).
python3 - "$D"/env/*.env.example <<'PY' && ok "env templates: flag and number formats" || bad "env templates: flag/number format"
import re, sys
one_zero = {"UNZEEN_PAYOUTS", "UNZEEN_REBALANCE", "UNZEEN_CREATE_ENABLED", "UNZEEN_FAIR_LAUNCH", "UNZEEN_CHAT",
    "UNZEEN_SCENARIOS", "UNZEEN_VERIFY_DAILY", "UNZEEN_STATS_DAILY", "UNZEEN_DISCOVERY", "INTEL_DISCOVERY",
    "INTEL_DISCOVERY_LAUNCHLAB", "RELAYER_FEE_SWEEP", "HOOD_FEE_SWEEP", "UNZEEN_ALLOW_MAINNET_SEND",
    "UNZEEN_ALLOW_MAINNET_ACTIONS", "UNZEEN_ALLOW_MAINNET_REBALANCE", "UNZEEN_QUOTE", "UNZEEN_REBALANCE_ZEC_SPL",
    "UNZEEN_INTEL_FULL_TRADES", "NEXT_PUBLIC_HOOD"}
words = {"UNZEEN_ALLOW_MAINNET": {"yes"}, "UNZEEN_ALLOW_HOOD_MAINNET": {"yes"}, "UNZEEN_HOOD": {"on"}}
ints = re.compile(r"^(UNZEEN_CONFIRMATIONS|UNZEEN_MAX_PAYOUT_ZAT|MIN_CLAIM_ZAT|HOOD_VAULTS|HOOD_FUNDERS|"
    r"SOLANA_SEND_MIN_INTERVAL_MS|UNZEEN_REBALANCE_[A-Z_]+_(ZAT|LAMPORTS|SECS)|UNZEEN_REBALANCE_MAX_PER_DAY|"
    r"UNZEEN_PULSE_[A-Z_]+|HOOD_[A-Z_]+_WEI|UNZEEN_QUOTE_(RPS|ROUND_SECS|MAX_MINTS)|ALERT_REPEAT_SECS|[A-Z_]+_MAX_AGE_SECS|RL_[A-Z_]+)$")
nums = re.compile(r"^(API_RL_[A-Z_]+|INTEL_READ_RPS|DEVNET_ZEC_SOL_RATE)$")
errs = []
for path in sys.argv[1:]:
    for n, line in enumerate(open(path), 1):
        line = line.rstrip("\n")
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if v == "":
            continue
        if k in one_zero and v not in ("0", "1"):
            errs.append(f"{path}:{n}: {k}={v} (expected 0 or 1)")
        elif k in words and v not in words[k]:
            errs.append(f"{path}:{n}: {k}={v} (expected {'/'.join(sorted(words[k]))})")
        elif ints.match(k) and not v.isdigit():
            errs.append(f"{path}:{n}: {k}={v} (expected an integer)")
        elif nums.match(k) and not re.fullmatch(r"\d+(\.\d+)?", v):
            errs.append(f"{path}:{n}: {k}={v} (expected a number)")
for e in errs: print("  " + e)
sys.exit(1 if errs else 0)
PY

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

# deploy --web: backend images of the current release get the new tag before current moves (the
# 22.10 --web deploy left current at a tag without unzeen-core/unzeen-adapters, so restarts and
# one-offs tried to pull them from Docker Hub). Stub docker/id/readlink, image store in a file.
mkdir -p "$T/stub" "$T/opt/releases"
cat > "$T/stub/docker" <<'SH'
#!/usr/bin/env bash
store="$STUB_STORE"
case "$1 $2" in
  "image inspect") grep -qx "$3" "$store";;
  "tag "*) grep -qx "$2" "$store" && echo "$3" >> "$store";;
  "compose "*) echo "compose ${*: -3}" >> "$STUB_LOG";;
  *) exit 1;;
esac
SH
printf '#!/bin/sh\necho 0\n' > "$T/stub/id"
cat > "$T/stub/readlink" <<'SH'
#!/bin/sh
[ "$1" = -e ] || exit 1
python3 -c 'import os,sys; p=os.path.realpath(sys.argv[1]); sys.exit(0 if os.path.exists(p) and print(p) is None else 1)' "$2"
SH
chmod +x "$T/stub/"*
for r in aaa1111 bbb2222 ccc3333; do mkdir -p "$T/opt/releases/$r/infra/deploy"; cp "$D/compose.yml" "$T/opt/releases/$r/infra/deploy/"; done
ln -sfn "$T/opt/releases/aaa1111" "$T/opt/current"      # state after a full deploy of aaa1111
printf '%s\n' unzeen-core:aaa1111 unzeen-adapters:aaa1111 unzeen-web:aaa1111 unzeen-caddy:aaa1111 > "$T/store"
ctl() { PATH="$T/stub:$PATH" STUB_STORE="$T/store" STUB_LOG="$T/log" UNZEEN_ETC="$T" UNZEEN_OPT="$T/opt" bash "$D/bin/unzeenctl" "$@"; }
: > "$T/log"
if ctl deploy bbb2222 --web > "$T/out" 2>&1 \
   && grep -qx unzeen-core:bbb2222 "$T/store" && grep -qx unzeen-adapters:bbb2222 "$T/store" \
   && [ "$(basename "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$T/opt/current")")" = bbb2222 ]; then
  ok "deploy --web: backend images tagged with the new release"
else cat "$T/out" "$T/log"; bad "deploy --web: backend tags missing for the new release"; fi
grep -qE '^unzeen-(web|caddy):bbb2222$' "$T/store" && bad "deploy --web: retagged web/caddy (they are built)" || ok "deploy --web: web/caddy not retagged"
# Chained --web (current is itself a --web release) works off the retagged images.
ctl deploy ccc3333 --web > "$T/out" 2>&1 && grep -qx unzeen-core:ccc3333 "$T/store" && grep -qx unzeen-adapters:ccc3333 "$T/store" \
  && ok "deploy --web after --web: backend tags carried over" || { cat "$T/out"; bad "deploy --web after --web"; }
# Missing backend images: abort before build and before current moves.
ln -sfn "$T/opt/releases/aaa1111" "$T/opt/current"
grep -vx unzeen-adapters:aaa1111 "$T/store" > "$T/store2"; mv "$T/store2" "$T/store"
: > "$T/log"
if ctl deploy bbb2222 --web > "$T/out" 2>&1; then bad "deploy --web accepted missing backend images"
elif grep -q "unzeen-adapters:aaa1111" "$T/out" && [ ! -s "$T/log" ] \
   && [ "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$T/opt/current")" = "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$T/opt/releases/aaa1111")" ]; then
  ok "deploy --web refuses missing backend images (no build, current kept)"
else cat "$T/out" "$T/log"; bad "deploy --web missing images: wrong error or current moved"; fi

exit $fail
