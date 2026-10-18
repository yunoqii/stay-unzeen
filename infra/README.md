# infra

## TL;DR

- **Postgres** (ledger) runs from `docker-compose.yml`, bound to `127.0.0.1` only.
- **Zcash** is reached through **public lightwalletd** servers; there is no local node. H1: the scanner downloads **every** Orchard/Ironwood transaction of each scanned block (random order, `UNZEEN_COVER_RPS`/`UNZEEN_COVER_CONCURRENCY`, backoff), so the server cannot tell which ones are deposits to the pool. Mainnet cost (12.10): ~2.2 shielded tx and ~25 KiB per block (~28 MiB/day).

| Network | Primary (checked 2026-10-12) | Fallbacks |
|---|---|---|
| testnet | `https://testnet.zec.rocks:443` (lightwalletd v0.5.4, NU7) | none working today (`zaino.testnet.unsafe.zec.rocks` answers 503) |
| mainnet | `https://zec.rocks:443` | `https://na.zec.rocks:443`, `https://eu.zec.rocks:443` (both pass `probe`) |

The scanner tries the primary, then each fallback, and accepts a server only if
`GetLightdInfo.chainName` matches `UNZEEN_NETWORK`. Override with `LIGHTWALLETD_URL` /
`LIGHTWALLETD_FALLBACK_URLS` (see `/.env.example`).

