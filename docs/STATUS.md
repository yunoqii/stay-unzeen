# Status

**День 1 / 16** (12.10.2026). Дедлайн: 28.10 23:59 UTC.

## Готово
- Структура команды (CLAUDE.md, агенты), ARCHITECTURE.md, API.md v0
- Репозиторий github.com/yunoqii/stay-unzeen (private), ветка main

## В работе (день 1)
- analyst: ресёрч Zcash-стека → `docs/analysis/zcash-stack.md`
- analyst: ресёрч pump.fun / Meteora / Jupiter / Jito / NEAR Intents + правила хакатона → `docs/analysis/solana-launchpads.md`, `docs/analysis/hackathon-rules.md`
- backend: `infra/` docker-compose (zebrad, lightwalletd, postgres) + `core/` сканер: init (адрес пула) и sync (чтение memo) на testnet
- frontend: каркас `web/` на моках по API.md, живая лента (опережение плана, по плану — дни 3–5)

## Риски
- pump.fun без devnet → тесты на mainnet малыми суммами
- NEAR Intents без testnet
- stonk.fun: неизвестно, свой SDK или Meteora DBC
- Синк Zebra testnet долгий → разработка против публичного lightwalletd
- Фаусет TAZ может быть недоступен → ручной шаг пользователя
