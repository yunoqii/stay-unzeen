# Unzeen — контракт API (бек ↔ фронт)

Источник правды для обеих сторон. Меняет только backend (по согласованию с лидом); frontend работает по нему и мокает, пока бек не готов.

Статус: **v0.9** (13.10, кабинет создателя, статистика, creator fee запуска — пулу; реализовано в `core/ledger::{creator, stats, creator_fees}` + `core/api`, миграция `0013_creator_stats.sql`). Изменения против v0.8:
- **`GET /api/creator` (подписанный)** → `CreatorCabinet` = `{ tokens: CreatorToken[], pad }` (было `CreatorToken[]`; **тип `CreatorToken` заменён**, поля `feesEarnedSol`/`feesClaimedSol`/`volumeSol` удалены). Ответ паддится до кратного 4096 байт; ключ без запусков получает `{ tokens: [] }` того же размера. Раздел «Кабинет создателя (v0.9)».
- **`GET /api/stats` (публичный)** → `PlatformStats` (**тип заменён**): снимок раз в сутки (00:00 UTC; devnet — ручная команда), округление, k-анонимность: категория из < 5 событий → строка `"<5"`. До первого снимка — `404 not_found`. Раздел «Статистика (v0.9)».
- **Creator fee от самой launch-tx (`create` и fair-launch) — пулу.** Комиссия создателя, набежавшая с первой покупки запуска (деньги создателя / участников fair-launch), не попадает в `claimable`: при settle core фиксирует её размер, первые сборы этого mint уменьшаются на неё. Создатель получает только комиссии с последующих сделок. См. «Правила исполнения действий → claim».
- Обе ручки перенесены из «Дополнительных эндпоинтов» в основную таблицу REST.

Изменения v0.8 против v0.7:
- **Лимитки / TP / SL** (`docs/analysis/orders.md`): `order_create` / `order_cancel` поддерживаются; `Portfolio.orders`; `PoolInfo.orders`. **Отдельного `GET /api/orders` нет** (удалён из «Дополнительных эндпоинтов»): ордера только в портфеле. Раздел «Ордера (v0.8)».
- Новые коды ошибок: `order_limit` (422), `order_not_open` (409), `order_unsupported_mint` (422).
- **Fair-launch, исправления по ревью (`docs/analysis/review-fair-launch.md`):** раунд reveal `R = R(closeAt + 30 с) + 1` (между закрытием и раундом ≥ 30 с, корень успевает лечь в Solana); `commitment.attestation` += `blockTime`, `beforeRound`; дерево commitment фиксированной глубины 10 (1024 листа); не больше 1024 заявок на запуск → `409 launch_full`; `failure` += `"internal"` (набор заявок не совпал с корнем; всё возвращено); при выключенном флаге маршрутов `/api/launches*` нет вовсе (любой метод → как неизвестный путь); два одинаковых запроса `fl_*`/`order_*` одновременно → оба получают исходный ответ.
- `Portfolio.actions` не содержит `order_*` (ордер виден в `orders`; сработавший ордер порождает обычное действие `buy`/`sell`, связь — `Order.actionId`). `zecHeld` и `holdings[].held` включают hold ордеров.

Изменения v0.7 против v0.6 (Verify; `core/protocol::verify` + `core/ledger` + `core/api`):
- **Verify (proof of liabilities):** `GET /api/verify`, `GET /api/verify/snapshots`, `GET /api/verify/:id` (публичные), `GET /api/verify/proof` (подписанный, ответ всегда ровно 64 КиБ). Раздел «Verify (v0.7)». Векторы: `core/testdata/verify-vectors.json`.
- **Creator fees:** `claim` поддерживается (`{op:"claim", mint?}` → `{id, status:"executed", rate}`): накопленные комиссии создателя (`Portfolio.claimable`, лампорты) переводятся в ZEC по курсу sell, только операция реестра. `claimable` наполняется из глобального сборщика пула (раз в 6–12 ч) на ближайшей границе эпохи Delayed. Нечего забирать или меньше `minActionZat` → `422 below_minimum`. `Portfolio.actions[].kind` += `"claim"`.
- Verify: дерево `SOL` (комиссии создателей к выплате, гранула 0.001 SOL) при наличии `claimable`; ответ `/api/verify/proof` — ровно 64 КиБ.
- **Флаг fair-launch:** при выключенном флаге ключа `fairLaunch` в `PoolInfo` нет **совсем** (ни в `features`, ни отдельно). Отсутствие = выключено. При включённом: `features.fairLaunch = true` и блок `fairLaunch`.

Изменения v0.6 против v0.5 (fair-launch; **внутреннее до 28.10 23:59 UTC**, детали не публиковать, CLAUDE.md):
- **Fair-launch (закрытые заявки drand tlock → одна атомарная create+buy).** Полный контракт — раздел «Fair-launch (v0.6)» ниже. Новые эндпоинты `GET /api/launches`, `GET /api/launches/:id`; новые операции `fl_create`, `fl_bid`, `fl_cancel`, `fl_cancel_launch` в `POST /api/actions`; `Portfolio.fairBids`, `Portfolio.fairLaunches`; `PoolInfo.features.fairLaunch`, `PoolInfo.fairLaunch`.
- **Флаг.** Выключен по умолчанию (env `UNZEEN_FAIR_LAUNCH=1` включает); выключен (v0.7) = ключа `features.fairLaunch` нет: `GET /api/launches*` → `404 not_found` (как несуществующий путь), `fl_*` в `POST /api/actions` → `400 bad_request` (как неизвестная операция), в `Portfolio` нет `fairBids`/`fairLaunches`, в `PoolInfo` нет блока `fairLaunch`. Снаружи не отличить от сервера без фичи.
- **`PoolInfo.launchRules.maxInitialBuyLamports`** теперь считается по кривой **сети** (параметры pump.fun Global, которые пишет релейер в `launch_curves`, RELAYER.md v3); env `UNZEEN_LAUNCH_*` — только запасной вариант, пока релейер их не записал. На devnet (1 SOL виртуальных резервов) значение в ~30 раз меньше mainnet.
- `UnzeenRule` += `"fair_launch_sealed_bids"` (для токенов, запущенных через fair-launch).
- **`PoolInfo.launchRules.maxInitialBuyLamportsByVenue`** — кап первой покупки `create` по площадке; `create` проверяется по кривой своей площадки (meteora-dbc уже, см. тип).
- `TokenSafety.market.lpBurnedPct` для `meteora-dbc` означает «LP заблокирован навсегда» (позиция DAMM v2, а не mint).
- Новые коды ошибок: `launch_closed` (409), `already_bid` (409), `bad_ciphertext` (400). `creator_cap` (422) — также для `fl_bid` создателя.

Изменения v0.5 против v0.4:
- **`GET /api/tokens/:mint/safety`** → `200 TokenSafety` | `202 PendingResponse` | `400 bad_request` (не base58 32 байта) | `404 not_found` (аккаунта mint нет в сети / это не mint). Публичный, без подписи и cookies, ответ одинаков для всех. Данные — снимки индексатора по фиксированному тику (`docs/INTEL.md`), запрос сам ничего не ускоряет.
- **`GET /api/tokens/:mint` для неизвестного mint** → `202 PendingResponse` + mint ставится в очередь CA-запросов (вместо 404). После тика — `200` `Token & { trades: [] }` из снимка индексатора. **Найденный так mint в публичный `GET /api/tokens` НЕ попадает** (иначе видно, что кто-то искал): список строится только из токенов, которыми торговал пул. `404` — если индексатор выяснил, что такого mint нет.
- **`GET /api/tokens/:mint/trades?filter=all|unzeen|whales|dev`.** Без `filter` — как раньше, `FeedEvent[]`. С `filter` — `TokenTrade[]`. Пока полной ленты нет (`PoolInfo.features.fullTrades = false`): `all` = `unzeen` (только сделки пула), `whales` и `dev` → `400 feature_disabled`.
- Свечи и `/trades` для mint, известного только по снимку индексатора, отдают `[]` (а не 404).
- **Правила создателя Unzeen-запуска (в реестре, принудительно):** токены первой покупки создателя (`create.initialBuyZec`) залочены на 24 ч — `sell`/`withdraw_token`, затрагивающие их, → `423 creator_locked`; кап позиции создателя через пул — 5 % саплая: `create` с первой покупкой > 5 % и любая `buy` создателя, которая может довести его позицию в пуле выше 5 %, → `422 creator_cap`. Параметры — `PoolInfo.launchRules`.
- **T1.** Для Unzeen-запусков доля и продажи создателя **не считаются из реестра и не публикуются**: в `TokenSafety` нет `dev`, `holders.devPct = null`, есть `unzeen: { launch: true, rules }`. Фильтр `dev` для них всегда пуст.
- **`ActionStatus.executedAt`** — время исполнения, unix мс, **округлено вниз до минуты**; есть, пока хранится `fill` (24–48 ч).
- **`PoolInfo.features`** (`fullTrades`) и **`PoolInfo.launchRules`** (`lockSecs`, `capBps`, `maxInitialBuyLamports`).
- Новые коды ошибок: `feature_disabled` (400), `creator_locked` (423), `creator_cap` (422).

Изменения v0.4 против v0.3:
- **Эпохи (D2).** buy/sell/create больше не получают независимую задержку 3–20 с: они копятся и исполняются пачкой на границе эпохи. Интервал между границами случайный **30–60 с** (одинаково на devnet и mainnet), расписание не зависит от прихода запросов, порядок внутри пачки случайный.
- **`exec?: "now" | "delayed" | "max"`** — режим исполнения (по умолчанию `"delayed"`; неизвестное значение → 400). См. «Режимы исполнения».
  - buy/sell/create: `now` — без эпохи, исполнение за секунды, плоская комиссия `PoolInfo.fees.nowFeeZat` (входит в hold); `delayed` — эпоха 30–60 с; `max` — эпоха 5–15 мин.
  - withdraw_zec/withdraw_token: `delayed` (по умолчанию) или `max` (задержка 10–60 мин); **`now` → 400**.
