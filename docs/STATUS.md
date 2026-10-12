# Status

**День 1 / 16** (12.10.2026). Дедлайн: 28.10 23:59 UTC.

## Готово
- Структура команды (CLAUDE.md, агенты), ARCHITECTURE.md, API.md v0
- Репозиторий github.com/yunoqii/stay-unzeen (private), ветка main
- Ресёрч Zcash-стека: `docs/analysis/zcash-stack.md`
- Ресёрч Solana + правила хакатона: `docs/analysis/solana-launchpads.md`, `docs/analysis/hackathon-rules.md`

## В работе (день 1)
- backend: `infra/` docker-compose (zebrad, lightwalletd, postgres) + `core/` сканер: init (адрес пула) и sync (чтение memo) на testnet
- frontend: каркас `web/` на моках по API.md, живая лента (опережение плана, по плану — дни 3–5)

## Риски
- CRITICAL: Orchard закрыт для депозитов (NU6.3/ZIP 258) → пул Ironwood; переименовать в доках/UI
- CRITICAL: на testnet активирован NU7 → нужны pre-release крейты librustzcash; ждёт решения: демо testnet или mainnet (0.01–0.05 ZEC)
- memo 512 байт: JSON не влезает с refund/nonce/exp → бинарный формат `unz1` (решение в API.md)
- pump.fun: devnet ЕСТЬ (снято). pump-sdk меняет мажоры → пин 4.0.0, перепрогон за 2 дня до сдачи
- Утечка = дисквалификация (правила) → жёсткий аудит приватности дни 13–14; creator токена — всегда свежий адрес пула
- NEAR Intents: без testnet, ZEC только transparent → только пакетный ребаланс пула, не выплаты юзерам
- stonk.fun = Raydium LaunchLab, своего SDK нет → только торговля через Jupiter
- Pyth Hermes требует API-ключ → курс из котировки 1Click
- Нужны: рабочий демо-URL на весь период судейства (до 22.11) + видео 2 мин
- Синк Zebra testnet долгий → разработка против публичного lightwalletd
- Фаусет: только Valar 0.125 TAZ/сутки; zingo-cli на testnet — только ветка dev; ZODL testnet — сборка из исходников
