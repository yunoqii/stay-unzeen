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
- core: API-сервер axum (v0.3), курс 1Click, контракт релейера `docs/RELAYER.md` + миграция 0002 (jobs/trades/tokens/token_balances), N3–N7 закрыты; 66/66 тестов с Postgres (проверил лид)
- adapters: релейер на Postgres-очереди по RELAYER.md, ротация vault, джиттер, идемпотентная отправка (N1), вывод с каплей SOL с другого vault; devnet buy/sell/withdraw finalized; ключи в `~/.unzeen/devnet/solana`; 89/89 тестов (проверил лид)
- frontend: API v0.2, Top up (ZIP-321 + unz1 в браузере), /portfolio, переключатель сети, CSP, /verify без viewing key
- frontend на API v0.3: /api/pool и подписанный /api/portfolio против живого core/api → 200; подпись под чужую сеть → 401; 75/75 тестов (по отчёту). Real-режим в браузере ещё не прогонялся. Для бека нужен `API_CORS_ORIGINS` (есть в .env.example)
- core (дни 4–6): **H1 закрыт** — сканер скачивает все shielded-tx блока (mainnet ~25 KiB/блок, ~28 MiB/сутки, zec.rocks не троттлит); выплаты ZEC (до 5 в одной tx, testnet ok); эпохи; режимы exec; D1–D14; роль релейера проверена вживую; /media; API v0.4, RELAYER v2; 84/84 тестов (проверил лид)
- adapters (дни 4–5): create с EXIF-очисткой, один vault на mint, Postgres-раннер, age-ключи; 115/115
- web (дни 4–6): страница токена (график, buy/sell), WebGL-герой, вывод, режимы Now/Delayed/Max, постоянный опрос портфеля, pad
- core (день 7): API v0.5 — /safety, 202 pending для неизвестных mint, правила создателя (лок 24 ч → 423, кап 5% → 422), `docs/INTEL.md`, миграция 0007, роль индексатора; 96/96 тестов (проверил лид)
- Спека fair-launch: `docs/analysis/fair-launch.md` (бек ~2 дня, фронт ~1.5–2)
- adapters (день 7): индексатор токенов (тик 45–75 с, пачка 8 с приманками, warm set, SSRF-safe метаданные, T1 без мастер-сида), Helius Sender с одинаковыми чаевыми; 228/228 тестов (проверил лид)
- Спеки: Verify (`docs/analysis/verify.md`), лимитки/TP/SL (`docs/analysis/orders.md`)
- web: стиль на всех страницах, интерактив, видео-обзор (локально, не в git)
- core: fair-launch (tlock-js→Rust сходится, заявки, commitment root + memo-аттестация, распределение, флаг) — 120/120 тестов (проверил лид)
- web: форма /launch (pump.fun/Meteora, лимит initial buy, правила), fair-launch UI (tlock в браузере, кольца, проверка включения, reveal) — код только в ленивом чанке; 202/202 (по отчёту)
- core: доказательство Verify 64 КиБ, сборщик creator fees → claimable → claim, исправления fair-launch F1–F15, лимитки/TP/SL (все 4 типа), API v0.8; 131/131 (проверил лид)
- web: /verify с проверкой в браузере, офлайн-скрипт; adapters: снимок vault для Verify, ключи аттестаций по назначению, ценовой проход
- Черновики сдачи: `docs/submission/` (README, описание 1898/1948 символов, сценарий видео, чек-лист); LICENSE (MIT) добавлен
- Ревью кода дня 2: `docs/analysis/review-day3.md` (critical нет; N1–N11 розданы агентам)
- Ревью безопасности/приватности дня 2: `docs/analysis/review-day2.md` (3 critical закрыты решениями владельца, high — в работе у backend/frontend)
- Ресёрч Zcash-стека: `docs/analysis/zcash-stack.md`
- Ресёрч Solana + правила хакатона: `docs/analysis/solana-launchpads.md`, `docs/analysis/hackathon-rules.md`

