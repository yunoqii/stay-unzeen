# Status

**День 1 / 16** (12.10.2026). Дедлайн: 28.10 23:59 UTC.

## Готово
- Структура команды (CLAUDE.md, агенты), ARCHITECTURE.md, API.md v0
- Репозиторий github.com/yunoqii/stay-unzeen (private), ветка main
- Ресёрч Solana + правила хакатона: `docs/analysis/solana-launchpads.md`, `docs/analysis/hackathon-rules.md`

## В работе (день 1)
- analyst: ресёрч Zcash-стека → `docs/analysis/zcash-stack.md`
- backend: `infra/` docker-compose (zebrad, lightwalletd, postgres) + `core/` сканер: init (адрес пула) и sync (чтение memo) на testnet
- frontend: каркас `web/` на моках по API.md, живая лента (опережение плана, по плану — дни 3–5)

## Риски
- pump.fun: devnet ЕСТЬ (снято). pump-sdk меняет мажоры → пин 4.0.0, перепрогон за 2 дня до сдачи
- Утечка = дисквалификация (правила) → жёсткий аудит приватности дни 13–14; creator токена — всегда свежий адрес пула
- NEAR Intents: без testnet, ZEC только transparent → только пакетный ребаланс пула, не выплаты юзерам
- stonk.fun = Raydium LaunchLab, своего SDK нет → только торговля через Jupiter
- Pyth Hermes требует API-ключ → курс из котировки 1Click
- Нужны: рабочий демо-URL на весь период судейства (до 22.11) + видео 2 мин
- Синк Zebra testnet долгий → разработка против публичного lightwalletd
- Фаусет TAZ может быть недоступен → ручной шаг пользователя
