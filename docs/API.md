# Unzeen — контракт API (бек ↔ фронт)

Источник правды для обеих сторон. Меняет только backend (по согласованию с лидом); frontend работает по нему и мокает, пока бек не готов.

Статус: **v0.4** (12.10, дни 4–5; реализовано в `core/api` + `core/scanner`). Изменения против v0.3:
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
| GET | `/api/tokens/:mint` | `Token & { trades: FeedEvent[] }` — последние **50** сделок по mint, новые первыми |
| GET | `/api/tokens/:mint/trades?before=<id>&limit=50` | `FeedEvent[]` — пагинация истории, `limit` ≤ 200 |
| GET | `/api/tokens/:mint/candles?tf=1m&from=&to=` | `Candle[]` — OHLC для lightweight-charts (см. ниже) |
| GET | `/api/pool` | `PoolInfo` — публичный: UA пула, `chainId`, минимумы, K подтверждений. Без pubkey и без cookies |
| GET | `/api/portfolio` (подписанный) | `Portfolio` — pubkey только в заголовке `x-unzeen-pubkey`, **не в пути** |
| POST | `/api/actions` (подписанный) | `SignedAction` → `ActionReceipt` — все действия только с баланса |
| GET | `/api/actions/:id` (подписанный) | `ActionStatus` — только владельцу (pubkey заголовка = автор действия), иначе 404 |
| GET | `/media/<sha40>.<png\|jpeg\|jpg\|webp\|json>` | картинка/метаданные токена. Только точное имя (40 hex + расширение), без листинга, `Cache-Control: immutable`, `nosniff`, без логов. Остальное — 404 |

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
  claimable: { mint: string; solAmount: string }[];            // пока всегда []
  deposits: DepositInfo[];  // последние 20, новые первыми
  actions: (ActionStatus & {  // v0.4: последние 20 действий владельца (queued первыми)
    id: string;
    kind: "buy" | "sell" | "create" | "withdraw_zec" | "withdraw_token";
  })[];
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
  | { op: "order_create"; venue: Venue; mint: string;
      kind: "limit_buy" | "limit_sell" | "take_profit" | "stop_loss";
      triggerPriceSol: string; amount: string }                                   // amount: ZEC для buy, токены для sell
  | { op: "order_cancel"; orderId: string }
  | { op: "chat"; mint: string; text: string; showCreatorBadge?: boolean }
);

interface Order {
  id: string; venue: Venue; mint: string; kind: string;
  triggerPriceSol: string; amount: string;
  status: "open" | "filled" | "cancelled" | "failed"; createdAt: number; filledTx?: string;
}

interface ChatMessage {
  id: string; mint: string; nick: string;   // nick = hex(sha256("unzeen/chat/v1" ‖ pubkey ‖ mint))[:8]; pubkey/подпись НИКОГДА не отдаются
  text: string; isCreator: boolean; ts: number;
}

interface CreatorToken {
  mint: string; symbol: string; venue: Venue; status: "curve" | "graduated";
  feesEarnedSol: string; feesClaimedSol: string; volumeSol: string; holders: number;
}

interface PlatformStats {
  volumeSol: string; trades: number; launches: number;
  zecShielded: string;   // обновляется раз в сутки, округлено до 1 ZEC (иначе приращение = сумма депозита)
  byVenue: Record<Venue, { volumeSol: string; trades: number }>;
  topTokens: Token[];
}
```

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
- **Пока не поддерживаются** (→ `400 bad_request "op not supported yet"`): `claim`, `order_create`, `order_cancel`, `chat`.
- Новое действие при `frozen` → `423 balance_frozen` для **любой** операции (в т. ч. без ZEC-hold).
- `withdraw_token` **всегда**: капля SOL на газ на каждый адрес получателя, случайная задержка, отправка с vault, где пул держит этот mint (общий инвентарь пула: все vault публичны и видны в Verify, «другой vault» приватности не добавлял — D4), каждая часть — отдельной tx. `smart` добавляет только разбиение на N адресов. Если сумма вывода совпадает с недавней покупкой, фронт предупреждает.
- `withdraw_zec`: выплата shielded ZEC, с задержкой/батчингом; пул не хранит outgoing viewing data (OVK discard).
- `create.meta.image`: файл идёт только на наш бэкенд; сервер удаляет метаданные (EXIF), перекодирует и заливает сам.
- `id` действий/ордеров — 128 бит случайных, hex (32 символа).

## Дополнительные эндпоинты
| Метод | Путь | Ответ |
|---|---|---|
| GET | `/api/orders` (подписанный) | `Order[]` |
| GET | `/api/creator` (подписанный) | `CreatorToken[]` |
| GET | `/api/tokens/:mint/chat?before=` | `ChatMessage[]` |
| WS | `/ws/chat/:mint` | поток `ChatMessage` |
| GET | `/api/stats` | `PlatformStats` |


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
| `PlatformStats.*Sol`, `CreatorToken.*Sol`, `zecShielded` | десятичная строка SOL/ZEC (UI, только для отображения) |
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
  | "internal";            // 500
```
404 отдаётся и для mint, который сервис не отслеживает (даже если токен существует на Solana). `message` — для разработчика, текст UI фронт берёт по `code`.

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
