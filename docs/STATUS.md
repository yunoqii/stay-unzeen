# Status

**День 3 / 16** (по плану; фактически 12.10.2026, опережаем). Последняя сводка: `docs/sessions/2026-10-12-1850.md`. Дедлайн: 28.10 23:59 UTC.

## Готово
- Структура команды (CLAUDE.md, агенты), ARCHITECTURE.md, API.md v0
- Репозиторий github.com/yunoqii/stay-unzeen (private), ветка main
- frontend: каркас `web/` (Next.js 16, pnpm) на моках, живая лента, навигация, заглушки страниц
- Решения 12.10: демо Zcash на mainnet (testnet — CI), пул Ironwood, memo `unz1`, новый порядок урезания (CLAUDE.md)
- Правила: английский для UI/README/демо; сводка session-report в конце каждой сессии
- backend: `core/scanner` (init/sync/deposits/send/inspect-tx/probe), pre-release librustzcash, пул Ironwood. **Testnet сквозняком: депозит с memo прочитан из цепочки.** cargo test 14/14 (проверил лид). `infra/docker-compose.yml` (конфиг проверен, не запускался)
- API.md v0.1: `unz1`, единицы в базовых единицах + decimals, свечи, trades, WS-фильтр по mint, подпись в заголовках, формат ошибок
- adapters: адаптер pump.fun (pump-sdk 4.0.0, web3.js v1, CJS), create+buy одной v0-tx с ALT на vault, свежий creator на каждый запуск; 36 тестов (проверил лид); **e2e на devnet пройден**: create+buy / buy / sell finalized (статусы проверил лид через RPC)
- frontend: API v0.1 (моки), `/key` (BIP-39, PBKDF2→AES-GCM, hold-to-reveal), подпись запросов и кодек unz1 совпадают с векторами core байт в байт, слой данных под Devnet/Mainnet (по отчёту агента: build/lint/test 50/50; лид не перепроверял)
- core: crate `protocol` (unz1 + подпись HTTP, векторы), crate `ledger` (Postgres: K=3, reorg → freeze, атомарный hold, идемпотентный nonce, минимумы), `serve` без txid/memo в логах, сид пула в age, данные в `~/.unzeen/<net>` (0600). **Testnet: депозит 0.01 TAZ с unz1 → баланс в Postgres.** cargo test 44/44 (проверил лид)
- API.md v0.2: intents удалены → публичный `GET /api/pool`; `/api/portfolio` без pubkey в пути; коды graduated/pool_liquidity/balance_frozen/below_minimum
- Ревью безопасности/приватности дня 2: `docs/analysis/review-day2.md` (3 critical закрыты решениями владельца, high — в работе у backend/frontend)
- Ресёрч Zcash-стека: `docs/analysis/zcash-stack.md`
- Ресёрч Solana + правила хакатона: `docs/analysis/solana-launchpads.md`, `docs/analysis/hackathon-rules.md`

## В работе (день 3)
- backend (core): API-сервер axum по API v0.2 (pool, portfolio, actions, feed/tokens, WS)
- backend (adapters): релейер — исполнение buy/sell из holds реестра через адаптер pump.fun, загрузка .env, RPC по сети
- frontend: переход на API v0.2, `/portfolio` (баланс + Top up QR ZIP-321 с unz1), переключатель Devnet/Mainnet
- analyst: ревью кода дня 2 (protocol, ledger, web crypto, adapters)

## Решения
- Путь anon-ключа SLIP-0010 `m/44'/133'/0'/0'` фиксируем (лид): с ZIP-32 (Zcash) и `m/44'/501'` (Solana) не пересекается, менять векторы на обеих сторонах не стоит
- 12.10 (владелец): демо с переключателем Devnet ↔ Mainnet; на Devnet — 3–5 pre-funded demo-ключей для судей; K=3 подтверждения
- 12.10 по ревью аналитика (владелец): «оплата за действие» вырезана — только баланс; Verify = Merkle-sum + публичные vault, viewing key не публикуется никогда; вывод токенов всегда с газом и задержкой; хостинг — всё на своём сервере (VPS), без Vercel, без access-логов
- **Своей ноды Zebra/lightwalletd НЕ ставим** (окончательно, владелец). Только публичный lightwalletd (zec.rocks) + запасной; self-host/Tor — только строка в roadmap README