## В работе (день 3)
- —

## Решения
- 13.10 (лид, по launchpads-a.md): quote-токены — запас на каждом vault, пополнение пачками (своп-нога в той же tx — только fallback); единая ставка creator fee для всех запусков; LaunchLab-адаптер покрывает stonk.fun и bonk.fun (ID платформ захардкожены); Anoncoin/Surge — только торговля через Jupiter; Bags — с оговоркой, после LaunchLab
- 13.10 (лид, по launchpads-b.md): пары не к SOL — модель «реестр в лампортах, своп SOL→quote ногой в той же tx через закреплённый пул SOL/USDC, SOL/USD1, пыль — пулу, пакетный своп по расписанию»; делаем DBC с USDC/USD1, затем Raydium LaunchLab со своей platform config; meme.fun — после; Printr/Stoxes/Lesgo — не делаем (только торговля через Jupiter, если подтвердится); xStocks как quote — нет; fair-launch — только SOL
- 13.10 (владелец): Robinhood Chain — пока только ресёрч (`docs/analysis/robinhood-chain.md`); решение о реализации — после DONE.md (вся Solana-часть сделана и протестирована) и если останется время
- 13.10 (владелец): проработать все UX-состояния (матрица `docs/design/ux-states.md`, dev-only chaos-режим мока)
- 13.10 (владелец): страница `/tokens` с фильтрами (Unzeen-запуски, площадка, статус, сортировки) + режим Discovery всех токенов площадок за флагом (по умолчанию выкл., включаем для видео); страница `/docs`
- 13.10 (владелец): видео — полная версия с fair-launch (Cut B), доступ только по ссылке для проверяющих; загружать 28.10 при отправке формы, до этого файл только локально
- 13.10 (лид, по chat.md): R1 ник через HMAC с ключом вне БД; R2 бейдж creator = отдельный ник; R3/R4 публикация пачками на эпохах Delayed, без WS, опрос 10–15 с; R5 допуск по стоимости аккаунта (mainnet 0.05 ZEC, devnet ниже); R6 slow-режим после своей сделки по mint; R8 noop-запросы 1–3 мин (и для сделок); chat_hide создателю — да, с «Hidden by creator» и раскрытием читателем; R7 blind-токены — roadmap
- 13.10 (владелец): берём Helius Developer ($49) — включаем полную ленту сделок и историю дева/снайперов для тёплых токенов (подписки только на warm set, не вся программа); при открытии репо историю git переписываем без внутренних доков с сохранением дат коммитов (author/committer date)
- 13.10 (владелец): никакие функции не урезаем, времени много
- 13.10 (владелец): репо открываем 28.10 в 20:00 UTC (4 ч раскрытия fair-launch принимаем); внутренние доки (docs/analysis, docs/sessions, STATUS, CLAUDE.md, .claude/) выносим из публичного репо; судьям — 3–5 разных devnet demo-ключей в описании формы; ребаланс SOL через NEAR Intents — автоматизировать
- 13.10 (лид, по review-day8.md): гранула деревьев mint = 1 базовая единица (E1); дерево SOL убрать, claimable учитывать в ZEC-листе по курсу buy (E5/E6); дальнейшие creator fees fair-запуска — создателю (только комиссия launch-tx — пулу); min_out от цены тика + квантование ВСЕХ min_out до 3 значащих цифр (E4); подпись оператора публикуется до якоря (E10); пакет «демо-устойчивость Verify» E2/E7/E8/E9/E14/E16 — до записи видео
- 12.10 (лид, по review-fair-launch.md): раунд drand = R(closeAt + 30 с) + 1 (memo с корнем гарантированно до раунда, поле beforeRound); два ключа аттестаций — отдельный для fair-launch и для Verify (F14); кап 1024 заявки на запуск; fl_* в actions удаляются через 48 ч; фича в бандле только при явном =1, test:bundle:strict — обязательный шаг деплоя
- 12.10 (лид, по verify.md/orders.md): резерв ZEC — «attested by operator» (доказать без viewing key нельзя, ZIP 311 без Orchard/Ironwood; ZK proof of reserves — roadmap); корень Verify раз в сутки (devnet — вручную) + якорь memo-tx в Solana; один ключ аттестаций пула для memo Verify и fair-launch; ордера только по mint пула, TTL ≤ 72 ч, только delayed/max, цена с тика индексатора; bracket — вне MVP. План: Verify — дни 11–12 вместе с fair-launch; лимитки — дни 13–14 (вместо слота Jupiter)
- 12.10 (владелец): commitment root fair-launch — в MVP; публикуется при закрытии окна до раунда drand; листья = хэши шифротекстов; корень записывается memo-tx на Solana
- 12.10 (владелец): top-10 на mainnet — через Helius Free (только на тике с приманками); пробная отправка через Sender — вместе с первым mainnet-прогоном
- 12.10 (владелец): fair-launch v1 без Jito (одна атомарная tx), commitment root в MVP, число заявок публично при ≥5. (лид): сетка номиналов hold 0.05–10 ZEC, лимит покупки 25% саплая, creator fee запуска — пулу, флаг fairLaunch=false на публичном деплое до 28.10
- 12.10 (владелец): дизайн главной и токена одобрен → раскатка на остальные страницы + больше интерактивных деталей; видео-обзор только десктоп; промпты для генерации ассетов — в `docs/design/asset-prompts.md`
- 12.10 (владелец): RPC — Helius Free (priority fee + Sender с одинаковыми чаевыми на всех tx) + Shyft Free (все чтения); $0/мес; индекс всей программы pump.fun не делаем; Developer $49 — только если понадобятся флаговые функции
- 12.10 (владелец): числовая репутация создателя отменена → бейдж «rules enforced» (лок initial buy 24 ч, кап доли 5%, authorities). Helius: пока текущий тариф, дешёвые метрики + read-only замер потока; Developer $49 — к staging (~день 9), если замер подтвердит; история дева и полная лента — за флагом. Analyst сравнивает альтернативы Helius
- 12.10 (владелец): Now без Jito — только единый priority fee на все tx пула; Jito только для fair-launch. (лид, по now-mode.md): Now только buy/sell/create; статусы — постоянным опросом портфеля; pad тел POST
- 12.10 (владелец): новые доп. функции — панель безопасности токена (+ opt-in репутация анонимного создателя), быстрая торговля (пресеты, PnL/маркеры в браузере, фильтры ленты), поиск по CA; всё через наш бек. В плане: дни 6–8 (индексатор + UI), репутация — 9–10. Roadmap: Pulse, watchlist/алерты
- 12.10 (владелец): режимы исполнения Now (1–3 с, priority fee/Jito tip) / Delayed (30–60 с) / Max privacy (5–15 мин); дефолт в профиле = Delayed; подсказка на Top up; в README — модель угроз для Now (сеть видна → Tor/VPN или Delayed); analyst проверяет Now на другие утечки
- 12.10 (владелец, D4): один vault на mint (общий инвентарь по токену), правило «вывод с другого vault» снято; вывод с газом, задержкой, округлением, дроблением
- 12.10 (лид, по review-day4): исполнение эпохами 30–60 с (max privacy 5–15 мин); суммы в actions обнулять через 24 ч, ops старше 48 ч удалять; курс 1Click по таймеру; релейер под своей ролью
- 12.10 (владелец): данные пула на VPS — на зашифрованном томе с ручной разблокировкой (N2); мониторинг с алертом
- 12.10 (лид, по review-day3): chain_id в подписи HTTP; anon-ключ отдельно по сети `m/44'/133'/<net>'/0'`; учёт токенов в миграции 0002; refund в memo v1 не используется
- Путь anon-ключа SLIP-0010 `m/44'/133'/0'/0'` фиксируем (лид): с ZIP-32 (Zcash) и `m/44'/501'` (Solana) не пересекается, менять векторы на обеих сторонах не стоит
- 12.10 (владелец): демо с переключателем Devnet ↔ Mainnet; на Devnet — 3–5 pre-funded demo-ключей для судей; K=3 подтверждения
- 12.10 по ревью аналитика (владелец): «оплата за действие» вырезана — только баланс; Verify = Merkle-sum + публичные vault, viewing key не публикуется никогда; вывод токенов всегда с газом и задержкой; хостинг — всё на своём сервере (VPS), без Vercel, без access-логов
- **Своей ноды Zebra/lightwalletd НЕ ставим** (окончательно, владелец). Только публичный lightwalletd (zec.rocks) + запасной; self-host/Tor — только строка в roadmap README

