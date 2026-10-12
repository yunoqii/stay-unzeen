# Unzeen — контракт API (бек ↔ фронт)

Источник правды для обеих сторон. Меняет только backend (по согласованию с лидом); frontend работает по нему и мокает, пока бек не готов.

Статус: **черновик v0** — уточняется в дни 3–5.

## REST

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/api/feed?limit=50` | `FeedEvent[]` |
| GET | `/api/tokens` | `Token[]` |
| GET | `/api/tokens/:mint` | `Token & { trades: FeedEvent[] }` |
| POST | `/api/intents` | тело `IntentRequest` → `PaymentRequest` (UA, сумма, memo, ZIP-321 URI) |
| GET | `/api/intents/:id` | `{ status: "awaiting_payment" \| "seen" \| "executed" \| "failed", tx?: string }` |
| GET | `/api/portfolio/:anonPubkey` | `{ zecBalance: string, holdings: { mint, amount }[], claimable: { mint, solAmount }[] }` (подписанный запрос) |
| POST | `/api/deposit` | `{ anonPubkey }` → `PaymentRequest` (memo `op:"deposit"`) |
| POST | `/api/actions` | `SignedAction` → `{ id, status }` — мгновенные действия с баланса |
| GET | `/api/actions/:id` | `{ status: "queued" \| "executed" \| "failed", solanaTx?: string, error?: string }` |

Все запросы с баланса подписываются anon-ключом: заголовок `x-unzeen-sig` = ed25519(`method|path|body|nonce|ts`), `nonce` одноразовый, `ts` ±60 с.

## WebSocket
`/ws/feed` → поток `FeedEvent`.

## Типы

```ts
type Venue = "pumpfun" | "meteora-dbc" | "jupiter";

interface FeedEvent {
  id: string;
  kind: "buy" | "sell" | "create";
  venue: Venue;
  mint: string;
  symbol: string;
  tokenAmount: string;   // строка, чтобы не терять точность
  solAmount: string;
  solanaTx: string;      // публичная подпись — видна в эксплорере
  ts: number;            // unix ms
  // никаких данных о пользователе — только "unzeen"
}

interface Token {
  mint: string; symbol: string; name: string; image?: string;
  venue: Venue; status: "curve" | "graduated";
  priceSol: string; marketCapSol: string; createdAt: number;
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
type SignedAction = {
  anonPubkey: string; nonce: string; ts: number; sig: string;
} & (
  | { op: "buy";  venue: Venue; mint: string; zecIn: string; minOut: string }
  | { op: "sell"; venue: Venue; mint: string; amount: string; minZecOut: string }
  | { op: "create"; venue: Venue; meta: { name: string; symbol: string; image?: string }; initialBuyZec?: string }
  | { op: "claim"; mint?: string }                          // creator fees → баланс
  | { op: "withdraw_zec"; to: string; amount: string }       // на любой shielded UA
  | { op: "withdraw_token"; mint: string; amount: string; to: string } // на новый Solana-адрес
);
```
