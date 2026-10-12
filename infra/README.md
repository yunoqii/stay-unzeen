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

Reverse proxy (H9): TLS on this host, `access_log off;` (or a format without `$remote_addr`
and `$request_uri`), no CDN proxy, one origin per network with the API at the root
(no path prefix: the signed request-target must reach the server unchanged), WS upgrade for
`/ws/feed`. The API never reads `X-Forwarded-For`; its per-socket limiter is global behind a
local proxy, so per-client limits belong in the proxy (`limit_req`, in memory).

## Scanner quick reference (core/)

State and keys live in `~/.unzeen/<network>/{data,keys}` (0700/0600), not in the repo.

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
$B probe                      # read-only health check of the lightwalletd

# dev only (print deposit data; refused on mainnet unless UNZEEN_DEV_PRINT=1)
$B sync [--watch 20] | deposits | inspect-tx <txid>
$B anon-key --out /tmp/anon.key && $B memo-deposit --anon-key /tmp/anon.key
$B balance <anon_pubkey_b58>
$B send --to <ua> --amount-zat 1000000 --memo '<unz1:...>'   # mainnet gated
```