## Риски
- Ключи аттестаций пусты на devnet → якоря Verify/fair не записаны (ждём пополнение владельцем, НЕ с vault)
- Правила создателя действуют на один anon-ключ — обход вторым ключом не закрыть без связывания; в UI «rules apply to the launching key»
- Контракт релейера: нет `avoid_vaults` в задании (вывод не знает vault покупки — сейчас эвристика), нет UPDATE not_before у роли, `create` в релейере не реализован, роль unzeen_relayer не проверена вживую
- Блокировка vault и счётчик creator — в памяти/файле → Postgres до мульти-процесса
- Ключи vault/creator открытым текстом (0600) → шифрование до mainnet
- Утечка БД связывает ключ ↔ сделку по суммам (D1) → обнуление через 24 ч, удаление ops через 48 ч, зашифрованный том
- wallet.sqlite пула хранит расшифрованные memo + txid незашифрованно (0600, вне Desktop)
- lightwalletd видит, что пул отправил tx выплаты (время, не получатель) — закрывается только Tor/своим сервером (своего сервера не будет) → README
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
- Ключ Shyft (Free) в .env
- Helius Developer ($49): апгрейд тарифа (тот же ключ или новый — сообщить)
- VPS для демо до 22.11 (фронт + бек)
- ~0.1–0.2 ZEC и ~0.3 SOL для mainnet-демо (к дням 6–8)

