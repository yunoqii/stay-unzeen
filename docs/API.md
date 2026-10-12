# Unzeen — контракт API (бек ↔ фронт)

Источник правды для обеих сторон. Меняет только backend (по согласованию с лидом); frontend работает по нему и мокает, пока бек не готов.

Статус: **v0.2** (12.10, вечер). Изменения против v0.1: оплата за действие вырезана (memo только `op=deposit`, `/api/intents` и `/api/deposit` удалены, вместо них публичный `GET /api/pool`); memo собирает и подписывает фронт; `/api/portfolio` без pubkey в пути; статусы депозита и минимумы; идемпотентность действий по nonce; правила вывода; коды ошибок `graduated`, `pool_liquidity`, `balance_frozen`, `below_minimum`; исправлены размеры memo (153/196). Тест-векторы: `core/testdata/unz1-vectors.json`.

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
| POST | `/api/actions` (подписанный) | `SignedAction` → `{ id, status }` — все действия только с баланса |
| GET | `/api/actions/:id` (подписанный) | `{ status: "queued" \| "executed" \| "failed", solanaTx?: string, error?: ErrorCode }` — только владельцу (pubkey заголовка = автор действия), иначе 404 |

Подписанные запросы — схема в разделе «Подпись запросов».

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
  chainId: string;          // hex 2 байта для подписи memo, например "0202" (см. memo)
  minDepositZat: string;    // ниже — не зачисляется (остаётся пулу как пыль)
  minActionZat: string;     // минимальная сумма действия с баланса (zecIn / withdraw_zec)
  confirmations: number;    // K: через сколько блоков депозит зачисляется (по умолчанию 3)
}

interface Portfolio {
  zecBalance: string;       // затоши, доступно
  zecHeld: string;          // затоши, зарезервировано действиями в очереди
  frozen: boolean;          // true — баланс заморожен до ручной проверки (reorg)
  holdings: { mint: string; amount: string }[];
  claimable: { mint: string; solAmount: string }[];
  deposits: DepositInfo[];  // последние 20, новые первыми
}

