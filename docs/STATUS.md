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
- Ресёрч Zcash-стека: `docs/analysis/zcash-stack.md`
- Ресёрч Solana + правила хакатона: `docs/analysis/solana-launchpads.md`, `docs/analysis/hackathon-rules.md`

## В работе (день 2)
- backend: `core/` — кодек unz1 + тест-векторы, реестр балансов в Postgres (депозит → баланс anon-ключа), шифрование сида пула, тихие логи
- backend: `adapters/` — адаптер pump.fun на devnet (pump-sdk 4.0.0), e2e create/buy/sell
- frontend: типы/моки под API v0.1, `/key` (12 слов, шифрование паролем), подпись запросов
- analyst: ревью сканера, протокола unz1/подписи, сквозная приватность → `docs/analysis/review-day2.md`

## Решения
- Своя нода Zebra не обязательна: демо через публичный lightwalletd (zec.rocks) + запасной; в README — self-host/Tor; свой сервер на VPS в дни 13–14, если будет время

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
- Синк Zebra testnet долгий → разработка против публичного lightwalletd
- Фаусет: только Valar 0.125 TAZ/сутки; zingo-cli на testnet — только ветка dev; ZODL testnet — сборка из исходников

## Нужно от владельца
- аккаунт сабмита + shielded-адрес ZODL для приза
- ключи Helius, 1Click (JWT), Pyth (опц.)
- хостинг демо до 22.11
- ~0.1–0.2 ZEC и ~0.3 SOL для mainnet-демо (к дням 6–8)
