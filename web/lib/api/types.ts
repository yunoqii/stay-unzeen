// Mirrors docs/API.md v0.2. Do not diverge: change the contract first.
//
// Units (docs/API.md "Единицы сумм"):
//   - spendable amounts: integer strings in BASE units (token base units, lamports, zatoshis)
//   - prices / stats: decimal strings in UI units
//   - timestamps: unix ms, except Candle.time (unix seconds)

export type Venue = "pumpfun" | "meteora-dbc" | "jupiter";

/** Integer string in token base units: UI = value / 10^decimals. */
export type TokenBaseUnits = string;
/** Integer string in lamports: UI = value / 1e9. */
export type Lamports = string;
/** Integer string in zatoshis: UI = value / 1e8. */
export type Zatoshis = string;
/** Decimal string in UI units (SOL, ZEC, SOL per whole token). */
export type DecimalString = string;

export interface FeedEvent {
  id: string;
  kind: "buy" | "sell" | "create";
  venue: Venue;
  mint: string;
  symbol: string;
  tokenAmount: TokenBaseUnits;
  solAmount: Lamports;
  decimals: number; // token decimals (pump.fun = 6)
  solanaTx: string; // public signature, visible in explorers
  ts: number; // unix ms
  // no user data, only "unzeen"
}

export interface Token {
  mint: string;
  symbol: string;
  name: string;
  image?: string;
  venue: Venue;
  status: "curve" | "graduated";
  decimals: number;
  priceSol: DecimalString; // SOL per 1 whole token
  marketCapSol: DecimalString;
  createdAt: number; // unix ms
}

/** GET /api/tokens/:mint — last 50 trades, newest first. */
export type TokenWithTrades = Token & { trades: FeedEvent[] };

export type CandleTimeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface Candle {
  time: number; // unix SECONDS, bar start
  open: DecimalString;
  high: DecimalString;
  low: DecimalString;
  close: DecimalString;
  volume: Lamports;
}

/** GET /api/pool: public, no pubkey, no cookies. Same for every user. */
export interface PoolInfo {
  /** Pool Unified Address (Orchard/Ironwood receiver only). */
  address: string;
  network: "main" | "test";
  /** 2 bytes hex for the unz1 memo signature: [Zcash 1 main | 2 test][Solana 1 mainnet-beta | 2 devnet], e.g. "0202". */
  chainId: string;
  /** Below this a deposit is not credited (stays with the pool as dust). */
  minDepositZat: Zatoshis;
  /** Minimum amount of an action from the balance (zecIn / withdraw_zec). */
  minActionZat: Zatoshis;
  /** K: blocks until a deposit is credited (default 3). */
  confirmations: number;
}

export interface DepositInfo {
  amountZat: Zatoshis;
  status: "credited" | "refund_pending";
  /** Credit time, unix ms rounded to the minute. */
  ts: number;
}

/** GET /api/portfolio (signed; pubkey only in x-unzeen-pubkey, never in the path). */
export interface Portfolio {
  /** Available. */
  zecBalance: Zatoshis;
  /** Reserved by queued actions. */
  zecHeld: Zatoshis;
  /** true: frozen pending manual review (reorg); new actions -> balance_frozen. */
  frozen: boolean;
  holdings: { mint: string; amount: TokenBaseUnits }[];
  claimable: { mint: string; solAmount: Lamports }[];
  /** Last 20, newest first. */
  deposits: DepositInfo[];
}

/** Body of POST /api/actions. anonPubkey/nonce/ts/sig go in x-unzeen-* headers, not here. */
export type SignedAction =
  | { op: "buy"; venue: Venue; mint: string; zecIn: Zatoshis; minOut: TokenBaseUnits }
  | { op: "sell"; venue: Venue; mint: string; amount: TokenBaseUnits; minZecOut: Zatoshis }
  | { op: "create"; venue: Venue; meta: { name: string; symbol: string; image?: string }; initialBuyZec?: Zatoshis }
  | { op: "claim"; mint?: string }
  | { op: "withdraw_zec"; to: string; amount: Zatoshis }
  | {
      op: "withdraw_token";
      mint: string;
      amount: TokenBaseUnits;
      to: string | string[];
      smart?: { parts: number; maxDelayMin: number }; // parts 2..5, to.length === parts
    }
  | {
      op: "order_create";
      venue: Venue;
      mint: string;
      kind: OrderKind;
      triggerPriceSol: DecimalString;
      amount: string; // zatoshis for buy kinds, token base units for sell kinds
    }
  | { op: "order_cancel"; orderId: string }
  | { op: "chat"; mint: string; text: string; showCreatorBadge?: boolean };

export interface ActionAccepted {
  id: string;
  status: ActionStatus;
}

export type ActionStatus = "queued" | "executed" | "failed";

export interface ActionStatusResponse {
  status: ActionStatus;
  solanaTx?: string;
  error?: ErrorCode;
}

export type OrderKind = "limit_buy" | "limit_sell" | "take_profit" | "stop_loss";

export interface Order {
  id: string;
  venue: Venue;
  mint: string;
  kind: string;
  triggerPriceSol: DecimalString;
  amount: string;
  status: "open" | "filled" | "cancelled" | "failed";
  createdAt: number;
  filledTx?: string;
}

export interface ChatMessage {
  id: string;
  mint: string;
  nick: string; // short hash H(anonPubkey || mint)
  text: string;
  isCreator: boolean;
  ts: number;
}

export interface CreatorToken {
  mint: string;
  symbol: string;
  venue: Venue;
  status: "curve" | "graduated";
  feesEarnedSol: DecimalString;
  feesClaimedSol: DecimalString;
  volumeSol: DecimalString;
  holders: number;
}

export interface PlatformStats {
  volumeSol: DecimalString;
  zecShielded: DecimalString;
  trades: number;
  launches: number;
  byVenue: Record<Venue, { volumeSol: DecimalString; trades: number }>;
  topTokens: Token[];
}

// ---- errors ----

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "replay"
  | "insufficient_balance"
  | "below_minimum"
  | "balance_frozen"
  | "graduated"
  | "pool_liquidity"
  | "slippage"
  | "rate_limited"
  | "venue_unavailable"
  | "internal";

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}