- **Паддинг.** POST `/api/actions` принимает и игнорирует строковое поле `pad` (≤ 8192 байт) — клиент выравнивает размер тела. Подписанные ответы паддятся полем `pad` до кратного 1024 байт (`/api/actions`, `/api/actions/:id`) и 4096 байт (`/api/portfolio`).
- **`Portfolio.actions`** — последние 20 действий владельца, тип `(ActionStatus & { id, kind })[]` (статус `queued` | `sent` | `executed` | `failed`, `error`, `rate`, `fill`, `solanaTx`). Фронт опрашивает только портфель, а не `/api/actions/:id` (эндпоинт остаётся).
- **Зачисление депозита** — после `K + r` подтверждений, `r` ∈ 0..3 (фиксирован для ноты, не угадывается снаружи). `PoolInfo.confirmations` = K (минимум).
- **`PoolInfo.rate`** — публичный курс из фонового кэша (без запроса к 1Click): `lamportsPerZec` (mid), `lamportsPerZecBuy`/`lamportsPerZecSell` (со спредом, ровно те, что применит сервер сейчас), `spreadBps`, `source`, `ts`. Нет поля — курса нет (действия → 503). `Cache-Control: max-age=15`.
- **`PoolInfo.fees`** (`createFeeZat`, `withdrawZecFeeZat`, `withdrawTokenGasLamports`, `withdrawTokenCostLamports`) и **`PoolInfo.createEnabled`**.
- **`ActionStatus.status: "sent"`** — транзакция подписана и отправлена (релейер записал подпись / выплата ZEC в сети), ждём финальности. Дальше `executed` | `failed`. `ActionReceipt` из `POST` по-прежнему только `queued`.
- **Округление суммы покупки (D10).** Для `buy` и первой покупки `create` SOL-сумма срезается на случайные 0–1 % и округляется **вниз до 0.001 SOL**; `minOut` уменьшается пропорционально (минимальная цена та же). Списывается только ZEC-эквивалент фактически отправленных лампортов (`≤ zecIn`), остаток остаётся в `zecBalance`. Фронт показывает «≈», а не точную сумму; для оценки `minOut` берёт `PoolInfo.rate.lamportsPerZecBuy` и закладывает −1 % срезки (сервер сам уменьшит `minOut` пропорционально). Слишком маленькая покупка, не дающая 0.001 SOL, → `below_minimum`.
- **`create` → `503 venue_unavailable`**, пока исполнитель запуска в релейере не включён лидом (`UNZEEN_CREATE_ENABLED=1`). hold не ставится (D6). UI скрывает/дизейблит запуск по этому коду.
- **`withdraw_zec` исполняется:** выплата shielded ZEC с пула (батчами до 5 выплат в одной tx, только на Orchard/Ironwood-получателя UA, `OvkPolicy::Discard`), `status` → `executed` после K подтверждений; `fill.zecSpent` = сумма + комиссия. UA получателя удаляется сразу после подтверждения.
- **`DepositInfo.publicSource`** (D3): `true`, если tx депозита шла с прозрачных входов или выводила сумму из Sapling/старого Orchard (turnstile) — её сумма видна в цепочке. Фронт показывает владельцу предупреждение.
- **`withdraw_token`** — с vault, на котором пул держит этот mint (общий инвентарь пула; правило «с другого vault» снято решением владельца, D4), всегда с каплей SOL на газ, отдельная tx на часть, задержка.
- **Курс** запрашивается у 1Click фоном раз в 30–60 с, не в момент действия (D14). Если обновление не удалось и котировке > 45 с — спред ×2; > 120 с — `503 venue_unavailable`.
- **`GET /media/<sha40>.<ext>`** — картинки и JSON-метаданные токенов (`tokens.image` указывает сюда).
- **Хранение (D1):** суммы, курс и `fill` действия стираются через 24–48 ч после закрытия; журналы операций — через 48 ч. `GET /api/actions/:id` после этого отдаёт только `status`/`error`.

Изменения v0.3 против v0.2:
- **Подпись запросов привязана к сети:** вторая строка подписываемого сообщения — `chainId` hex (`0202` / `0101`). Векторы пересобраны.
- **anon-ключ по сети:** путь `m/44'/133'/<net>'/0'`, `net` = 0 mainnet, 1 devnet/testnet. Одна фраза — разные ключи в разных сетях. Векторы: раздел `anonKey`.
- Допустимы только два `chainId`: `0202` (Zcash testnet + Solana devnet) и `0101` (mainnet + mainnet-beta); сервер со смешанной конфигурацией не стартует.
- API каждой сети живёт **в корне своего origin** (отдельный поддомен), без префиксов пути: подписывается сырой request-target.
- Refund в memo v1 не используется: фронт всегда шлёт `target_kind = 0`; истёкший депозит зачисляется на баланс (даже если `target_kind = 1`). Статус `refund_pending` больше не возникает.
- `DepositInfo.id` (стабильный случайный, только владельцу); `DepositInfo.ts` округлён до **суток** (UTC); `holdings[].held`.
- `POST /api/actions` и `GET /api/actions/:id` возвращают зафиксированный курс `rate`; `GET` — ещё `fill` после исполнения.
- Комиссии и курс действий, правила `create.meta`, минимум для `sell`, неподдерживаемые пока операции — см. «Правила исполнения действий».

Изменения v0.2 против v0.1: оплата за действие вырезана (memo только `op=deposit`, `/api/intents` и `/api/deposit` удалены, вместо них публичный `GET /api/pool`); memo собирает и подписывает фронт; `/api/portfolio` без pubkey в пути; статусы депозита и минимумы; идемпотентность действий по nonce; правила вывода; коды ошибок `graduated`, `pool_liquidity`, `balance_frozen`, `below_minimum`; исправлены размеры memo (153/196). Тест-векторы: `core/testdata/unz1-vectors.json`.

## REST

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/api/feed?limit=50` | `FeedEvent[]` |
| GET | `/api/tokens` | `Token[]` |
| GET | `/api/tokens/:mint` | `Token & { trades: FeedEvent[] }` — последние **50** сделок по mint, новые первыми. Неизвестный mint → `202 PendingResponse` + очередь (v0.5) |
| GET | `/api/tokens/:mint/trades?before=<id>&limit=50` | `FeedEvent[]` — пагинация истории, `limit` ≤ 200 |
| GET | `/api/tokens/:mint/trades?filter=all\|unzeen\|whales\|dev&before=<id>&limit=50` | `TokenTrade[]` (v0.5). `whales`/`dev` без полной ленты → `400 feature_disabled` |
| GET | `/api/tokens/:mint/safety` | `TokenSafety` \| `202 PendingResponse` (v0.5), см. «Безопасность токена» |
| GET | `/api/tokens/:mint/candles?tf=1m&from=&to=` | `Candle[]` — OHLC для lightweight-charts (см. ниже) |
| GET | `/api/pool` | `PoolInfo` — публичный: UA пула, `chainId`, минимумы, K подтверждений. Без pubkey и без cookies |
| GET | `/api/portfolio` (подписанный) | `Portfolio` — pubkey только в заголовке `x-unzeen-pubkey`, **не в пути** |
| POST | `/api/actions` (подписанный) | `SignedAction` → `ActionReceipt` — все действия только с баланса |
| GET | `/api/actions/:id` (подписанный) | `ActionStatus` — только владельцу (pubkey заголовка = автор действия), иначе 404 |
| GET | `/media/<sha40>.<png\|jpeg\|jpg\|webp\|json>` | картинка/метаданные токена. Только точное имя (40 hex + расширение), без листинга, `Cache-Control: immutable`, `nosniff`, без логов. Остальное — 404 |
| GET | `/api/launches?status=&limit=50` | `FairLaunch[]` (v0.6, только при `features.fairLaunch`), см. «Fair-launch» |
| GET | `/api/launches/:id` | `FairLaunch` \| 404 (v0.6) |
| GET | `/api/verify` | `VerifySnapshot` (последний) \| 404 (v0.7), публичный |
| GET | `/api/verify/snapshots?before=<id>&limit=30` | `VerifySnapshotSummary[]` (v0.7), история корней |
| GET | `/api/verify/:id` | `VerifySnapshot` \| 404 (v0.7) |
| GET | `/api/verify/proof[?snapshot=<id>]` (подписанный) | `VerifyProof` (v0.7), только последний или предыдущий снимок |
| GET | `/api/creator` (подписанный) | `CreatorCabinet` (v0.9), только токены, созданные этим ключом; ответ кратен 4096 байт |
| GET | `/api/stats` | `PlatformStats` (v0.9) — последний суточный снимок \| `404` до первого снимка; `Cache-Control: public, max-age=3600` |

Подписанные запросы — схема в разделе «Подпись запросов».

**Origin.** Каждая сеть — свой origin (например `https://devnet-api.<домен>` и `https://api.<домен>`), API в корне, без префикса пути (`/devnet/api/…` не допускается: подписанный путь должен совпадать с request-target на сервере). CORS: сервер разрешает только origin'ы из `API_CORS_ORIGINS`, методы GET/POST, заголовки `content-type`, `x-unzeen-*`. Cookies не используются.

**Статус пополнения.** Публичного эндпоинта «депозит seen» нет и не будет: любой запрос статуса по хешу memo/txid связывает IP с депозитом. Статус — только через подписанный `/api/portfolio` (`deposits`, `zecBalance`); на фронте ручная кнопка «I've sent it» и опрос портфеля.

**Пополнение (Top up) без сервера.** Фронт берёт `GET /api/pool`, сам собирает и подписывает memo `unz1` (op=deposit), сам строит ZIP-321 URI (`zcash:<address>?amount=<ZEC>&memo=<base64url(memo UTF-8)>`). Сервер не узнаёт о намерении пополнить до появления ноты в цепочке, связки «IP ↔ anon-ключ ↔ сумма» на сервере нет. Статус пополнения фронт видит в `Portfolio.deposits` (после зачисления) и по росту `zecBalance`; до K подтверждений депозит не атрибутируется.

## WebSocket
`/ws/feed` → поток `FeedEvent` (все сделки).
`/ws/feed?mint=<mint>` → только события по одному mint (для страницы токена).

## Типы