## План сдачи (дни 15–16, от analyst)
- LICENSE (MIT); README на английском: модель доверия, модель угроз режима Now (защищает от наблюдателей в блокчейне, не от сетевой слежки → Tor/VPN или Delayed), что приватно/что нет, real vs mock, «Built during ZECATHON», roadmap
- Поиск секретов по всей истории (`gitleaks detect --log-opts="--all"` + grep mnemonic/uview/JWT) до открытия репо
- VPS живой 29.10–22.11: мониторинг uptime, балансов TAZ/devnet-SOL/demo-ключей, запасной lightwalletd; логи по чек-листу H9
- Description ≤2000 символов (what it does / why it doesn't leak / real vs mock) + demo-ключи
- Публичный деплой до 28.10 собирать с `NEXT_PUBLIC_FAIR_LAUNCH_BUILD=0` и `UNZEEN_FAIR_LAUNCH=0` (кода fair-launch нет в бандле); 28.10 перед открытием репо — включить
- Перед открытием: вынести внутренние доки (docs/analysis, docs/sessions, docs/STATUS.md, CLAUDE.md, .claude/, docs/screenshots/design-review) в приватный репо и добавить в .gitignore; переписать историю git без них (git filter-repo --path ... --invert-paths), сохранив даты author/committer; проверить даты в окне 28.09–28.10; force-push только после проверки и бэкапа приватного репо
- Накопить TAZ на 3–5 demo-ключей судей
- 28.10 в 20:00 UTC открыть репо, проверить в инкогнито, отправить форму; после отправки черновик не пересохранять
- Копить TAZ заранее (фаусет 0.125/сутки) для demo-ключей