Roadmap: self-hosted node or Tor for the lightwalletd connection (the operator sees the pool's IP and fetched txids).

## Postgres

```bash
cp .env.example .env    # set POSTGRES_PASSWORD (openssl rand -hex 16) and DATABASE_URL
docker compose -f infra/docker-compose.yml --env-file .env up -d postgres
```

- Port: `POSTGRES_PORT` (default 55432) on 127.0.0.1.
- Migrations are embedded in `core/` (compile time) and applied automatically by `unzeen-scanner serve` and `unzeen-api serve`. Rebuild both binaries after pulling a new migration.
- Docker logs are rotated (`json-file`, 10 MB x 3). Postgres runs with `log_error_verbosity=terse`, no statement/connection logging: row values from constraint errors (DETAIL) and client IPs never reach the container log.
- Relayer role (least privilege, cannot read `action_id`, balances, deposits): `infra/relayer-role.sql` (idempotent; re-run after new migrations), contract in `docs/RELAYER.md`. The relayer gets `DATABASE_URL_RELAYER`, never the owner's `DATABASE_URL`.

## VPS deploy (`deploy/`)

One VPS runs everything: web (Next.js prod), Caddy (HTTPS) and three backend instances
(devnet, mainnet, hood), each with its own Postgres, network, env file, keys and state on an
encrypted LUKS volume. Step-by-step: `docs/RUNBOOK.md` section 7 ("Деплой на VPS").

| Path | What |
|---|---|
| `deploy/compose.yml` | the whole stack (profiles `devnet`, `mainnet`, `hood`, `build`) |
| `deploy/Caddyfile` | no access logs, scrubbed error log, no compression on API origins, per-client limits in memory, X-Forwarded-For stripped |
| `deploy/docker/*.Dockerfile` | core (release), adapters, web (`build:public`), caddy (+ratelimit) |
| `deploy/env/*.env.example` | templates of `/etc/unzeen/*.env` (no secrets) |
| `deploy/bin/` | `bootstrap.sh`, `unzeen-vault-init`/`unzeen-unlock`/`unzeen-lock`, `unzeenctl`, `unzeen-monitor`, `deploy.sh` |
| `deploy/tests/deploy.test.sh` | offline checks: shellcheck, compose config + invariants, caddy validate, check-env |

```bash
bash infra/deploy/tests/deploy.test.sh     # offline, needs Docker for compose/caddy/shellcheck
infra/deploy/bin/deploy.sh unzeen-vps      # ship HEAD to the VPS and deploy (after bootstrap)
```

## Separate database per network (mainnet)

The ledger is **not split by network** (`balances`, `deposits`, `actions`, `pool_meta`, …).
Devnet/testnet and mainnet must use **two Postgres instances**. A second compose project gets its
own container and volume (`unzeen-main_pg-data`) from the same file:

```bash
infra/pg-mainnet.sh up          # = POSTGRES_PORT=55433 docker compose -p unzeen-main ... up -d postgres
infra/pg-mainnet.sh psql        # owner psql into the mainnet instance (no secrets printed)
infra/pg-mainnet.sh roles       # apply relayer-role.sql + indexer-role.sql to the mainnet instance
infra/pg-mainnet.sh --hood up   # Robinhood Chain mainnet: project unzeen-hood, 127.0.0.1:55434 (POSTGRES_PORT_HOOD)
infra/pg-mainnet.sh --hood roles  # with hood.env sourced: refuses if DATABASE_URL* point elsewhere
bash infra/tests/pg-mainnet.test.sh  # offline checks of the script guards (no Docker)
```

- Port: `POSTGRES_PORT_MAINNET` (default 55433), same user/password/db name as `.env`.
- In every mainnet terminal set `DATABASE_URL`, `DATABASE_URL_RELAYER`, `DATABASE_URL_INDEXER`
  to port 55433 (on top of `.env`), plus `UNZEEN_NETWORK=main`, `UNZEEN_SOLANA_CLUSTER=mainnet-beta`.
- Guard (core): `unzeen-scanner serve` writes `pool_meta.network`, `pool_meta.solana_cluster` and
  `pool_meta.pool_ua`. The scanner, `unzeen-api serve`, and the manual `verify-snapshot` /
  `stats-snapshot` / `rebalance` commands **refuse to start** on a database that belongs to another
  Zcash network or Solana cluster; the scanner also refuses a different pool wallet (UA) unless
  `UNZEEN_ALLOW_POOL_UA_CHANGE=1`.

## API server (core/api)

```bash
cd core && cargo build --release
./target/release/unzeen-scanner serve      # also publishes the pool UA to Postgres (pool_meta)
./target/release/unzeen-api serve          # API_BIND (default 127.0.0.1:8080)
curl -s localhost:8080/api/pool
# DEV: signed request with an anon key file (hex secret from `unzeen-scanner anon-key`)
./target/release/unzeen-api dev-request --anon-key /path/anon.key                 # GET /api/portfolio
./target/release/unzeen-api dev-request --anon-key /path/anon.key --method POST --path /api/actions \
  --body '{"op":"buy","venue":"pumpfun","mint":"<mint>","zecIn":"200000","minOut":"1"}'
```

Token chat (API v0.12, `UNZEEN_CHAT=1`): create K_chat once per network with
`./target/release/unzeen-api chat-keygen --out /etc/unzeen/<net>-chat.key` (0600, outside the repo,
the database and backups) and set `UNZEEN_CHAT_KEY_FILE`. Moderation never deanonymizes:
`unzeen-api chat hide <id>` | `chat mute --mint <mint> --nick <nick> --hours 24` | `chat purge --mint <mint>`.

Reverse proxy (H9): TLS on this host, `access_log off;` (or a format without `$remote_addr`
and `$request_uri`), no CDN proxy, one origin per network with the API at the root
(no path prefix: the signed request-target must reach the server unchanged), WS upgrade for
`/ws/feed`. The API never reads `X-Forwarded-For`; its per-socket limiter is global behind a
local proxy, so per-client limits belong in the proxy (`limit_req`, in memory).

## Scanner quick reference (core/)

State and keys live in `~/.unzeen/<network>/{data,keys}` (Solana pool) and `~/.unzeen/hood-<network>/{data,keys}` (Robinhood Chain pool, `UNZEEN_CHAIN=hood`), 0700/0600, not in the repo. `data/chain` records the owner instance; a wallet of the other chain is refused.

```bash
cd core && cargo build --release
B=./target/release/unzeen-scanner
$B seed-keygen --out ~/.unzeen/seed.agekey     # once; set UNZEEN_SEED_KEY_FILE in .env
$B init                       # encrypted seed + wallet, prints the pool UA
$B seed-encrypt               # migrate a legacy plaintext keys/pool.mnemonic
$B serve                      # service: sync + credit deposits into Postgres (no deposit data in logs)
$B serve --payouts            # + withdraw_zec executor (needs UNZEEN_SEED_KEY_FILE; mainnet also UNZEEN_ALLOW_MAINNET_SEND=1). Use the release build: proving takes ~80 s in debug
$B probe --blocks 100         # read-only H1 traffic probe (no wallet): fetches all shielded txs of the last N blocks
$B ledger-stats               # deposit counts by status
$B wallet-balance             # pool wallet: spendable / pending (K confirmations), no addresses
$B serve --rebalance          # + automatic ZEC->SOL rebalance via NEAR Intents 1Click (RELAYER.md v7);
                              #   dry-run (quotes only) unless mainnet + UNZEEN_ALLOW_MAINNET_REBALANCE=1
$B rebalance quote            # read-only dry 1Click quote of the lot (mainnet params) + price check
$B rebalance check | status   # trigger evaluation / journal
$B rebalance plan [--force] [--now] | close <id> --status failed|done|refunded   # operator
$B probe                      # read-only health check of the lightwalletd

# dev only (print deposit data; refused on mainnet unless UNZEEN_DEV_PRINT=1)
$B sync [--watch 20] | deposits | inspect-tx <txid>
$B anon-key --out /tmp/anon.key && $B memo-deposit --anon-key /tmp/anon.key
$B balance <anon_pubkey_b58>
$B send --to <ua> --amount-zat 1000000 --memo '<unz1:...>'   # mainnet gated; max 0.5 TAZ testnet / 0.05 ZEC mainnet
```
