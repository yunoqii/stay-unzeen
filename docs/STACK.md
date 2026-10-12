# Unzeen — стек

Пункты с «⚠ проверить» — задача analyst на день 1–2.

## Zcash
| Слой | Что | Зачем |
|---|---|---|
| Нода | **Zebra** (`zebrad`) testnet | Источник блоков |
| Light-сервер | **lightwalletd** (gRPC); альтернатива **Zaino** ⚠ проверить готовность | Compact-блоки для сканера |
| Кошелёк пула | **librustzcash**: `zcash_client_backend`, `zcash_client_sqlite`, `zcash_keys`, `orchard` | Скан, расшифровка memo, отправка shielded |
| Образец кода | **zcash-devtool** | Примеры скана/отправки |
| Пул | **Orchard** (Halo2) | Без trusted setup |
| ZIP | 316 (UA), 302 (memo), **321** (URI/QR), 317 (комиссии), 32 (ключи) | Совместимость |
| Кошелёк юзера | **ZODL**; тесты — zingo-cli / zcash-devtool на testnet; фаусет ⚠ проверить | Оплата по QR |
| Roadmap | **FROST** (`frost-core`, `reddsa`) | t-of-n ключ пула |

## Мост
- **NEAR Intents 1Click API** — пакетный ZEC → SOL. ⚠ testnet, скорее всего, нет.
- Курс ZEC/SOL — котировка 1Click или Pyth.

## Solana
| Что | Зачем |
|---|---|
| `@solana/web3.js` / `@solana/kit` | Транзакции vault |
| `@pump-fun/pump-sdk` ⚠ проверить актуальность | create/buy/sell, PumpSwap |
| `@meteora-ag/dynamic-bonding-curve-sdk` | Адаптер Meteora DBC |
| Jupiter Swap API | Вторичка ⚠ маршрутизация токенов на кривой |
| Jito block engine | Атомарный create+buy (fair-launch) |
| Helius RPC + webhooks | RPC и события для ленты |

## Криптография
- drand **tlock** (`tlock-js` на фронте) — заявки fair-launch.
- anon-ключ: BIP-39 (`@scure/bip39`) → ed25519 (`@noble/curves`), шифрование в браузере через WebCrypto.

## Сервисы
- **core** (Rust): `axum` (REST + WS), `tokio`, `sqlx` + Postgres.
- **relayer** (TS, Node/Bun): очередь в Postgres → адаптеры.
- **web**: Next.js — см. `docs/FRONTEND.md` (shadcn/ui, Motion, Phosphor, Geist, lightweight-charts).
- **infra**: docker-compose — `zebrad`, `lightwalletd`, `postgres`.

## Поток
```
ZODL → shielded ZEC + memo → Zebra → lightwalletd → core (librustzcash)
     → Postgres (реестр, очередь) → relayer → pump.fun / Meteora / Jupiter / Jito
     → Helius → core → WebSocket → web: «unzeen купил…»
```
