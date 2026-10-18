#!/usr/bin/env bash
# shellcheck disable=SC2029  # $SHA is meant to expand on the client side
# Deploy the committed HEAD to the VPS (run on the dev machine).
#   infra/deploy/bin/deploy.sh <ssh-host> [--web]
# <ssh-host> = an ~/.ssh/config alias of the admin user (e.g. "unzeen-vps").
# Ships only core/ adapters/ web/ infra/ of HEAD via `git archive` (no .env, no node_modules,
# no internal docs), then runs `sudo unzeenctl deploy <sha>` on the VPS:
# build images there -> migrate + schema check + roles -> restart -> proxy check.
set -euo pipefail
HOST="${1:-}"; MODE="${2:-}"
[ -n "$HOST" ] || { echo "usage: $0 <ssh-host> [--web]" >&2; exit 2; }
cd "$(git rev-parse --show-toplevel)"
if ! git diff --quiet HEAD -- core adapters web infra || [ -n "$(git ls-files --others --exclude-standard -- core adapters web infra)" ]; then
  echo "refusing: uncommitted changes in core/ adapters/ web/ infra/ (deploy ships HEAD only; commit first)" >&2
  exit 1
fi
SHA="$(git rev-parse --short=12 HEAD)"
echo "deploying $SHA to $HOST"
if ssh "$HOST" "test -d /opt/unzeen/releases/$SHA"; then
  echo "release $SHA already on the VPS"
else
  git archive --format=tar HEAD core adapters web infra | ssh "$HOST" "sudo /usr/local/sbin/unzeenctl receive $SHA"
fi
ssh -t "$HOST" "sudo /usr/local/sbin/unzeenctl deploy $SHA $MODE"
