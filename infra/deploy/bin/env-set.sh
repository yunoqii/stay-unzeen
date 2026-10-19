#!/usr/bin/env bash
# Set NON-SECRET values in /etc/unzeen/<file>.env on the VPS (run on the dev machine by the owner):
#   infra/deploy/bin/env-set.sh <ssh-host> <devnet|mainnet|hood|stack> KEY=VALUE [KEY=VALUE...]
# Replaces an existing KEY= line or appends it, then prints the resulting lines. Never use it for
# secrets (they would land in shell history): edit those with `sudoedit` on the VPS.
# Afterwards: `sudo unzeenctl restart <services>` (recreates containers so the env applies).
# shellcheck disable=SC2029  # FILE is validated and meant to expand on the client side
set -euo pipefail
HOST="${1:-}"; FILE="${2:-}"; shift 2 || true
case "$FILE" in devnet|mainnet|hood|stack) ;; *) echo "usage: $0 <ssh-host> <devnet|mainnet|hood|stack> KEY=VALUE..." >&2; exit 2;; esac
[ -n "$HOST" ] && [ $# -gt 0 ] || { echo "usage: $0 <ssh-host> <file> KEY=VALUE..." >&2; exit 2; }
for kv in "$@"; do
  [[ "$kv" =~ ^[A-Z][A-Z0-9_]*=[A-Za-z0-9._:/,-]*$ ]] || { echo "refusing '$kv': KEY=VALUE with plain characters only" >&2; exit 1; }
done
printf '%s\n' "$@" | ssh "$HOST" "sudo bash -c '
  set -euo pipefail; f=/etc/unzeen/$FILE.env; [ -f \"\$f\" ]; keys=()
  while IFS= read -r kv; do
    k=\${kv%%=*}; keys+=(\"\$k\")
    if grep -q \"^\$k=\" \"\$f\"; then sed -i \"s|^\$k=.*|\$kv|\" \"\$f\"; else printf \"%s\n\" \"\$kv\" >> \"\$f\"; fi
  done
  for k in \"\${keys[@]}\"; do grep \"^\$k=\" \"\$f\"; done'"
