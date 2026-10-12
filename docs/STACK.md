# Unzeen — стек

Пункты с «⚠ проверить» — задача analyst на день 1–2.

## Zcash
| Слой | Что | Зачем |
|---|---|---|
| Light-сервер | **Публичный lightwalletd** (`zec.rocks:443` / `testnet.zec.rocks:443`) + запасной. Своей ноды Zebra не ставим | Compact-блоки для сканера |
| Кошелёк пула | **librustzcash**: `zcash_client_backend`, `zcash_client_sqlite`, `zcash_keys`, `orchard` | Скан, расшифровка memo, отправка shielded |
| Образец кода | **zcash-devtool** | Примеры скана/отправки |
| Пул | **Ironwood** (исправленная Orchard, Halo2; Orchard закрыт для депозитов с NU6.3, ZIP 258) | Без trusted setup |
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
| **Helius Free** | только оценка priority fee (фоново) и отправка tx через Helius Sender (SWQOS-only, одинаковые чаевые ~0.000005 SOL на ВСЕХ tx пула) |
| **Shyft Free** | все чтения: warm set, top-10, приманки, подписки на кривые (accountSubscribe). Решение 12.10: чтение и отправка у разных провайдеров |

## Криптография
- drand **tlock** (`tlock-js` на фронте) — заявки fair-launch.
- anon-ключ: BIP-39 (`@scure/bip39`) → ed25519 (`@noble/curves`), шифрование в браузере через WebCrypto.

## Сервисы
- **core** (Rust): `axum` (REST + WS), `tokio`, `sqlx` + Postgres.
- **relayer** (TS, Node/Bun): очередь в Postgres → адаптеры.
- **web**: Next.js — см. `docs/FRONTEND.md` (shadcn/ui, Motion, Phosphor, Geist, lightweight-charts).
- **infra**: docker-compose — `postgres` (своей ноды нет).

## Поток
```
ZODL → shielded ZEC + memo → публичный lightwalletd → core (librustzcash)
     → Postgres (реестр, очередь) → relayer → pump.fun / Meteora / Jupiter / Jito
     → Helius → core → WebSocket → web: «unzeen купил…»
```
