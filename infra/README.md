# infra

## TL;DR

- **Postgres** (ledger) runs from `docker-compose.yml`, bound to `127.0.0.1` only.
- **Zcash** is reached through **public lightwalletd** servers; there is no local node.

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
- Migrations are embedded in `core/` and applied automatically by `unzeen-scanner serve`.
- Docker logs are rotated (`json-file`, 10 MB x 3).

## Scanner quick reference (core/)

State and keys live in `~/.unzeen/<network>/{data,keys}` (0700/0600), not in the repo.

```bash
cd core && cargo build --release
B=./target/release/unzeen-scanner
$B seed-keygen --out ~/.unzeen/seed.agekey     # once; set UNZEEN_SEED_KEY_FILE in .env
$B init                       # encrypted seed + wallet, prints the pool UA
$B seed-encrypt               # migrate a legacy plaintext keys/pool.mnemonic
$B serve                      # service: sync + credit deposits into Postgres (no deposit data in logs)
$B ledger-stats               # deposit counts by status
$B probe                      # read-only health check of the lightwalletd

# dev only (print deposit data; refused on mainnet unless UNZEEN_DEV_PRINT=1)
$B sync [--watch 20] | deposits | inspect-tx <txid>
$B anon-key --out /tmp/anon.key && $B memo-deposit --anon-key /tmp/anon.key
$B balance <anon_pubkey_b58>
$B send --to <ua> --amount-zat 1000000 --memo '<unz1:...>'   # mainnet gated
```