```ts
type Venue = "pumpfun" | "meteora-dbc" | "jupiter";

interface FeedEvent {
  id: string;
  kind: "buy" | "sell" | "create";
  venue: Venue;
  mint: string;
  symbol: string;
  tokenAmount: string;   // БАЗОВЫЕ единицы токена (целое), UI = tokenAmount / 10^decimals
  solAmount: string;     // лампорты (целое), UI = solAmount / 1e9
  decimals: number;      // decimals токена (pump.fun = 6), чтобы не ходить за Token
  solanaTx: string;      // публичная подпись — видна в эксплорере
  ts: number;            // unix ms
  // никаких данных о пользователе — только "unzeen"
}

interface Token {
  mint: string; symbol: string; name: string; image?: string;
  venue: Venue; status: "curve" | "graduated";
  decimals: number;      // decimals SPL-токена
  priceSol: string;      // десятичная строка: SOL за 1 целый токен (UI-единицы)
  marketCapSol: string;  // десятичная строка, SOL (UI-единицы)
  createdAt: number;     // unix ms
}

interface Candle {
  time: number;          // unix СЕКУНДЫ (UTCTimestamp lightweight-charts), начало бара
  open: string; high: string; low: string; close: string;  // десятичные SOL за 1 целый токен
  volume: string;        // лампорты за бар (целое)
}

interface PoolInfo {
  address: string;          // UA пула (только Orchard/Ironwood receiver), одинаковый для всех
  network: "main" | "test";
  chainId: string;          // hex 2 байта для подписи memo и HTTP: только "0202" (Zcash testnet + Solana devnet) или "0101" (mainnet + mainnet-beta)
  minDepositZat: string;    // ниже — не зачисляется (остаётся пулу как пыль)
  minActionZat: string;     // минимальная сумма действия с баланса (zecIn / withdraw_zec)
  confirmations: number;    // K: через сколько блоков депозит зачисляется (по умолчанию 3)
  fees: {                   // v0.4
    createFeeZat: string;             // комиссия запуска, зат
    withdrawZecFeeZat: string;        // комиссия вывода ZEC, зат
    withdrawTokenGasLamports: string; // капля SOL получателю на каждую часть
    withdrawTokenCostLamports: string;// рента ATA + fee на каждую часть; комиссия вывода токена = parts × (gas + cost) по курсу buy
    nowFeeZat: string;                // плоская комиссия режима exec "now" (приоритетная полоса пула), зат; входит в hold
  };
  createEnabled: boolean;   // v0.4: false → POST create вернёт 503 venue_unavailable
  features: {               // v0.5: что включено на сервере (не build-time флаг фронта)
    fullTrades: boolean;    // полная лента сделок по mint (чужие сделки, теги whale/dev/sniper); false → filter whales|dev = 400
    fairLaunch?: true;      // v0.6/v0.7: есть только при включённом fair-launch; нет ключа → выключено (UI не показывать)
  };
  fairLaunch?: FairLaunchParams;  // v0.6: только при features.fairLaunch = true
  orders: {                 // v0.8: приватные ордера
    kinds: ("limit_buy" | "limit_sell" | "take_profit" | "stop_loss")[];
    venues: "pumpfun"[];
    maxOpenPerKey: number;      // 10
    maxOpenPerMint: number;     // 4 (на ключ и mint)
    maxTtlSecs: number;         // 259200 (72 ч)
    defaultTtlSecs: number;     // 86400
    defaultSlippageBps: { limit_buy: number; limit_sell: number; take_profit: number; stop_loss: number };  // 500/500/500/1500
    slConfirmTicks: number;     // 2
    priceTick: { minSecs: number; maxSecs: number };   // 45/75: «checks about once a minute»
  };
  launchRules: {            // v0.5: правила создателя Unzeen-запуска, которые реестр применяет принудительно
    lockSecs: number;       // лок токенов первой покупки создателя (86400 = 24 ч); 0 — правило выключено
    capBps: number;         // кап позиции создателя через пул, б.п. саплая (500 = 5 %); 0 — выключено
    maxInitialBuyLamports: string; // максимум первой покупки create в лампортах (после округления D10), из кривой площадки (pumpfun)
    maxInitialBuyLamportsByVenue: Record<string, string>; // v0.6: то же по каждой включённой площадке-лаунчпаду
                                   // (meteora-dbc: комиссия 1 % вместо ~1,25 % → кап сужен в 5/5,013 раза, пока у DBC нет своей строки кривой)
  };
  rate?: {                  // v0.4: из фонового кэша (обновление 30–60 с); нет поля → курса нет
    lamportsPerZec: string;     // mid
    lamportsPerZecBuy: string;  // для buy/create/комиссий (mid − спред)
    lamportsPerZecSell: string; // для sell (mid + спред)
    spreadBps: number;          // текущий спред (×2 при устаревшей котировке)
    source: "near-1click" | "fixed";
    ts: number;                 // время котировки, unix мс
  };
}

interface Portfolio {
  zecBalance: string;       // затоши, доступно
  zecHeld: string;          // затоши, зарезервировано действиями в очереди
  frozen: boolean;          // true — баланс заморожен до ручной проверки (reorg); снимается автоматически, если депозит снова в цепочке с K подтверждениями
  holdings: { mint: string; amount: string; held: string }[];  // amount — доступно; held — зарезервировано sell/withdraw_token в очереди
  claimable: { mint: string; solAmount: string }[];            // v0.7: creator fees к выплате (лампорты) по mint, созданным этим ключом; claim → ZEC
  deposits: DepositInfo[];  // последние 20, новые первыми
  actions: (ActionStatus & {  // v0.4: последние 20 действий владельца (queued первыми)
    id: string;
    kind: "buy" | "sell" | "create" | "withdraw_zec" | "withdraw_token" | "claim";   // fl_* сюда НЕ попадают (v0.6); claim (v0.7)
  })[];
  orders: Order[];               // v0.8: открытые/сработавшие первыми, затем закрытые (суммы и цена живут 24 ч после закрытия); ≤ 20
  fairBids?: FairBid[];          // v0.6: только при features.fairLaunch; последние 20 заявок ключа
  fairLaunches?: OwnFairLaunch[];// v0.6: только при features.fairLaunch; запуски, созданные этим ключом (кабинет создателя)
  pad: string;              // v0.4: пробелы, выравнивают ответ до кратного 4096 байт; игнорировать
}

interface DepositInfo {
  id: string;               // 16 случайных байт, hex (32 символа); стабилен, виден только владельцу; НЕ связан с txid/note
  amountZat: string;
  status: "credited";       // "refund_pending" в v1 не возникает (refund не используется)
  // (v0.4) зачисляется после K + r подтверждений, r ∈ 0..3
  publicSource: boolean;    // v0.4: сумма депозита публична (tx с t-адреса / из Sapling / старого Orchard); показать предупреждение
  ts: number;               // время зачисления, unix мс, округлено ВНИЗ до начала суток UTC
}

interface ActionReceipt {
  id: string;               // 32 hex
  status: "queued" | "executed" | "failed";
  rate?: RateUsed;          // для buy / sell / create / withdraw_token
}

interface ActionStatus {
  status: "queued" | "sent" | "executed" | "failed";   // sent (v0.4): tx отправлена, ждём финальности
  executedAt?: number;      // v0.5: unix мс, округлено ВНИЗ до минуты; только при executed, пока хранится fill (24–48 ч)
  solanaTx?: string;        // первая подтверждённая подпись; через 24 ч после исполнения связь удаляется (поле пропадает)
  error?: ErrorCode;        // при failed: slippage | graduated | pool_liquidity | venue_unavailable | not_found | bad_request | internal
  rate?: RateUsed;
  fill?: {                  // после исполнения, хранится 24–48 ч
    tokenAmount: string;    // получено (buy/create) / продано (sell) / отправлено (withdraw_token), базовые единицы
    solAmount?: string;     // лампорты сделки (нет у withdraw_token)
    zecSpent?: string;      // затоши списано (с учётом возврата неистраченного)
    zecCredited?: string;   // sell: затоши зачислено
    mint?: string;          // create: новый mint
  };
}

interface RateUsed {
  lamportsPerZec: string;   // лампорты за 1 ZEC, уже со спредом пула (buy: меньше SOL; sell: больше SOL за 1 ZEC)
  source: "near-1click" | "fixed";   // fixed — только devnet (DEVNET_ZEC_SOL_RATE)
  ts: number;               // время котировки, unix мс
}
```

```ts
// Действие с баланса аккаунта (единственный режим)
// anonPubkey/nonce/ts/sig передаются ЗАГОЛОВКАМИ (см. «Подпись запросов»), не в теле.
// create: meta уходит в теле (подписано через sha256(body)), отдельный хеш/канонизация meta не нужны.
type SignedAction = (
  | { op: "buy";  venue: Venue; mint: string; zecIn: string; minOut: string; exec?: "now" | "delayed" | "max" }
  | { op: "sell"; venue: Venue; mint: string; amount: string; minZecOut: string; exec?: "now" | "delayed" | "max" }
  | { op: "create"; venue: Venue; meta: { name: string; symbol: string; image?: string }; initialBuyZec?: string; exec?: "now" | "delayed" | "max" }  // 503 пока выключен
  | { op: "claim"; mint?: string }                          // creator fees → баланс; чисто реестровая операция,
                                                            // on-chain сбор fees — по глобальному расписанию пула
  | { op: "withdraw_zec"; to: string; amount: string; exec?: "delayed" | "max" }  // UA с Orchard/Ironwood receiver; t-адрес и Sapling-only → 400
  | { op: "withdraw_token"; mint: string; amount: string; to: string | string[];   // на новый Solana-адрес
      smart?: { parts: number; maxDelayMin: number }; exec?: "delayed" | "max" }  // умный вывод: parts 2..5 (длина `to` = parts)
  | { op: "order_create"; venue: "pumpfun"; mint: string;                        // v0.8, см. «Ордера»
      kind: "limit_buy" | "limit_sell" | "take_profit" | "stop_loss";
      triggerPriceSol: string;     // десятичная SOL за 1 целый токен (как Token.priceSol), > 0, ≤ 18 значащих цифр
      amount: string;              // limit_buy: зат; остальные: базовые единицы токена
      slippageBps?: number;        // 50..5000; по умолчанию PoolInfo.orders.defaultSlippageBps[kind]
      ttlSecs?: number;            // 3600..PoolInfo.orders.maxTtlSecs; по умолчанию 86400; expiresAt округляется ВВЕРХ до часа
      exec?: "delayed" | "max" }   // "now" → 400
  | { op: "order_cancel"; orderId: string }                                       // только из open
  | { op: "chat"; mint: string; text: string; showCreatorBadge?: boolean }
);

interface Order {                 // v0.8: только в Portfolio.orders (владельцу)
  id: string;                     // 32 hex (= id ответа order_create)
  venue: "pumpfun"; mint: string;
  kind: "limit_buy" | "limit_sell" | "take_profit" | "stop_loss";
  triggerPriceSol: string; amount: string; slippageBps: number; exec: "delayed" | "max";
  status: "open" | "triggered" | "filled" | "cancelled" | "expired" | "failed";
  createdAt: number;              // unix мс, вниз до минуты
  expiresAt: number;              // unix мс, вверх до часа
  armed?: true;                   // stop_loss: условие выполнено на одном тике, ждём второго подряд
  actionId?: string;              // triggered/filled/failed после срабатывания: статус сделки — в Portfolio.actions
  error?: ErrorCode;              // failed: graduated | slippage | below_minimum | creator_cap | ...
}

interface ChatMessage {
  id: string; mint: string; nick: string;   // nick = hex(sha256("unzeen/chat/v1" ‖ pubkey ‖ mint))[:8]; pubkey/подпись НИКОГДА не отдаются
  text: string; isCreator: boolean; ts: number;
}

// v0.9: GET /api/creator (подписанный). Только владельцу ключа; публично ничего из этого нет (T1).
interface CreatorCabinet {
  tokens: CreatorToken[];   // токены, созданные этим ключом (create / fl_create), новые первыми, ≤ 50
  pad: string;              // пробелы до кратного 4096 байт; игнорировать
}

interface CreatorToken {
  mint: string; symbol: string; name: string; image?: string; decimals: number;
  venue: "pumpfun" | "meteora-dbc";
  status: "curve" | "graduated";   // из снимка индексатора (тик), иначе из Token
  curveProgressPct?: string;       // только на кривой и при наличии снимка индексатора
  createdAt: number | null;        // unix мс (= Token.createdAt, публичное время создания)
  fees: {
    claimableLamports: string;     // = Portfolio.claimable[mint].solAmount ("0", если нечего); claim → ZEC
    claimedLamports: string;       // всего переведено claim по этому mint (с v0.9; более ранние claim не учтены)
  };
  volumeLamports: string;          // объём сделок пула по mint (buy+sell, как в ленте), всё время, лампорты
  trades: number;                  // число этих сделок
  holders: number | null;          // число холдеров из снимка индексатора; null — снимка/числа ещё нет
  holdersAsOf?: number;            // unix мс тика снимка (вниз до минуты)
  lock: {                          // лок токенов первой покупки (launchRules.lockSecs)
    lockedAmount: string;          // базовые единицы; "0" — лока нет или он закончился
    until: number | null;          // unix мс (вверх до часа), только пока лок действует
  };
  cap: {                           // кап позиции создателя через пул (launchRules.capBps)
    capBps: number;                // 0 — выключен
    capTokens: string;             // базовые единицы
    positionTokens: string;        // доступно + в hold + оценка ещё не исполненных buy (как считает кап)
  };
}

// v0.9: GET /api/stats (публичный). Суточный снимок, никаких realtime-агрегатов (H6).
type KCount = number | "<5";      // "<5" — категория построена меньше чем из 5 событий
type KAmount = string | "<5";     // десятичная строка (UI) или "<5"

interface PlatformStats {
  asOf: number;               // unix мс: 00:00 UTC дня снимка; все данные — строго ДО этого момента
  volumeSol: KAmount;         // объём сделок пула (buy+sell), SOL, вниз до 0.1 SOL; "<5" при < 5 сделок
  trades: KCount;             // число сделок пула (buy+sell)
  launches: KCount;           // число запусков через пул (create и fair-launch)
  zecShielded: KAmount;       // ZEC, зачисленные из shielded-депозитов (накопительно), вниз до 1 ZEC.
                              // Меняется, только если с прошлого изменения зачислено ≥ 5 новых депозитов; до 5 депозитов — "<5"
  byVenue: Record<Venue, { volumeSol: KAmount; trades: KCount; launches: KCount }>;  // всегда все три ключа
  topTokens: (Token & { volumeSol: string; trades: number })[];
                              // ≤ 10 по объёму пула за topWindowDays дней до asOf; только токены с ≥ 5 сделками пула в окне;
                              // volumeSol вниз до 0.1 SOL; поля Token (цена, статус) — на момент расчёта снимка
  topWindowDays: number;      // 7
}
```

