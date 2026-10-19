#!/usr/bin/env bash
# Move the devnet stand from the dev Mac to the VPS (RUNBOOK §7.9). Run on the Mac by the owner:
#   infra/deploy/bin/move-devnet.sh <ssh-host>
# Keeps the devnet pool wallet, vaults with devnet SOL, tokens, history and demo anon keys.
# 1. stops the Mac devnet services (two scanners on one wallet = double payouts)
# 2. stops the devnet services on the VPS (pg-devnet stays up)
# 3. copies ~/.unzeen/{test,devnet} into the volume and the four devnet keys into /etc/unzeen/keys/devnet
#    (replaces the unused ones created by `unzeenctl keys devnet`)
# 4. pg_dump on the Mac -> pg_restore into pg-devnet, roles, start services
# Prints no secrets. The dump never touches the VPS disk (streamed into pg_restore).
# shellcheck disable=SC2029  # key name is meant to expand on the client side
set -euo pipefail
HOST="${1:-}"; [ -n "$HOST" ] || { echo "usage: $0 <ssh-host>" >&2; exit 2; }
U="$HOME/.unzeen"
for f in "$U/seed.agekey" "$U/solana-devnet.agekey" "$U/devnet/chat.key" "$U/devnet/scenario.key" "$U/test/data/wallet.sqlite"; do
  [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
done
PG="$(docker ps -q --filter name=unzeen-postgres-1)"; [ -n "$PG" ] || { echo "local postgres container not running" >&2; exit 1; }
say() { printf '[move-devnet] %s\n' "$*"; }
# One multiplexed connection: ufw LIMIT on 22 rejects more than 6 new connections in 30 s.
CM="$(mktemp -d)"; trap 'ssh -o ControlPath="$CM/c" -O exit "$HOST" 2>/dev/null; rm -rf "$CM"' EXIT
ssh() { command ssh -o ControlMaster=auto -o ControlPath="$CM/c" -o ControlPersist=120 "$@"; }

say "stopping Mac devnet services"
pkill -f 'unzeen-scanner serve' || true
pkill -f 'unzeen-api serve' || true
pkill -f 'scripts/relayer-run.ts' || true
pkill -f 'scripts/intel-run.ts' || true
sleep 3
if pgrep -f 'unzeen-scanner serve|unzeen-api serve|scripts/relayer-run.ts|scripts/intel-run.ts' >/dev/null; then
  echo "Mac services still running, stop them and re-run" >&2; exit 1
fi

say "stopping VPS devnet services"
ssh "$HOST" 'sudo unzeenctl stop scanner-devnet relayer-devnet intel-devnet api-devnet >/dev/null'

say "copying state into the encrypted volume"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$U" -czf - --exclude 'devnet/chat.key' --exclude 'devnet/scenario.key' test devnet \
  | ssh "$HOST" 'set -e; d=/srv/unzeen/devnet/home; mountpoint -q /srv/unzeen
      sudo rm -rf "$d/test" "$d/devnet"; sudo tar -xzf - -C "$d" --no-same-owner; sudo chown -R 10001:10001 "$d"'

say "copying devnet keys"
put_key() { # put_key <local file> <name>
  ssh "$HOST" "set -e; umask 077; t=/etc/unzeen/keys/devnet/$2; sudo tee \"\$t.tmp\" >/dev/null
    sudo chown 10001:10001 \"\$t.tmp\"; sudo chmod 0600 \"\$t.tmp\"; sudo mv \"\$t.tmp\" \"\$t\"" < "$1"
}
put_key "$U/seed.agekey" seed.agekey
put_key "$U/solana-devnet.agekey" solana.agekey
put_key "$U/devnet/chat.key" chat.key
put_key "$U/devnet/scenario.key" scenario.key

say "restoring the devnet database"
docker exec "$PG" pg_dump -U unzeen -d unzeen -Fc \
  | ssh "$HOST" 'sudo docker exec -i unzeen-vps-pg-devnet-1 pg_restore -U unzeen -d unzeen --clean --if-exists --no-owner --no-privileges --single-transaction'

say "roles and start"
ssh "$HOST" 'sudo unzeenctl roles devnet && sudo unzeenctl start api-devnet scanner-devnet relayer-devnet intel-devnet >/dev/null'
say "done. Do not start devnet on the Mac again (same wallet)."