interface DepositInfo {
  amountZat: string;
  status: "credited" | "refund_pending";
  ts: number;               // время зачисления, unix мс, округлено до минуты
}
```

```ts
// Действие с баланса аккаунта (единственный режим)
// anonPubkey/nonce/ts/sig передаются ЗАГОЛОВКАМИ (см. «Подпись запросов»), не в теле.
// create: meta уходит в теле (подписано через sha256(body)), отдельный хеш/канонизация meta не нужны.
type SignedAction = (
  | { op: "buy";  venue: Venue; mint: string; zecIn: string; minOut: string }
  | { op: "sell"; venue: Venue; mint: string; amount: string; minZecOut: string }
  | { op: "create"; venue: Venue; meta: { name: string; symbol: string; image?: string }; initialBuyZec?: string }
  | { op: "claim"; mint?: string }                          // creator fees → баланс; чисто реестровая операция,
                                                            // on-chain сбор fees — по глобальному расписанию пула
  | { op: "withdraw_zec"; to: string; amount: string }       // UA с Orchard/Ironwood receiver; t-адрес и Sapling-only → 400
  | { op: "withdraw_token"; mint: string; amount: string; to: string | string[];   // на новый Solana-адрес
      smart?: { parts: number; maxDelayMin: number } }  // умный вывод: parts 2..5 (длина `to` = parts)
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
- Действия исполняются **батчами** (эпоха 3–10 с плюс случайный джиттер 0–20 с на действие). `status` остаётся `queued` до исполнения.
- `withdraw_token` **всегда**: капля SOL на газ на каждый адрес получателя, случайная задержка, отправка с **другого** vault, чем покупка, каждая часть — отдельной tx. `smart` добавляет только разбиение на N адресов. Если сумма вывода совпадает с недавней покупкой, фронт предупреждает.
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

Ключ: ed25519. Деривация фиксирована (v1): BIP-39 (12 слов, пустой passphrase) → seed → **SLIP-0010 ed25519, путь `m/44'/133'/0'/0'`** → 32-байтный секрет. Смена пути = смена всех anon-ключей, только с миграцией. Заголовки:

| Заголовок | Значение |
|---|---|
| `x-unzeen-pubkey` | anon pubkey, base58 (32 байта) |
| `x-unzeen-nonce` | 16 случайных байт, hex **в нижнем регистре** (ровно 32 символа), одноразовый |
| `x-unzeen-ts` | unix мс, десятичная запись без знака и ведущих нулей |
| `x-unzeen-sig` | base58 подписи (64 байта) |

Подписываемое сообщение (UTF-8, разделитель `\n`):
```
unzeen/api/v1
<METHOD>                 // GET, POST — в верхнем регистре
<path?query>             // сырой request-target как на проводе, например /api/orders?status=open
<hex(sha256(body))>      // для пустого тела — sha256 пустой строки
<nonce>
<ts>
```
Проверки на беке: строгий формат заголовков (иначе 401); `|now − ts| ≤ 60 с`; strict-верификация ed25519 (без malleable-подписей и small-order ключей). Пара `(pubkey, nonce)` хранится в Postgres до `ts + 120 с`.
- `POST /api/actions`: nonce расходуется **в той же транзакции**, что резервирует сумму. Повтор того же подписанного запроса (тот же nonce и то же тело) → **200 с исходным `{id, status}`** (безопасный ретрай после таймаута — фронт шлёт те же заголовки и тело). Тот же nonce с другим телом → `409 replay`. Если действие отклонено (`insufficient_balance` и т. п.), nonce не считается использованным.
- Подписанные GET: повтор nonce → `409 replay`.
- Префикс `unzeen/api/v1` отделяет подпись HTTP-запросов от подписи memo (`unzeen/memo/v1`).
- Векторы: `core/testdata/unz1-vectors.json`, раздел `api`.

## Ошибки

Любой не-2xx ответ:
```ts
interface ApiError { error: { code: ErrorCode; message: string; details?: unknown } }
type ErrorCode =
  | "bad_request"          // 400: невалидное тело/параметры
  | "unauthorized"         // 401: нет/плохая подпись, ts вне окна
  | "not_found"            // 404: неизвестный mint / intent / action / order
  | "replay"               // 409: nonce уже использован
  | "insufficient_balance" // 422: на балансе anon-ключа не хватает
  | "below_minimum"        // 422: сумма меньше PoolInfo.minActionZat
  | "balance_frozen"       // 423: баланс заморожен до ручной проверки (reorg депозита)
  | "graduated"            // 409: токен ушёл с bonding curve этой площадки (pump.fun → AMM); повторить через другую venue
  | "pool_liquidity"       // 503: у vault пула не хватает SOL/ZEC — проблема пула, НЕ баланса юзера (не путать с insufficient_balance)
  | "slippage"             // 422: minOut/minZecOut не выполним по текущей котировке
  | "rate_limited"         // 429: есть заголовок Retry-After (сек)
  | "venue_unavailable"    // 503: площадка/RPC недоступны
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
- `chain_id` (2 байта, не передаётся; берётся из `PoolInfo.chainId`): байт 0 — Zcash (1 mainnet, 2 testnet), байт 1 — Solana (1 mainnet-beta, 2 devnet).
- **Рекомендация фронту:** `target_kind = 0` (без refund) и `expiry = now + 24 ч`. Истёкший депозит без refund всё равно зачисляется на баланс, поэтому разбирать UA пользователя на фронте не нужно. Если когда-нибудь понадобится refund, raw receiver из UA извлекает фронт (F4Jumble + bech32m, ZIP-316); бек принимает только сырые 43 байта.
- `nonce` для deposit не уникализируется: каждая нота зачисляется отдельно по `(txid, pool, action_index)`. Оплатили тот же QR дважды → зачислены оба платежа. Несколько нот с одним memo в одной tx суммируются.
- `expiry` сравнивается со **временем блока**, в котором tx замайнена (не с часами сервера): истёк, если `block_time > expiry`.

### Что делает сканер с нотой на адрес пула
| Условие | Статус в реестре | Деньги |
|---|---|---|
| < K подтверждений (K = `PoolInfo.confirmations`, по умолчанию 3) | `seen` | ждём |
| ≥ K, memo ещё не получен | `confirmed` | ждём |
| сумма < `minDepositZat` | `dust` | остаются пулу, не зачисляются |
| валидная подпись, не истёк | `credited` | на баланс `anon_pubkey` |
| валидная подпись, истёк, есть refund | `refund_pending` | возврат на refund (выплата — позже) |
| валидная подпись, истёк, нет refund | `credited` | на баланс |
| плохая подпись / чужой `chain_id` / не `unz1` / битый / op ≠ deposit | `frozen` | до ручного разбора; pubkey из такого memo не сохраняется |
| зачисленный депозит пропал после reorg | флаг `reorged` | баланс ключа `frozen` (новые действия → `balance_frozen`), в минус не уходит |

Векторы (валидный deposit, deposit с refund, op=buy → отвергнут, плохая подпись, чужая сеть, истёкший): `core/testdata/unz1-vectors.json`, раздел `memo`.