### Безопасность токена и лента сделок (v0.5)

Все эндпоинты раздела публичные: **без подписи, без cookies, без `x-unzeen-*`**, ответ одинаков для всех, ничего персонального (в т. ч. «you hold»), сервер не пишет логов с mint. `Cache-Control: public, max-age=60` (для `202` — `max-age` = до следующего тика, ≥ 1 с).

```ts
// 202 у /safety и у /api/tokens/:mint для холодного mint
interface PendingResponse {
  status: "pending";
  retryAfterMs: number;     // до ближайшего тика индексатора + запас; одинаково для всех спрашивающих в этом окне
}

type RiskyExtension = "permanentDelegate" | "transferHook" | "transferFee" | "defaultFrozen" | "mintClose" | "pausable";
type UnzeenRule = "creator_initial_buy_locked_24h" | "initial_buy_cap_5pct" | "authorities_revoked"
  | "fair_launch_sealed_bids"   // v0.6: токен запущен через fair-launch
  | string;

interface TokenSafety {
  mint: string;
  asOf: number;             // unix мс, округлено вниз до минуты тика, в котором сделан снимок (не момент чьего-то запроса)
  program: "spl-token" | "token-2022";
  authorities: {
    mintRevoked: boolean;
    freezeRevoked: boolean;
    metadataImmutable: boolean | null;   // updateAuthority == null; null — неизвестно
    riskyExtensions: RiskyExtension[];
  };
  holders?: {               // нет поля — снимка холдеров ещё нет
    top10Pct: string;       // десятичная строка, %; без кривой, пула AMM и vault'ов Unzeen
    devPct: string | null;  // null для Unzeen-запусков (T1) и если дев неизвестен
    unzeenPoolPct: string;  // доля всех vault пула (общий инвентарь всех держателей unzeen)
    asOf: number;           // как asOf выше
  };
  dev?: {                   // только при включённой истории дева; НИКОГДА для Unzeen-запусков (T1)
    address: string; launchesSeen: number; rugsSeen: number; since: number;
  };
  firstBlocks?: {           // только при включённой полной ленте
    snipers: number; sniperPct: string;
    sameSlotBuyers: number; sameSlotPct: string;   // без нашей launch-покупки
    unzeenLaunchBuy: boolean;                      // атомарный create+buy Unzeen (by design, не бандл)
  };
  market: {
    venue: Venue; status: "curve" | "graduated";
    curveProgressPct?: string;   // только на кривой
    lpBurnedPct?: string;        // после миграции; для meteora-dbc — доля LP, заблокированного навсегда (позиция DAMM v2, а не сожжённый LP-mint)
  };
  socials?: { twitter?: string; telegram?: string; website?: string };  // только https
  image?: string;           // только наш URL `…/media/<sha40>.<ext>`, никогда внешний
  unzeen?: { launch: true; rules: UnzeenRule[] };   // только для запусков через Unzeen
}

interface TokenTrade extends FeedEvent {
  trader: string;           // публичный адрес для чужих сделок; "unzeen" для vault пула
  tags: ("whale" | "dev" | "sniper")[];   // "dev" никогда не ставится на сделки vault и на Unzeen-запуски
}
```

- **Холодный mint.** `/safety` или `/api/tokens/:mint` для mint без снимка ставит его в очередь и отвечает `202`. Очередь разбирается индексатором **пачкой на фиксированном тике** (≈ 60 с ± джиттер, тик не зависит от запросов), пачка добивается приманками до фиксированного размера — сторонний RPC не видит, какой mint искали. До тика `pending` видят **все** (нельзя отличить «я первый» от «кто-то искал минуту назад»). После тика mint 7 дней обновляется по расписанию вместе с приманками того же тика. Повторять запрос через `retryAfterMs`; если снова `202` — mint ждёт следующего тика (очередь ограничена, на тик берётся не больше 4 настоящих mint).
- **`/safety` для известного mint**: `200` со снимком; пока индексатор не сделал первый снимок (новый токен ленты) — тоже `202`.
- **Публичный `GET /api/tokens`** строится только из `tokens` (токены, которыми торговал пул). Mint, найденные поиском, и приманки туда не попадают никогда.
- **Unzeen-запуск** (токен создан через пул): `dev` отсутствует, `holders.devPct = null`, `unzeen.rules` — правила, которые реестр применяет принудительно: `creator_initial_buy_locked_<N>h` (лок первой покупки, по умолчанию `_24h`), `initial_buy_cap_<P>pct` (кап позиции, по умолчанию `_5pct`; дробный — `initial_buy_cap_<B>bps`), `authorities_revoked` (если снимок подтверждает: mint и freeze authority отозваны). Доля и продажи анонимного создателя из реестра **не считаются и не публикуются** (T1). Vault пула в топе — отдельной строкой `unzeenPoolPct`.
- **`/trades?filter=`**: `unzeen` — сделки пула (`trader: "unzeen"`, тег `whale` при `solAmount ≥ 1 SOL`); `all` — все сделки mint (пока полной ленты нет — то же, что `unzeen`); `whales` — сделки с тегом `whale`; `dev` — сделки дева (для Unzeen-запусков всегда `[]`). `whales`/`dev` при `PoolInfo.features.fullTrades = false` → `400 feature_disabled`. Пагинация `before=<id>` по `id` из ответа с тем же `filter`; `limit` ≤ 200. Неизвестный mint → `404`.

### Правила создателя (v0.5, реестр)
- Применяются к anon-ключу, который создал токен через `create` (запись прав создателя в реестре; наружу не отдаётся).
- **Лок первой покупки.** Токены, полученные первой покупкой `create`, залочены на `PoolInfo.launchRules.lockSecs` (по умолчанию 24 ч, конец лока округлён вверх до часа). Пока лок действует, `sell` и `withdraw_token` этого mint принимаются, только если после них на балансе остаётся не меньше залоченного количества; иначе → `423 creator_locked`. Докупленные позже токены не залочены.
- **Кап позиции.** Позиция создателя через пул (доступно + в hold + оценка ещё не исполненных buy) не может превысить `capBps` саплая (по умолчанию 5 %). `create` с первой покупкой больше `launchRules.maxInitialBuyLamports` → `422 creator_cap`. `buy` создателя: оценка токенов — верхняя граница (по начальной кривой площадки и по текущей цене, берётся меньшая, но не меньше `minOut`); если позиция с ней > капа → `422 creator_cap`. Выведенные из пула токены (`withdraw_token`) в позицию не входят.
- Ответы `423`/`422` получает только сам создатель (подписанный запрос), публично ничего не раскрывается.

### Правила исполнения действий
- **Режимы исполнения (`exec`)** для buy/sell/create:
  - `delayed` (по умолчанию): действия копятся и исполняются **эпохами** — граница каждые случайные 30–60 с (одинаково на devnet и mainnet), расписание не зависит от прихода запросов, всё накопленное к границе исполняется пачкой в случайном порядке;
  - `max`: то же, эпоха 5–15 мин;
  - `now`: без эпохи (`not_before` = момент приёма), релейер отправляет сразу; priority fee — единый квантованный compute unit price на все tx пула (не отличает now от остальных), без Jito; исполнение ~1–3 с. Плата — плоская `PoolInfo.fees.nowFeeZat` (за приоритетную полосу, не за fee конкретной tx), входит в hold, из суммы покупки не вычитается. **`now` не защищает от сетевой слежки:** наблюдатель сети сервера (провайдер VPS, ISP) видит запрос и сделку через секунды. UI обязан это сказать.
  - курс для всех режимов — из фонового кэша, без запроса к 1Click в момент действия.
  - `status`: `queued` → `sent` (tx отправлена) → `executed` | `failed`.
