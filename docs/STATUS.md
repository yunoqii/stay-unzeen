# Status

**День 2 / 16** (начат 12.10.2026 вечером). Последняя сводка: `docs/sessions/2026-10-12-1850.md`. Дедлайн: 28.10 23:59 UTC.

## Готово
- Структура команды (CLAUDE.md, агенты), ARCHITECTURE.md, API.md v0
- Репозиторий github.com/yunoqii/stay-unzeen (private), ветка main
- frontend: каркас `web/` (Next.js 16, pnpm) на моках, живая лента, навигация, заглушки страниц
- Решения 12.10: демо Zcash на mainnet (testnet — CI), пул Ironwood, memo `unz1`, новый порядок урезания (CLAUDE.md)
- Правила: английский для UI/README/демо; сводка session-report в конце каждой сессии
- backend: `core/scanner` (init/sync/deposits/send/inspect-tx/probe), pre-release librustzcash, пул Ironwood. **Testnet сквозняком: депозит с memo прочитан из цепочки.** cargo test 14/14 (проверил лид). `infra/docker-compose.yml` (конфиг проверен, не запускался)
- API.md v0.1: `unz1`, единицы в базовых единицах + decimals, свечи, trades, WS-фильтр по mint, подпись в заголовках, формат ошибок
- Ревью безопасности/приватности дня 2: `docs/analysis/review-day2.md` (3 critical закрыты решениями владельца, high — в работе у backend/frontend)
- Ресёрч Zcash-стека: `docs/analysis/zcash-stack.md`
- Ресёрч Solana + правила хакатона: `docs/analysis/solana-launchpads.md`, `docs/analysis/hackathon-rules.md`

## В работе (день 2)
- backend: `core/` — кодек unz1 + тест-векторы, реестр балансов в Postgres (депозит → баланс anon-ключа), шифрование сида пула, тихие логи
- backend: `adapters/` — адаптер pump.fun на devnet (pump-sdk 4.0.0), e2e create/buy/sell
- frontend: типы/моки под API v0.1, `/key` (12 слов, шифрование паролем), подпись запросов

## Решения
- 12.10 (владелец): демо с переключателем Devnet ↔ Mainnet; на Devnet — 3–5 pre-funded demo-ключей для судей; K=3 подтверждения
- 12.10 по ревью аналитика (владелец): «оплата за действие» вырезана — только баланс; Verify = Merkle-sum + публичные vault, viewing key не публикуется никогда; вывод токенов всегда с газом и задержкой; хостинг — всё на своём сервере (VPS), без Vercel, без access-логов
- **Своей ноды Zebra/lightwalletd НЕ ставим** (окончательно, владелец). Только публичный lightwalletd (zec.rocks) + запасной; self-host/Tor — только строка в roadmap README

## Риски
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
- ключи Helius, 1Click (JWT), Pyth (опц.)
- VPS для демо до 22.11 (фронт + бек)
- ~0.1–0.2 ZEC и ~0.3 SOL для mainnet-демо (к дням 6–8)

## План сдачи (дни 15–16, от analyst)
- LICENSE (MIT); README на английском: модель доверия, что приватно/что нет, real vs mock, «Built during ZECATHON», roadmap
- Поиск секретов по всей истории (`gitleaks detect --log-opts="--all"` + grep mnemonic/uview/JWT) до открытия репо
- VPS живой 29.10–22.11: мониторинг uptime, балансов TAZ/devnet-SOL/demo-ключей, запасной lightwalletd; логи по чек-листу H9
- Description ≤2000 символов (what it does / why it doesn't leak / real vs mock) + demo-ключи
- 28.10 до 20:00 UTC открыть репо, проверить в инкогнито, отправить форму; после отправки черновик не пересохранять
- Копить TAZ заранее (фаусет 0.125/сутки) для demo-ключей
