# infra

## TL;DR

`core/` does **not** need a local node. By default it talks to a public lightwalletd:

| Network | Endpoint (checked 2026-10-12) | Backend |
|---|---|---|
| testnet | `https://testnet.zec.rocks:443` | lightwalletd v0.5.4 / Zebra 7.0.0-rc.0, NU7 (branch `0x77190AD9`) |
| mainnet | `https://zec.rocks:443` | lightwalletd v0.5.3 / Zebra 6.3.0, NU6.3 (Ironwood) |

Set `UNZEEN_NETWORK` and optionally `LIGHTWALLETD_URL` in `.env` (see `/.env.example`).

## docker-compose

```bash
cp .env.example .env            # set POSTGRES_PASSWORD
# Postgres only (ledger / queue), bound to 127.0.0.1:
docker compose -f infra/docker-compose.yml --env-file .env up -d postgres
# Self-hosted zebrad + lightwalletd (optional):
docker compose -f infra/docker-compose.yml --env-file .env --profile node up -d
docker compose -f infra/docker-compose.yml --env-file .env logs -f zebra
# then: LIGHTWALLETD_URL=http://127.0.0.1:9067
```

- `zebrad` **>= 7.0.0-rc.0** is required on testnet (NU7 activated at height 4,465,026). 6.x follows the wrong chain.
- Mainnet node: `ZEBRA_NETWORK=Mainnet`, `ZEBRA_RPC_PORT=8232`, `ZEBRA_P2P_PORT=8233`.
- lightwalletd gRPC is plaintext and bound to `127.0.0.1:9067` only. Zebra RPC is not published to the host.
- Images are `linux/amd64`. On Apple Silicon they run under emulation, which is slow.

### Disk and time

| | Testnet | Mainnet |
|---|---|---|
| Zebra state | ~10 GB (ZF snapshot 11.3 GiB; unpacking needs ~2x) | ~300+ GB |
| lightwalletd cache | a few GB | tens of GB |
| RAM | >= 4 GB (16 GB recommended) | 16 GB |
| Full sync from genesis | hours to a day (not measured) | days |

On the dev machine (27 GB free) a local sync is **not** practical. Use the public endpoints.
Caveat from analyst: the latest ZF testnet snapshot (07.10, zebrad 6.3.0, height 4,468,596)
may sit on the non-NU7 fork. If you use it, compare a block hash above 4,465,026 against testnet.zec.rocks.

## Privacy note

The lightwalletd operator sees the pool's IP and which txids we `GetTransaction` (enhancement).
For the demo this is acceptable; production should self-host (this compose) or use Tor.

## Scanner quick reference (core/)

```bash
cd core && cargo build --release
B=./target/release/unzeen-scanner
UNZEEN_NETWORK=test $B init            # seed -> keys/pool.mnemonic (0600), prints UA + UFVK
UNZEEN_NETWORK=test $B sync            # sync to tip, fetch full txs, print new deposits (+memo)
UNZEEN_NETWORK=test $B sync --watch 20 # keep polling
UNZEEN_NETWORK=test $B deposits [--json]
UNZEEN_NETWORK=test $B inspect-tx <txid>   # decrypt a tx from lightwalletd with the pool keys
UNZEEN_NETWORK=test $B probe           # read-only: parse recent shielded txs (health check)
UNZEEN_NETWORK=test $B send --to <ua> --amount-zat 1000000 --memo 'hello'   # mainnet gated
```