- **Курс.** Сумма в SOL считается при приёме по курсу ZEC→SOL (dry-котировка NEAR Intents 1Click на 1 ZEC, обновляется фоном раз в 30–60 с, не по запросу; на devnet — фиксированный) со спредом пула (по умолчанию 0,5 %, ×2 при устаревшей котировке). Курс фиксируется в действии и возвращается в `rate`. Нет курса (котировка старше 120 с) → `503 venue_unavailable`.
- **buy:** SOL = `zecIn` × курс, срезка 0–1 % и округление вниз до 0.001 SOL; hold = ZEC-эквивалент этой SOL-суммы (≤ `zecIn`); неистраченные лампорты (если площадка взяла меньше) возвращаются в ZEC по курсу действия.
- **sell:** держит `amount` токенов; выручка зачисляется в ZEC по курсу действия; непроданный остаток возвращается. Минимум: `minZecOut ≥ minActionZat` **или** оценка по текущей цене токена ≥ `minActionZat`, иначе `below_minimum`.
- **create:** *(сейчас `503 venue_unavailable`, см. выше)* hold = `initialBuyZec` (округление как у buy, если есть, ≥ `minActionZat`) + комиссия запуска (`CREATE_FEE_ZAT`, по умолчанию 100 000 зат). `meta.name` 1–32 символа, `meta.symbol` 1–10 ASCII букв/цифр, `meta.image` — только `data:image/(png|jpeg|webp);base64,…` до 512 КиБ (тело запроса ≤ 1 МиБ). `venue: "jupiter"` → 400.
- **withdraw_zec:** hold = `amount` + комиссия сети (`WITHDRAW_ZEC_FEE_ZAT`, 15 000 зат); выплата с задержкой 1–10 мин (`exec: "max"` — 10–60 мин), готовые выплаты объединяются в одну tx (до 5). `executed` после K подтверждений выплаты; если tx истекла не попав в блок — выплата переотправляется новой tx (двойной выплаты нет). Сумма выплаты ровно `amount`, комиссию сети платит пул из `WITHDRAW_ZEC_FEE_ZAT`.
- **withdraw_token:** держит `amount` токенов; комиссия в ZEC = частей × (капля SOL получателю + рента ATA + fee) по курсу; без `smart` — `to` строка или массив из 1 адреса, задержка 30 с–5 мин (`exec: "max"` — 10–60 мин); со `smart` — длина `to` = `parts`, адреса разные, суммы частей неравные (±20 %), задержка каждой части до `maxDelayMin`.
- **claim** (v0.7): весь `claimable` (или одного `mint`) → `zecBalance` по `lamportsPerZecSell` (`floor`), сразу, без tx в сети. Сбор комиссий в сети делает пул глобально по своему расписанию, не по запросу (запрос claim ничего не делает в Solana, поэтому не связывает токены одного создателя).
- **Creator fee самой launch-tx — пулу** (v0.9, решение владельца 12.10). Комиссия создателя площадки с первой покупки запуска (`create.initialBuyZec`; у fair-launch — покупка всех участников) в `claimable` не попадает: при settle запуска core записывает её размер — точный из события сделки (`relayer_jobs.out_creator_fee`, пишет релейер) или, пока релейер его не пишет, верхнюю оценку `ceil(лампорты покупки × bps / 10 000)` (pump.fun 30 б.п., meteora-dbc 40 б.п.; env `UNZEEN_LAUNCH_CREATOR_FEE_BPS_*`). Первые сборы этого mint уменьшаются на эту сумму, остаток — создателю. Ошибка оценки — только в пользу пула (≤ 0,3 % первой покупки).
- **Пока не поддерживаются** (→ `400 bad_request "op not supported yet"`): `chat`.
- Новое действие при `frozen` → `423 balance_frozen` для **любой** операции (в т. ч. без ZEC-hold).
- `withdraw_token` **всегда**: капля SOL на газ на каждый адрес получателя, случайная задержка, отправка с vault, где пул держит этот mint (общий инвентарь пула: все vault публичны и видны в Verify, «другой vault» приватности не добавлял — D4), каждая часть — отдельной tx. `smart` добавляет только разбиение на N адресов. Если сумма вывода совпадает с недавней покупкой, фронт предупреждает.
- `withdraw_zec`: выплата shielded ZEC, с задержкой/батчингом; пул не хранит outgoing viewing data (OVK discard).
- `create.meta.image`: файл идёт только на наш бэкенд; сервер удаляет метаданные (EXIF), перекодирует и заливает сам.
- `id` действий/ордеров — 128 бит случайных, hex (32 символа).

## Fair-launch (v0.6)

**Внутреннее до 28.10 23:59 UTC.** Спека: `docs/analysis/fair-launch.md`. Суть: создатель открывает окно заявок; участники шлют сумму, зашифрованную **drand tlock** на раунд `R` (позже закрытия окна); до раунда сумм не знает никто, включая оператора (у него только номинал hold). В момент раунда сервер получает подпись раунда, **проверяет её** и расшифровывает заявки; пул делает **одну атомарную tx create+buy** на сумму всех заявок; токены делятся пропорционально, одна цена для всех. v1: только `pumpfun`, без Jito.

Всё ниже существует только при `PoolInfo.features.fairLaunch === true`. Без ключа (v0.7: при выключенном флаге в `PoolInfo` нет ни одной строки «fair»): `GET /api/launches*` → `404 not_found`, `fl_*` → `400 bad_request` (как неизвестная op), полей `fairBids`/`fairLaunches`/`fairLaunch` нет.

### Типы

```ts
interface FairLaunchParams {          // PoolInfo.fairLaunch
  windowsSecs: number[];              // допустимые окна заявок, сек (по умолчанию [120, 300, 600, 1800]; 120 — для демо)
  holdTiersZat: string[];             // номиналы hold, зат, по возрастанию. mainnet: 0.05/0.1/0.25/0.5/1/2.5/5/10 ZEC;
                                      // devnet: 0.001/0.0025/0.005/0.01/0.025/0.05 TAZ (кривая devnet в 30 раз дешевле)
  maxTotalBps: number;                // кап общей покупки, б.п. саплая (2500 = 25 %)
  maxTotalLamports: string | null;    // кап общей покупки в лампортах по кривой ЭТОЙ сети; null — параметры кривой
                                      // ещё неизвестны (fl_create → 503 venue_unavailable)
  creatorMaxLamports: string | null;  // кап заявки создателя (= launchRules.maxInitialBuyLamports, 5 % саплая)
  minBidsForCount: number;            // 5: меньше заявок → result.bids = "<5"
  drand: {
    chainHash: string;                // "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971" (quicknet)
    publicKey: string;                // hex G2, 96 байт (quicknet)
    genesis: number;                  // 1692803367 (unix СЕКУНДЫ)
    period: number;                   // 3 (сек)
    scheme: "bls-unchained-g1-rfc9380";
  };
}

type FairLaunchStatus =
  | "open"        // заявки принимаются (publishedAt ≤ now < closeAt)
  | "closed"      // окно закрыто, ждём раунд drand (now < roundTime или beacon ещё не получен)
  | "revealing"   // раунд наступил, сервер получает/проверяет beacon и расшифровывает
  | "executing"   // задание create+buy у релейера
  | "launched"    // tx подтверждена, доли начислены
  | "failed"      // см. failure; все hold сняты, комиссия создателю возвращена
  | "cancelled";  // создатель отменил до closeAt; все hold сняты

interface FairLaunch {                // публичный, без подписи, одинаков для всех
  id: string;                         // 32 hex (16 байт) = launchId в plaintext заявки
  venue: "pumpfun";
  meta: { name: string; symbol: string };   // картинку запуска сервер не отдаёт до launched (см. ниже)
  status: FairLaunchStatus;
  publishedAt: number;                // unix мс: граница эпохи Delayed после fl_create (не момент запроса)
  closeAt: number;                    // unix мс = publishedAt + windowSecs·1000
  drand: {
    round: number;                    // R = R(closeAt + 30 с) + 1 (v0.8); шифровать ровно на него
    roundTime: number;                // t(R), unix мс (≥ closeAt + 30 с)
    signature?: string;               // hex 48 байт, после проверки beacon (status ≥ executing): проверяемо офлайн
  };
  commitment?: {                      // с момента closed (см. «Commitment»)
    root: string;                     // hex sha256, 64 символа
    attestation?: {                   // появляется, когда memo-tx с корнем подтверждена на Solana
      solanaTx: string;               // подпись tx SPL Memo; data memo = ровно `root` (64 hex, без префикса)
      slot: number;
      signer: string;                 // ключ аттестаций fair-launch (v0.8: отдельный от ключа Verify; не vault, не creator)
      matches: boolean;               // memo, прочитанный релейером из ПОДТВЕРЖДЁННОЙ tx, == root (серверная проверка)
      blockTime: number | null;       // v0.8: время блока memo-tx, unix СЕКУНДЫ
      beforeRound: boolean;           // v0.8: blockTime·1000 + 2000 < drand.roundTime. UI пишет «anchored before the round»
                                      // ТОЛЬКО при true; иначе нейтрально: «anchored after the round — inclusion still checkable, timing not proven»
    };
  };
  result?: {                          // только launched
    mint: string; solanaTx: string;
    totalLamports: string;            // S — потрачено на покупку (с комиссией площадки)
    tokenAmount: string;              // T — куплено всего, базовые единицы
    decimals: number;
    priceSol: string;                 // S/T в UI-единицах (SOL за 1 целый токен), одна для всех
    bids: number | "<5";              // число ВАЛИДНЫХ заявок; < minBidsForCount → "<5"
    oversubscribed: boolean;          // сумма заявок > maxTotalLamports, все урезаны в одной пропорции
  };
  failure?: "no_bids" | "drand_unavailable" | "venue_unavailable" | "tx_failed" | "internal";   // internal (v0.8): набор заявок не совпал с корнем
  rules: UnzeenRule[];                // "fair_launch_sealed_bids" + правила создателя (lock/cap)
}

interface FairBid {                   // Portfolio.fairBids (только владельцу)
  launchId: string;
  holdZat: string;                    // номинал hold
  status: "sealed"      // принята, ждёт раунда
        | "cancelled"   // fl_cancel / отмена запуска создателем; hold снят
        | "invalid"     // после раунда: не расшифровалась / чужой ключ / не тот запуск / сумма вне [minActionZat, holdZat]; hold снят
        | "revealed"    // расшифрована, участвует, ждёт исполнения
        | "settled"     // токены начислены
        | "released";   // запуск failed; hold снят полностью
  amountZat?: string;                 // расшифрованная сумма (revealed/settled/released)
  tokenAmount?: string;               // settled: начислено токенов
  chargedZat?: string;                // settled: списано зат (≤ amountZat)
  releasedZat?: string;               // settled/released/invalid/cancelled: возвращено на доступный баланс
  proof?: { leaf: string; path: string[] };   // с момента closed: доказательство включения (hex), см. «Commitment»
}

interface OwnFairLaunch {             // Portfolio.fairLaunches (только создателю)
  launchId: string;
  status: "scheduled" | FairLaunchStatus;   // scheduled — ещё не опубликован (now < publishedAt)
  publishedAt: number; closeAt: number;
}
```

### Операции (`POST /api/actions`, подпись/nonce/pad как у всех)

```ts
type SignedAction = /* ...v0.5... */
  | { op: "fl_create"; venue: "pumpfun"; meta: { name: string; symbol: string; image?: string }; windowSecs: number }
  | { op: "fl_bid"; launchId: string; holdZat: string; ciphertext: string }
  | { op: "fl_cancel"; launchId: string }
  | { op: "fl_cancel_launch"; launchId: string };
// ActionReceipt: fl_create → { id, status: "queued", launchId }; fl_bid → { id, status: "queued" };
//                fl_cancel / fl_cancel_launch → { id, status: "executed" }. Повтор того же запроса → тот же ответ.
```

| op | Проверки и эффект | Ошибки |
|---|---|---|
| `fl_create` | `meta` по правилам `create` (картинка ≤ 512 КиБ, EXIF чистит релейер); `windowSecs ∈ windowsSecs`; hold `createFeeZat`. Запуск появляется в `GET /api/launches` на ближайшей **границе эпохи Delayed** (30–60 с), не в момент запроса. Комиссия списывается при `launched`, иначе возвращается. Creator fee площадки от launch-tx остаётся пулу | `400 bad_request`, `422 insufficient_balance`, `503 venue_unavailable` (нет параметров кривой / `createEnabled=false`) |
| `fl_bid` | Запуск опубликован и `open`, `now < closeAt`, заявок < 1024 (иначе `409 launch_full`); `holdZat ∈ holdTiersZat`; `ciphertext` ≤ 1024 байт, age-armor со stanza `tlock <R> <quicknet hash>` (R = `drand.round` запуска); **одна активная заявка** на (ключ, запуск); hold `holdZat`. Создатель: `holdZat` ≤ наименьшего номинала, покрывающего `creatorMaxLamports` по текущему курсу | `404 not_found` (нет/не опубликован), `409 launch_closed`, `409 already_bid`, `400 bad_request` (номинал не из сетки), `400 bad_ciphertext`, `422 insufficient_balance`, `422 creator_cap` |
| `fl_cancel` | Своя `sealed` заявка, `now < closeAt`: hold → доступно, ciphertext удаляется. Изменить сумму = отменить + новая заявка | `404 not_found` (нет активной заявки), `409 launch_closed` |
| `fl_cancel_launch` | Только создатель (иначе 404), `now < closeAt` (в т. ч. до публикации): все заявки `cancelled`, все hold и комиссия возвращаются, запуск `cancelled` | `404 not_found`, `409 launch_closed` |

