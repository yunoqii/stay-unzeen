# Unzeen — контракт API (бек ↔ фронт)

Источник правды для обеих сторон. Меняет только backend (по согласованию с лидом); frontend работает по нему и мокает, пока бек не готов.

Статус: **черновик v0.1** (12.10: единицы сумм, подпись запросов, memo `unz1`, свечи, ошибки) — уточняется в дни 3–5.

## REST

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/api/feed?limit=50` | `FeedEvent[]` |
| GET | `/api/tokens` | `Token[]` |
| GET | `/api/tokens/:mint` | `Token & { trades: FeedEvent[] }` — последние **50** сделок по mint, новые первыми |
| GET | `/api/tokens/:mint/trades?before=<id>&limit=50` | `FeedEvent[]` — пагинация истории, `limit` ≤ 200 |
| GET | `/api/tokens/:mint/candles?tf=1m&from=&to=` | `Candle[]` — OHLC для lightweight-charts (см. ниже) |
| POST | `/api/intents` | тело `IntentRequest` → `PaymentRequest` (UA, сумма, memo, ZIP-321 URI) |
| GET | `/api/intents/:id` | `{ status: "awaiting_payment" \| "seen" \| "executed" \| "failed", tx?: string }` |
| GET | `/api/portfolio/:anonPubkey` | `{ zecBalance: string, holdings: { mint, amount }[], claimable: { mint, solAmount }[] }` (подписанный запрос) |
| POST | `/api/deposit` | `{ anonPubkey }` → `PaymentRequest` (memo `op:"deposit"`) |
| POST | `/api/actions` | `SignedAction` → `{ id, status }` — мгновенные действия с баланса |
| GET | `/api/actions/:id` | `{ status: "queued" \| "executed" \| "failed", solanaTx?: string, error?: string }` |

Все запросы с баланса (и все GET, помеченные «подписанный») подписываются anon-ключом — схема в разделе «Подпись запросов».

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

interface IntentRequest {
  op: "buy" | "sell" | "create" | "withdraw" | "claim";   // claim — забрать creator fees в shielded ZEC
  venue?: Venue; mint?: string; amount?: string; minOut?: string;
  anonPubkey: string; sig: string;
  meta?: { name: string; symbol: string; image?: string };
  withdrawTo?: string;   // новый Solana-адрес
  refundUA?: string;     // shielded адрес для выплат
}

interface PaymentRequest {
  intentId: string; address: string; amountZec: string;
  memo: string; zip321Uri: string; expiresAt: number;
}
```

```ts
// Действие с баланса аккаунта (основной режим)
// anonPubkey/nonce/ts/sig передаются ЗАГОЛОВКАМИ (см. «Подпись запросов»), не в теле.
type SignedAction = (
  | { op: "buy";  venue: Venue; mint: string; zecIn: string; minOut: string }
  | { op: "sell"; venue: Venue; mint: string; amount: string; minZecOut: string }
  | { op: "create"; venue: Venue; meta: { name: string; symbol: string; image?: string }; initialBuyZec?: string }
  | { op: "claim"; mint?: string }                          // creator fees → баланс
  | { op: "withdraw_zec"; to: string; amount: string }       // на любой shielded UA
  | { op: "withdraw_token"; mint: string; amount: string; to: string | string[];   // на новый Solana-адрес
      smart?: { parts: number; maxDelayMin: number; gasDrop: boolean } }          // умный вывод, опционально
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
  id: string; mint: string; nick: string;   // nick = короткий хэш H(anonPubkey ‖ mint)
  text: string; isCreator: boolean; ts: number;
}

interface CreatorToken {
  mint: string; symbol: string; venue: Venue; status: "curve" | "graduated";
  feesEarnedSol: string; feesClaimedSol: string; volumeSol: string; holders: number;
}

interface PlatformStats {
  volumeSol: string; zecShielded: string; trades: number; launches: number;
  byVenue: Record<Venue, { volumeSol: string; trades: number }>;
  topTokens: Token[];
}
```

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
| `zecBalance`, `zecIn`, `minZecOut`, `withdraw_zec.amount`, `initialBuyZec`, order buy `amount` | затоши (целое), 1 ZEC = 10^8 |
| `minOut` (buy) | базовые единицы токена (целое) |
| `PaymentRequest.amountZec` | **десятичная** строка ZEC (как в ZIP-321 `amount=`), например `"0.05"` |
| `priceSol`, `marketCapSol`, `triggerPriceSol`, `Candle.open/high/low/close` | десятичная строка SOL (UI) |
| `PlatformStats.*Sol`, `CreatorToken.*Sol`, `zecShielded` | десятичная строка SOL/ZEC (UI, только для отображения) |
| `ts`, `createdAt`, `expiresAt` | unix **мс**; исключение — `Candle.time` в unix **секундах** |