## Риски
- Фронт на API v0.1 (intents, /api/deposit) → перевести на v0.2 (`/api/pool`, ZIP-321 строит фронт)
- wallet.sqlite пула хранит расшифрованные memo + txid незашифрованно (0600, вне Desktop)
- H1 (lightwalletd видит интерес пула к txid) — НЕ урезается (владелец), делаем в дни 4–5: запрос всех shielded-tx блока
- Запасного testnet lightwalletd нет; mainnet fallback — тот же оператор (na/eu.zec.rocks)
- API-сервер (axum) ещё не написан; выплаты refund_pending не реализованы
- Публичный devnet RPC часто отвечает 429 → Helius devnet/mainnet в `.env` (`SOLANA_RPC_URL_DEVNET/_MAINNET`), адаптеру нужно их подгружать
- pump-sdk 4.0.0 ESM ломается в Node → адаптер CJS; релейер подключает через require
- После истёкшего blockhash релейер обязан проверить подпись перед повтором (двойная покупка)
- Все запуски с одного vault связаны через vault → ротация/шардирование vault в релейере
- mainnet init/sync не проверен вживую (заблокировано разрешениями) → ручной прогон владельцем
- Сид пула открытым текстом в `core/keys/` (0600, gitignore) → шифрование до mainnet-демо
- Фронт расходится с API.md v0.1 (подпись в заголовках, базовые единицы) → обновить типы/моки
- UFVK и memo печатаются в stdout CLI → в сервисе убрать
- CRITICAL: Orchard закрыт для депозитов (NU6.3/ZIP 258) → пул Ironwood; доки переименованы
- CRITICAL: на testnet активирован NU7 → нужны pre-release крейты librustzcash; решено: демо на mainnet, testnet для CI
- memo 512 байт: JSON не влезает с refund/nonce/exp → бинарный формат `unz1` (принят, backend вносит в API.md)
- pump.fun: devnet ЕСТЬ (снято). pump-sdk меняет мажоры → пин 4.0.0, перепрогон за 2 дня до сдачи
- Утечка = дисквалификация (правила) → жёсткий аудит приватности дни 13–14; creator токена — всегда свежий адрес пула
- NEAR Intents: без testnet, ZEC только transparent → только пакетный ребаланс пула, не выплаты юзерам
- stonk.fun = Raydium LaunchLab, своего SDK нет → только торговля через Jupiter
- Pyth Hermes требует API-ключ → курс из котировки 1Click
- Нужны: рабочий демо-URL на весь период судейства (до 22.11) + видео 2 мин
- Фаусет: только Valar 0.125 TAZ/сутки; zingo-cli на testnet — только ветка dev; ZODL testnet — сборка из исходников

## Нужно от владельца
- аккаунт сабмита + shielded-адрес ZODL для приза
- 1Click (JWT) — нужен к дням 11–12; Pyth не нужен
- VPS для демо до 22.11 (фронт + бек)
- ~0.1–0.2 ZEC и ~0.3 SOL для mainnet-демо (к дням 6–8)

## План сдачи (дни 15–16, от analyst)
- LICENSE (MIT); README на английском: модель доверия, что приватно/что нет, real vs mock, «Built during ZECATHON», roadmap
- Поиск секретов по всей истории (`gitleaks detect --log-opts="--all"` + grep mnemonic/uview/JWT) до открытия репо
- VPS живой 29.10–22.11: мониторинг uptime, балансов TAZ/devnet-SOL/demo-ключей, запасной lightwalletd; логи по чек-листу H9
- Description ≤2000 символов (what it does / why it doesn't leak / real vs mock) + demo-ключи
- 28.10 до 20:00 UTC открыть репо, проверить в инкогнито, отправить форму; после отправки черновик не пересохранять
- Копить TAZ заранее (фаусет 0.125/сутки) для demo-ключей