### Plaintext заявки (64 байта) и шифрование

```
off len поле
0   4   magic "UZFL" (0x55 0x5a 0x46 0x4c)
4   1   version = 1
5   2   chainId (байты PoolInfo.chainId: 02 02 devnet, 01 01 mainnet)
7   16  launchId (сырые 16 байт FairLaunch.id)
23  32  anonPubkey (ed25519, тот же ключ, что подписывает запрос)
55  8   amountZat (u64 LE), minActionZat ≤ amountZat ≤ holdZat
63  1   0x00
```
- Фронт: `ciphertext = await timelockEncrypt(FairLaunch.drand.round, Buffer.from(plaintext), staticQuicknetClient)` из **`tlock-js@0.9.0`** — строка age armor (`-----BEGIN AGE ENCRYPTED FILE-----`). **Никаких запросов к drand из браузера:** ChainClient статический, `info()` возвращает захардкоженные `chainHash`/`publicKey` (assert против `PoolInfo.fairLaunch.drand`), `get`/`latest` бросают ошибку. Таймер — локально по `roundTime`.
- Сумма выбирается пользователем, номинал hold — наименьший ≥ суммы (пользователь может поднять). Свою сумму и ciphertext фронт хранит только локально (зашифрованно), для показа и проверки включения.
- Сервер при приёме смотрит только заголовок (раунд, chain hash) — расшифровать до раунда нельзя никому.
- Векторы: `core/testdata/fl-vectors.json` (plaintext → hex; ciphertext tlock-js на раунд 1000 + подпись раунда → plaintext).

### Reveal и распределение (сервер)
1. В `roundTime` сервер берёт beacon раунда `R` у relay drand (по кругу из 4), **проверяет BLS-подпись** против `drand.publicKey` и только потом расшифровывает. Подложный/недоступный beacon не делает ни одну заявку invalid. Нет валидного beacon за 60 мин → `failed (drand_unavailable)`.
2. Заявка валидна, если расшифровалась и `magic/version/chainId/launchId` совпали, `anonPubkey` = автор заявки, `minActionZat ≤ amountZat ≤ holdZat`. Иначе `invalid` (hold снимается сразу, видит только владелец).
3. Курс `lamportsPerZecBuy` — один для всех, фиксируется на момент reveal. `L_i = floor(amountZat_i · rate / 1e8)`; заявка создателя урезается до `creatorMaxLamports`. Если `Σ L_i > maxTotalLamports` — все `L_i` режутся в одной пропорции (`oversubscribed`). Сумма покупки округляется вниз до 0.001 SOL (D10). Меньше 0.001 SOL или 0 валидных заявок → `failed (no_bids)`.
4. После подтверждения tx: участник получает `floor(T · e_i / E)` токенов и платит `ceil(S · e_i / E)` лампортов в ZEC по курсу reveal (`chargedZat ≤ amountZat ≤ holdZat`), остаток hold возвращается. Пыль округления остаётся пулу.
5. Правила создателя: его доля ≤ 5 % саплая (по построению, см. спеку §4), токены создателя из запуска залочены на `launchRules.lockSecs`; для остальных лока нет. Обход вторым ключом не обнаружим — бейдж «rules apply to the launching key».

### Commitment (проверка включения)
В момент `closed` сервер публикует `commitment.root` — корень Merkle-дерева по всем `sealed` заявкам:
- `leaf = sha256(0x00 ‖ utf8(ciphertext))` — ровно строка `ciphertext` из тела `fl_bid`;
- листья сортируются по возрастанию (байтово) и добиваются случайными 32-байтными листьями до **ровно 1024** (v0.8: глубина всегда 10, длина доказательства ничего не говорит о числе заявок; заявок на запуск ≤ 1024);
- `node = sha256(0x01 ‖ min(a, b) ‖ max(a, b))` (пара упорядочена байтово, направление в пути не нужно);
- проверка: `h = leaf; for s of path: h = node(h, s); h === root`.
`FairBid.proof` даётся владельцу с момента `closed`. Ciphertext после reveal удаляется с сервера и **никогда не публикуется** (после раунда его расшифрует кто угодно).

**Аттестация на Solana (решение владельца).** Корень вычисляется в момент закрытия окна — **до** раунда drand (v0.8: раунд не раньше чем через 30 с после закрытия), когда расшифровать заявки не может никто; после закрытия набор заявок не меняется. Сразу после закрытия пул отправляет memo-tx (программа SPL Memo) от отдельного ключа аттестаций; содержимое memo — только 64 hex корня, без префиксов (нейтрально до 28.10). Слот tx — неподделываемая метка времени: корень зафиксирован раньше `roundTime`. Когда tx подтверждена, в `commitment.attestation` появляются `solanaTx`, `slot`, `signer`.
Проверка (фронт / любой): получить tx по `solanaTx` у любого RPC или в эксплорере → подписант = `signer`, есть инструкция `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` с data = `root` (UTF-8) → `blockTime`/`slot` раньше `drand.roundTime`. Плюс своё доказательство: `verify(sha256(0x00 ‖ ciphertext), proof.path, root)`. Серверная проверка: релейер после подтверждения читает tx из сети и отдаёт фактический memo, core сравнивает его с `root` → `matches`. Это удобство; независимая проверка — по ссылке на эксплорер (прямых запросов браузера к сторонним RPC нет). `matches: false` — инцидент, UI показывает предупреждение.
Если memo-tx не прошла — запуск продолжается (аттестация не блокирует reveal), поле `attestation` отсутствует.

### Публично / приватно
| | До `closeAt` | `closeAt` → раунд | После раунда |
|---|---|---|---|
| мета, `closeAt`, `R` | публично | публично | публично (картинка — после `launched`, в `Token`) |
| число заявок | никому | никому | `result.bids`, если ≥ 5, иначе `"<5"` |
| суммы заявок | никому (у оператора только номинал) | никому | только владельцу (`fairBids`) |
| commitment root + memo-tx аттестации | — | публично | публично |

`GET /api/launches[?status=open|closed|revealing|executing|launched|failed|cancelled][&limit≤100]` — опубликованные запуски, новые первыми; `Cache-Control: public, max-age=5`; без подписи, ответ одинаков для всех. `GET /api/launches/:id` — один запуск; неопубликованный или неизвестный → 404. Опрос фронтом — с одинаковым интервалом для всех зрителей страницы (3–5 с), без привязки к своим действиям. Лента (`/api/feed`, WS) после исполнения получает обычные `create` + `buy` с одной подписью.

## Verify (v0.7)

Спека: `docs/analysis/verify.md`; решения лида — STATUS.md. Проверка честности пула **без viewing key**: обязательства — Merkle-sum деревья (по одному на актив), активы на Solana — снимок балансов vault с подписью каждого vault, резерв ZEC — **заявлен оператором** (доказать без раскрытия нот нельзя; ZK proof of reserves — roadmap).

### Снимок
- Раз в сутки в **00:00 UTC** (mainnet, расписание не зависит от действий пользователей). Devnet — ручная команда оператора `unzeen-api verify-snapshot` (и по желанию тот же суточный график, `UNZEEN_VERIFY_DAILY=1`).
- Согласованность: на время снимка (≤ 120 с) релейер не берёт новые задания; core ждёт, пока нет tx в полёте и неучтённых результатов (≤ 90 с, иначе снимок пропускается и повторяется через 10 мин). Затем релейер пишет балансы vault на одном `finalized`-слоте и подписи vault, core строит деревья в одной транзакции `REPEATABLE READ`.
- Корень подписывает **ключ аттестаций пула** (тот же, что у fair-launch) и якорит его memo-tx на Solana: data memo — **только 64 hex `rootsDigest`**, без префиксов. Подпись и якорь появляются в снимке, когда memo-tx подтверждена.
- Хранение: снимки, корни, суммы, vault — **вечно** (публичная история). Узлы деревьев и привязки кусков к ключам — **48 ч**, после этого доказательство за снимок получить нельзя (скачайте JSON).

### Обязательства и хеши
- Актив: ZEC (`asset` = 32 нуля) и каждый mint (`asset` = 32 байта base58-декода mint). Значение ключа = `available + held` (включая hold действий и заявок fair-launch, и замороженные балансы). Нулевые не входят.
- **Округление вверх** до гранулы `g`: ZEC `100000` зат (0.001 ZEC), mint `10^decimals` (1 целый токен).
- **Разбиение:** округлённое значение режется на `s ∈ {2,3,4}` случайных кусков, кратных `g` (нулевые допустимы), сумма кусков = округлённое значение.
- **Паддинг:** все деревья снимка одного размера `N = max(1024, 2^⌈log2(2 × max кусков в дереве)⌉)`; пустые места — листья-заглушки (`value = 0`, случайные pubkey и blind), неотличимые по хешу. Позиции перемешаны (CSPRNG).
- Хеши — SHA-256, целые big-endian:
```
leaf = SHA256("unzeen/verify/v1/leaf" ‖ chainId[2] ‖ u32(snapshotId) ‖ asset[32] ‖ anonPubkey[32] ‖ u8(piece) ‖ u64(value) ‖ blind[32])
node = SHA256("unzeen/verify/v1/node" ‖ L.hash ‖ u128(L.sum) ‖ R.hash ‖ u128(R.sum)),   sum(node) = L.sum + R.sum
rootsDigest = SHA256("unzeen/verify/v1/snapshot" ‖ chainId[2] ‖ u32(snapshotId) ‖ u64(takenAtSec) ‖ u32(N)
                     ‖ u64(solanaSlot) ‖ u32(zcashHeight) ‖ u64(zecReserveZat) ‖ u32(число деревьев)
                     ‖ для каждого дерева по возрастанию asset: asset[32] ‖ root.hash[32] ‖ u128(root.sum))
operator.sig = ed25519(ключ аттестаций, rootsDigest — 32 байта)     // покрывает и резерв ZEC
vault.sig    = ed25519(ключ vault, utf8("unzeen/verify/v1/vault\n" + chainId + "\n" + snapshotId + "\n" + address))
```
- Узел коммитит **обе** суммы детей (иначе можно занизить итог), значения `u64` — отрицательных листьев нет. `snapshotId` и новый `blind` в каждом снимке — листья разных снимков не связать.