## Свечи (OHLC)

`GET /api/tokens/:mint/candles?tf=<tf>&from=<unix sec>&to=<unix sec>`
- `tf`: `1m | 5m | 15m | 1h | 4h | 1d`; по умолчанию `5m`.
- `from`/`to` необязательны; по умолчанию — последние 300 баров. Максимум 1000 баров за запрос.
- Бары без сделок не отдаются (lightweight-charts рисует разрыв). Сортировка по `time` по возрастанию.
- Фронт конвертирует строки в `number` только для графика.

## Подпись запросов anon-ключом

Ключ: ed25519 (BIP-39 → ed25519 в браузере). Заголовки:

| Заголовок | Значение |
|---|---|
| `x-unzeen-pubkey` | anon pubkey, base58 (32 байта) |
| `x-unzeen-nonce` | 16 случайных байт, hex (32 символа), одноразовый |
| `x-unzeen-ts` | unix мс |
| `x-unzeen-sig` | base58 подписи (64 байта) |

Подписываемое сообщение (UTF-8, разделитель `\n`):
```
unzeen/api/v1
<METHOD>                 // GET, POST — в верхнем регистре
<path?query>             // как в запросе, например /api/portfolio/<pk>?x=1
<hex(sha256(body))>      // для пустого тела — sha256 пустой строки
<nonce>
<ts>
```
Проверки на беке: `|now − ts| ≤ 60 с`; пара `(pubkey, nonce)` хранится 120 с, повтор → `409 replay`; для `/api/portfolio/:anonPubkey` pubkey в пути обязан совпадать с заголовком. Префикс `unzeen/api/v1` отделяет подпись HTTP-запросов от подписи memo (`unzeen/memo/v1`), чтобы подпись одного вида нельзя было переиграть как другой.

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
  | "slippage"             // 422: minOut/minZecOut не выполним по текущей котировке
  | "rate_limited"         // 429: есть заголовок Retry-After (сек)
  | "venue_unavailable"    // 503: площадка/RPC недоступны
  | "internal";            // 500
```
404 отдаётся и для mint, который сервис не отслеживает (даже если токен существует на Solana). `message` — для разработчика, текст UI фронт берёт по `code`.

## Формат memo `unz1` (shielded-депозит / команда)

`PaymentRequest.memo` — готовая UTF-8 строка `unz1:` + base64url без паддинга от бинаря ниже. Фронт её не собирает и не разбирает: кладёт в ZIP-321 как есть (`zip321Uri` строит бек). Memo по ZIP-302 — текстовое (первый байт < 0xF5), ≤ 512 байт; `unz1` занимает ≤ ~270 символов.

```
off  len       поле
0    1         magic 0x55 ('U')
1    1         version = 1
2    1         op: 1 buy, 2 sell, 3 create, 4 withdraw, 5 deposit (пополнение баланса)
3    1         venue: 0 none, 1 pumpfun, 2 meteora-dbc, 3 jupiter
4    32        mint (сырой pubkey); для create — sha256(canonical JSON meta), сама meta идёт через /api/intents; для deposit — нули
36   8         min_out (u64 LE); для sell — amount; для deposit — 0
44   32        anon_pubkey (ed25519)
76   8         nonce (u64 LE) — идемпотентность, уникален на anon_pubkey
84   4         expiry (u32 LE, unix сек) — после этого бек не исполняет, а возвращает средства
88   1         target_kind: 0 none, 1 shielded receiver (43 байта, Orchard/Ironwood raw), 2 Solana addr (32)
89   0|43|32   refund / withdraw_to
..   64        sig
```
- `sig = ed25519(anon_sk, "unzeen/memo/v1" ‖ chain_id ‖ bytes[0 .. перед sig])`.
- `chain_id` (2 байта, в memo не передаётся, бек подставляет свой): байт 0 — сеть Zcash (1 mainnet, 2 testnet), байт 1 — кластер Solana (1 mainnet-beta, 2 devnet). Подпись под testnet нельзя переиграть на mainnet.
- Подпись покрывает всё: op, venue, mint/хеш meta, min_out, pubkey, **nonce**, **expiry**, получателя возврата/вывода.
- Сканер исполняет каждую пару `(anon_pubkey, nonce)` ровно один раз (уникальный индекс), поэтому повторный скан после reorg ничего не дублирует.
- Невалидный memo (не `unz1`, плохая подпись, истёк `expiry`) не исполняется. Истёкший, но корректно подписанный memo: средства возвращаются на refund, а если его нет — зачисляются на баланс `anon_pubkey`. Плохая подпись или нечитаемый memo: средства замораживаются до ручного разбора (pubkey без подписи доверять нельзя).
- Размер: 152 байта без получателя, максимум 195 байт.