### Типы
```ts
type AssetId = "ZEC" | "SOL" | string;    // SOL — комиссии создателей к выплате (asset = 32×0xFF, гранула 0.001 SOL); string = base58 mint

interface VerifySnapshotSummary {
  id: number;
  takenAt: number;                        // unix мс, округлено вниз до минуты (= takenAtSec · 1000)
  rootsDigest: string;                    // hex 32 байта
  anchor?: { solanaTx: string; slot: number; matches: boolean; blockTime: number | null };   // memo-tx подтверждена; matches — memo из tx == rootsDigest
}

interface VerifySnapshot extends VerifySnapshotSummary {
  chainId: string;                        // "0202" | "0101"
  leaves: number;                         // N, одинаков для всех деревьев
  solanaSlot: number;                     // finalized-слот снимка vault
  zcashHeight: number;                    // высота, на которой оператор заявил резерв
  operator?: { pubkey: string; sig: string };   // base58; ключ аттестаций пула (фронт сверяет с захардкоженным) + подпись rootsDigest
  trees: { asset: AssetId; decimals: number; granule: string; root: string; sum: string }[];  // sum — базовые единицы, целое
  vaults: {
    address: string;                      // base58 (это и есть ed25519 pubkey)
    sig: string;                          // base58, vault.sig выше
    lamports: string;
    tokens: { mint: string; amount: string }[];  // базовые единицы
  }[];
  committedLamports: string;              // SOL, уже обещанный заданиям в очереди (buy/create/fair_create + газ выводов): вычитается из покрытия
  rateLamportsPerZecSell?: string;        // курс, по которому SOL засчитывается в покрытие ZEC (нет — курса не было)
  zecReserve: { amountZat: string; height: number; attested: true };   // округлено ВНИЗ до 0.01 ZEC; заявлено оператором, не доказано
}

interface VerifyProof {                   // GET /api/verify/proof (подписанный), только владельцу
  snapshotId: number;
  proofs: {
    asset: AssetId; decimals: number;
    pieces: {
      piece: number; leafIndex: number;
      value: string;                      // базовые единицы, кратно грануле
      blind: string;                      // hex 32 байта
      path: { hash: string; sum: string }[];   // соседи снизу вверх; сосед справа, если бит leafIndex на этом уровне = 0
    }[];
  }[];                                    // пусто, если в снимке у ключа ничего не было
  truncated: boolean;                     // > 12 активов: ZEC + 11 случайных
  pad: string;                            // пробелы: ответ всегда ровно 65536 байт (64 КиБ), размер не выдаёт число активов
}
```

### Проверка в браузере
1. `GET /api/verify` (или `/:id`) → пересчитать `rootsDigest` из полей снимка, проверить `operator.sig` (ed25519, `@noble/curves`) и `vault.sig` каждого vault.
2. `GET /api/verify/proof` (по кнопке, без автоопроса) → для каждого куска: лист из `(chainId, snapshotId, asset, свой pubkey, piece, value, blind)`, подъём по `path` → совпадает с `trees[asset].root` и `.sum`. Показать «committed ≥ ваш баланс на takenAt» (сумма кусков).
3. Солвентность: по mint `sum ≤ Σ vault.tokens[mint]` (проверяемо); по ZEC `sum ≤ zecReserve.amountZat + (Σ vault.lamports − committedLamports) · 1e8 / rateLamportsPerZecSell` (часть ZEC — «attested»).
4. Якорь: ссылка на `anchor.solanaTx` в эксплорере (по клику). Доказательство — только «Download JSON», **не в localStorage**.

### Ошибки и лимиты
- `/api/verify`: нет ни одного снимка → `404 not_found`. `/api/verify/:id` неизвестен → 404.
- `/api/verify/proof`: `?snapshot=` не последний и не предыдущий, или данные уже удалены (48 ч) → `404`. Лимит 10/мин на ключ (`429 rate_limited`). `Cache-Control: no-store`. Публичные — `public, max-age=300` (история — 60).

## Ордера (v0.8)

Спека: `docs/analysis/orders.md`; решения лида — STATUS.md. Ордер — **запись только в реестре пула** с hold; в цепочке его нет. Когда условие выполнилось, ордер превращается в обычный `buy`/`sell` в эпоху (`delayed` 30–60 с или `max` 5–15 мин) с округлением D10: на цепочке сделка неотличима от ручной, и в момент исполнения от пользователя нет HTTP-запроса.

| `kind` | Условие (цена `p` с тика индексатора) | Сделка | `amount` / hold |
|---|---|---|---|
| `limit_buy` | `p ≤ trigger` | buy | зат |
| `limit_sell` | `p ≥ trigger` | sell | токены |
| `take_profit` | `p ≥ trigger` (сервер = `limit_sell`; «+X % от входа» считается **только в браузере**, на сервер уходит абсолютная цена) | sell | токены |
| `stop_loss` | `p ≤ trigger` **на 2 тиках подряд** | sell | токены |

- **Только mint, которыми торговал пул** (есть в публичном `GET /api/tokens`), площадка `pumpfun`, на кривой. Иначе `422 order_unsupported_mint`. Токен ушёл в AMM → открытые ордера `failed` (`graduated`), hold освобождается.
- **Цена — только с тика индексатора** (раз в 45–75 с, по всем токенам пула сразу, независимо от ордеров). Ордера не порождают ни одного запроса к RPC.
- **Защита исполнения — от цены триггера:** buy `minOut = lamports / (trigger · (1 + slippage))`, sell `minLamports = amount · trigger · (1 − slippage)`. Не исполнилось по slippage → ордер `failed` (`slippage`), hold освобождён (перевзвода в MVP нет).
- **Hold** берётся при создании (как у действия: `insufficient_balance`, `balance_frozen`, `creator_locked`, `creator_cap` для покупки создателя, `below_minimum`: для sell — по стоимости `amount × trigger`). При срабатывании hold переходит на новое действие без изменения баланса (для buy неиспользованный после D10 остаток сразу возвращается).
- **TTL** 1–72 ч (по умолчанию 24 ч), `expiresAt` вверх до часа; истёк → `expired`, hold освобождён.
- **Отмена** — только из `open` (`409 order_not_open` иначе; чужой/неизвестный — 404). Ответ `{ id, status: "cancelled" }`.
- **Лимиты:** 10 открытых на ключ, 4 на ключ и mint (`422 order_limit`); 1000 открытых на пул (`503 venue_unavailable`).
- **Ответ `order_create`:** `{ id, status: "open" }` (повтор того же запроса — тот же ответ).
- **Хранение (D1):** открытый ордер — пока открыт (≤ 72 ч); через 24 ч после закрытия стираются сумма, цена, mint, slippage и связь с действием (ордер пропадает из `Portfolio.orders`); через 48 ч строка удаляется.
- **Публично ничего:** ни счётчиков, ни стакана. UI: «Stop-loss checks the price about once a minute and executes in the next batch. It is not a guaranteed exit in a crash.»

## Кабинет создателя (v0.9)

`GET /api/creator` — подписанный (как `/api/portfolio`: pubkey только в заголовке, повтор nonce → `409 replay`, лимит по ключу). Ответ `CreatorCabinet`, `Cache-Control: no-store`, паддинг до кратного **4096** байт.

- **Только свои токены.** Список строится по правам создателя в реестре (ключ, который сделал `create` / `fl_create`). Чужой ключ, ключ без запусков, несуществующий ключ — `{ tokens: [] }` того же размера (по размеру ответа не отличить «не создатель» от создателя нескольких токенов, пока их список укладывается в 4096 байт).
- **T1.** Ничего из кабинета не публикуется нигде: публичные `Token`, `TokenSafety`, лента, `/api/stats` не содержат ни комиссий создателя, ни его позиции, ни лока, ни признака «этот токен — чей-то». Числа о создателе есть только в этом ответе и в `Portfolio.claimable`.
- **Откуда числа:** `fees` — реестр (`claimable` за вычетом комиссии самой launch-tx, см. claim); `volumeLamports`/`trades` — сделки пула по mint (то же, что в публичной ленте); `holders`, `status`, `curveProgressPct` — последний снимок индексатора (тик, ≈ 60 с; запрос кабинета индексатор не дёргает); `lock`/`cap` — правила создателя в реестре (см. «Правила создателя»).
- **Требование к индексатору (INTEL.md):** число холдеров кладётся в снимок как `holders.count` (целое: владельцы с ненулевым балансом, без аккаунтов bonding curve / пула AMM; vault пула считаются как обычные владельцы). Пока его нет, `holders = null`.
- **UI:** кнопка «Claim» = `POST /api/actions {op:"claim", mint}` (активна при `claimableLamports` ≥ эквивалента `minActionZat` по `lamportsPerZecSell`). Подписи: «Fees from your launch buy stay with the pool», «Fees are collected by the pool every 6–12 h». Позиция и лок — только в кабинете; не показывать их на публичной странице токена даже владельцу (скриншоты).

## Статистика (v0.9)

`GET /api/stats` — публичный, без подписи и cookies, одинаков для всех, `Cache-Control: public, max-age=3600`.

- **Раз в сутки.** Снимок строится один раз после 00:00 UTC (mainnet — автоматически, `UNZEEN_STATS_DAILY`; devnet — ручная команда `unzeen-api stats-snapshot`) и хранится; ручка отдаёт последний сохранённый. **Живых агрегатов нет** (H6): ни одно число не меняется в момент депозита или сделки. Все данные — строго до `asOf` (00:00 UTC дня снимка), повторный расчёт в тот же день даёт те же числа.
- **Источники.** `volumeSol`, `trades`, `launches`, `byVenue`, `topTokens` — только сделки пула, уже публичные в Solana (лента). Единственное число из реестра — `zecShielded`.
- **`zecShielded`.** Сумма зачисленных shielded-депозитов, вниз до 1 ZEC (`UNZEEN_STATS_ZEC_ROUND_ZAT`, не мельче 0.01 ZEC). Публикуемое значение меняется, только если с прошлого изменения зачислено **≥ 5 новых депозитов** — приращение никогда не равно одному депозиту. Пока депозитов < 5 — `"<5"`.
- **k-анонимность (k = 5).** Любая категория, построенная меньше чем из 5 событий, отдаётся строкой `"<5"` (и счётчик, и сумма): `trades`, `launches`, `volumeSol` (по числу сделок), каждая площадка в `byVenue` (все три ключа есть всегда, отсутствующей площадки нет), `zecShielded` (по числу депозитов). В `topTokens` попадают только токены с ≥ 5 сделками пула в окне.
- **Округление:** SOL-объёмы вниз до 0.1 SOL (`UNZEEN_STATS_SOL_ROUND_LAMPORTS`), ZEC вниз до 1 ZEC. Счётчики — точные (публичны в цепочке), но под порогом k.
- **Ничего о создателях** (T1): ни комиссий, ни claim, ни числа запусков на ключ.
- **UI:** строки `"<5"` показывать как «<5» / «fewer than 5»; подпись «Updated daily at 00:00 UTC» с датой из `asOf`; `404` → «Stats appear after the first daily snapshot».

## Дополнительные эндпоинты
| Метод | Путь | Ответ |
|---|---|---|
| GET | `/api/tokens/:mint/chat?before=` | `ChatMessage[]` |
| WS | `/ws/chat/:mint` | поток `ChatMessage` |

`/api/creator` и `/api/stats` реализованы в v0.9 и перенесены в основную таблицу REST.


## Единицы сумм

Правило: **всё, что можно потратить или получить, — целые строки в базовых единицах**; цены и агрегированная статистика — десятичные строки в UI-единицах.

| Поле | Единицы |
|---|---|
| `FeedEvent.tokenAmount`, `holdings[].amount`, `SignedAction.amount` (sell, withdraw_token, order sell) | базовые единицы токена (целое), делить на `10^decimals` |
| `FeedEvent.solAmount`, `claimable[].solAmount`, `Candle.volume` | лампорты (целое) |
| `zecBalance`, `zecHeld`, `zecIn`, `minZecOut`, `withdraw_zec.amount`, `initialBuyZec`, order buy `amount`, `PoolInfo.min*Zat`, `DepositInfo.amountZat` | затоши (целое), 1 ZEC = 10^8 |
| `minOut` (buy) | базовые единицы токена (целое) |
| ZIP-321 `amount=` (строит фронт) | **десятичная** строка ZEC, например `0.05` |
| `priceSol`, `marketCapSol`, `triggerPriceSol`, `Candle.open/high/low/close` | десятичная строка SOL (UI) |
| `PlatformStats.*Sol`, `zecShielded`, `topTokens[].volumeSol` | десятичная строка SOL/ZEC (UI, только для отображения, округлено вниз) или `"<5"` |
| `CreatorToken.fees.*Lamports`, `CreatorToken.volumeLamports` | лампорты (целое) |
| `CreatorToken.lock.lockedAmount`, `cap.capTokens`, `cap.positionTokens` | базовые единицы токена (целое) |
| `ts`, `createdAt` | unix **мс**; исключения — `Candle.time` и memo `expiry` в unix **секундах** |

## Свечи (OHLC)

`GET /api/tokens/:mint/candles?tf=<tf>&from=<unix sec>&to=<unix sec>`
- `tf`: `1m | 5m | 15m | 1h | 4h | 1d`; по умолчанию `5m`.
- `from`/`to` необязательны; по умолчанию — последние 300 баров. Максимум 1000 баров за запрос.
- Бары без сделок не отдаются (lightweight-charts рисует разрыв). Сортировка по `time` по возрастанию.
- Фронт конвертирует строки в `number` только для графика.

## Подпись запросов anon-ключом

Ключ: ed25519. Деривация фиксирована (v1): BIP-39 (12 слов, пустой passphrase) → seed → **SLIP-0010 ed25519 (все сегменты hardened), путь `m/44'/133'/<net>'/0'`** → 32-байтный секрет, где **`<net>` = 0 для mainnet (`chainId 0101`) и 1 для devnet/testnet (`chainId 0202`)**. Одна фраза даёт разные anon-ключи в разных сетях. Смена пути = смена всех anon-ключей, только с миграцией. Векторы: `core/testdata/unz1-vectors.json`, раздел `anonKey` (мнемоника → seed → ключ для каждой сети). Заголовки:

| Заголовок | Значение |
|---|---|
| `x-unzeen-pubkey` | anon pubkey, base58 (32 байта) |
| `x-unzeen-nonce` | 16 случайных байт, hex **в нижнем регистре** (ровно 32 символа), одноразовый |
| `x-unzeen-ts` | unix мс, десятичная запись без знака и ведущих нулей |
| `x-unzeen-sig` | base58 подписи (64 байта) |

Подписываемое сообщение (UTF-8, разделитель `\n`):
```
unzeen/api/v1
<chainId>                // hex 2 байта в нижнем регистре, = PoolInfo.chainId ("0202" devnet, "0101" mainnet)
<METHOD>                 // GET, POST — в верхнем регистре
<path?query>             // сырой request-target как на проводе, например /api/orders?status=open
<hex(sha256(body))>      // для пустого тела — sha256 пустой строки
<nonce>
<ts>
```
Проверки на беке: строгий формат заголовков (иначе 401); `|now − ts| ≤ 60 с`; strict-верификация ed25519 (без malleable-подписей и small-order ключей). Пара `(pubkey, nonce)` хранится в Postgres до `ts + 120 с`.
- `POST /api/actions`: nonce расходуется **в той же транзакции**, что резервирует сумму. Повтор того же подписанного запроса (тот же nonce и то же тело) → **200 с исходным `{id, status}`** (безопасный ретрай после таймаута — фронт шлёт те же заголовки и тело). Тот же nonce с другим телом → `409 replay`. Если действие отклонено (`insufficient_balance` и т. п.), nonce не считается использованным.
- Подписанные GET: повтор nonce → `409 replay`.
- Префикс `unzeen/api/v1` отделяет подпись HTTP-запросов от подписи memo (`unzeen/memo/v1`). Строка `chainId` не даёт подписи к devnet-API работать на mainnet-API.
- Лимиты: in-memory по ключу (по умолчанию 60/мин, burst 20) и по сокету; превышение → `429 rate_limited` с `Retry-After`.
- Векторы: `core/testdata/unz1-vectors.json`, раздел `api`.

## Ошибки

Любой не-2xx ответ:
```ts
interface ApiError { error: { code: ErrorCode; message: string; details?: unknown } }
type ErrorCode =
  | "bad_request"          // 400: невалидное тело/параметры
  | "unauthorized"         // 401: нет/плохая подпись, ts вне окна
  | "not_found"            // 404: неизвестный mint / action / order (чужой action — тоже 404)
  | "replay"               // 409: nonce уже использован
  | "insufficient_balance" // 422: на балансе anon-ключа не хватает
  | "below_minimum"        // 422: сумма меньше PoolInfo.minActionZat
  | "balance_frozen"       // 423: баланс заморожен до ручной проверки (reorg депозита)
  | "graduated"            // 409: токен ушёл с bonding curve этой площадки (pump.fun → AMM); повторить через другую venue
  | "pool_liquidity"       // 503: у vault пула не хватает SOL/ZEC — проблема пула, НЕ баланса юзера (не путать с insufficient_balance)
  | "slippage"             // 422: minOut/minZecOut не выполним по текущей котировке
  | "rate_limited"         // 429: есть заголовок Retry-After (сек)
  | "venue_unavailable"    // 503: площадка/RPC недоступны, площадка не включена, нет курса ZEC/SOL, действия на mainnet выключены
  | "feature_disabled"     // 400 (v0.5): функция выключена на сервере (filter=whales|dev без полной ленты)
  | "creator_locked"       // 423 (v0.5): sell/withdraw_token затрагивает залоченные токены первой покупки создателя
  | "creator_cap"          // 422 (v0.5): create/buy создателя превышает кап позиции (launchRules.capBps); v0.6: fl_bid создателя с номиналом выше капа
  | "launch_closed"        // 409 (v0.6): окно заявок fair-launch закрыто (now ≥ closeAt) или запуск не open
  | "already_bid"          // 409 (v0.6): у ключа уже есть активная (sealed) заявка на этот запуск
  | "bad_ciphertext"       // 400 (v0.6): не age-armor tlock, не тот раунд / chain hash, > 1024 байт
  | "launch_full"          // 409 (v0.8): у запуска уже 1024 заявки
  | "order_limit"          // 422 (v0.8): > 10 открытых ордеров на ключ или > 4 на ключ и mint
  | "order_not_open"       // 409 (v0.8): order_cancel не из open (уже сработал / закрыт)
  | "order_unsupported_mint" // 422 (v0.8): mint не торговался пулом, не pumpfun или graduated
  | "internal";            // 500
```
404 отдаётся и для mint, который сервис не отслеживает (даже если токен существует на Solana); исключения v0.5 — `GET /api/tokens/:mint` и `/safety`, они отвечают `202` и ставят mint в очередь индексатора. `message` — для разработчика, текст UI фронт берёт по `code`.

## Формат memo `unz1` (shielded-депозит)

**Memo собирает и подписывает фронт** anon-ключом; бек только проверяет. В v1 допустим **только `op=deposit`**: все действия выполняются с баланса. Memo — UTF-8 строка `unz1:` + base64url **без паддинга** от бинаря ниже (ZIP-302 text memo, первый байт `u` < 0xF5). Длина бинаря **153** байта без получателя, **196** с shielded-получателем; строка ≤ 267 символов.

```
off  len     поле
0    1       magic 0x55 ('U')
1    1       version = 1
2    1       op = 5 (deposit). Коды 1..4 зарезервированы и отвергаются
3    1       venue = 0
4    32      нули (зарезервировано)
36   8       0 (u64 LE, зарезервировано)
44   32      anon_pubkey (ed25519)
76   8       nonce (u64 LE), случайный
84   4       expiry (u32 LE, unix сек)
88   1       target_kind: 0 нет, 1 shielded receiver (43 байта). 2 (Solana) для deposit запрещён
89   0|43    refund receiver (raw Orchard/Ironwood receiver: d(11) ‖ pk_d(32))
..   64      sig
```
- `sig = ed25519(anon_sk, utf8("unzeen/memo/v1") ‖ chain_id ‖ bytes[0 .. перед sig])`.
- `chain_id` (2 байта, не передаётся; берётся из `PoolInfo.chainId`): байт 0 — Zcash (1 mainnet, 2 testnet), байт 1 — Solana (1 mainnet-beta, 2 devnet). Допустимы только `0202` и `0101`; смешанные (`0102`, `0201`) не используются, сервер с такой конфигурацией не стартует.
- **Refund в v1 не используется (решение лида 12.10).** Фронт **всегда** шлёт `target_kind = 0` и `expiry = now + 24 ч`. Формат не меняется: `target_kind = 1` по-прежнему декодируется и подписывается, но получатель игнорируется — истёкший депозит **всегда зачисляется на баланс**.
- `nonce` для deposit не уникализируется: каждая нота зачисляется отдельно по `(txid, pool, action_index)`. Оплатили тот же QR дважды → зачислены оба платежа. Несколько нот с одним memo в одной tx суммируются.
- `expiry` сравнивается со **временем блока**, в котором tx замайнена (не с часами сервера): истёк, если `block_time > expiry`.

### Что делает сканер с нотой на адрес пула
| Условие | Статус в реестре | Деньги |
|---|---|---|
| < K подтверждений (K = `PoolInfo.confirmations`, по умолчанию 3) | `seen` | ждём |
| ≥ K, memo ещё не получен | `confirmed` | ждём |
| сумма < `minDepositZat` | `dust` | остаются пулу, не зачисляются |
| валидная подпись, не истёк | `credited` | на баланс `anon_pubkey` |
| валидная подпись, истёк (с refund-получателем или без) | `credited` | на баланс (refund не используется) |
| плохая подпись / чужой `chain_id` / не `unz1` / битый / op ≠ deposit | `frozen` | до ручного разбора; pubkey из такого memo не сохраняется |
| зачисленный депозит пропал после reorg | флаг `reorged` | баланс ключа `frozen` (новые действия → `balance_frozen`), в минус не уходит |
| `reorged`-депозит снова в цепочке с ≥ K подтверждениями | флаг снят | `frozen` снимается, если у ключа нет других `reorged` |

Векторы (валидный deposit, deposit с refund, op=buy → отвергнут, плохая подпись, чужая сеть, истёкший): `core/testdata/unz1-vectors.json`, раздел `memo`.
