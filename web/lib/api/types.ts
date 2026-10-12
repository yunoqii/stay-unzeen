// Mirrors docs/API.md v0.3. Do not diverge: change the contract first.
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
  /** 2 bytes hex for the unz1 memo and HTTP signatures: only "0202" (testnet + devnet) or "0101" (mainnet + mainnet-beta). */
  chainId: string;
  /** Below this a deposit is not credited (stays with the pool as dust). */
  minDepositZat: Zatoshis;
  /** Minimum amount of an action from the balance (zecIn / withdraw_zec). */
  minActionZat: Zatoshis;
  /** K: blocks until a deposit is credited (default 3). */
  confirmations: number;
}

export interface DepositInfo {
  /** 16 random bytes hex; stable, owner-only, not linked to txid/note. */
  id: string;
  amountZat: Zatoshis;
  /** refund is not used in v1, so only "credited". */
  status: "credited";
  /** Credit time, unix ms rounded DOWN to the start of the UTC day. */
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
  /** amount: available; held: reserved by queued sell / withdraw_token. */
  holdings: { mint: string; amount: TokenBaseUnits; held: TokenBaseUnits }[];
  /** Always [] for now. */
  claimable: { mint: string; solAmount: Lamports }[];
  /** Last 20, newest first. */
  deposits: DepositInfo[];
}

/** Body of POST /api/actions. anonPubkey/nonce/ts/sig go in x-unzeen-* headers, not here. */
export type SignedAction =
  | { op: "buy"; venue: Venue; mint: string; zecIn: Zatoshis; minOut: TokenBaseUnits }
  | { op: "sell"; venue: Venue; mint: string; amount: TokenBaseUnits; minZecOut: Zatoshis }
  | {
      op: "create";
      venue: Venue; // "jupiter" -> 400
      // name 1..32 chars, symbol 1..10 ASCII alnum, image: data:image/(png|jpeg|webp);base64,... up to 512 KiB
      meta: { name: string; symbol: string; image?: string };
      initialBuyZec?: Zatoshis;
    }
  // Not supported yet (400 "op not supported yet"): claim, order_create, order_cancel, chat. UI shows "soon".
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

export type ActionState = "queued" | "executed" | "failed";

/** Rate fixed when the action was accepted. */
export interface RateUsed {
  /** Lamports per 1 ZEC, pool spread included. */
  lamportsPerZec: Lamports;
  source: "near-1click" | "fixed"; // fixed: devnet only
  ts: number;
}

/** POST /api/actions. */
export interface ActionReceipt {
  id: string; // 32 hex
  status: ActionState;
  rate?: RateUsed; // buy / sell / create / withdraw_token
}

/** GET /api/actions/:id (owner only). */
export interface ActionStatus {
  status: ActionState;
  /** First confirmed signature; dropped 24 h after execution. */
  solanaTx?: string;
  error?: ErrorCode;
  rate?: RateUsed;
  /** After execution, kept 24-48 h. */
  fill?: {
    tokenAmount: TokenBaseUnits;
    solAmount?: Lamports;
    zecSpent?: Zatoshis;
    zecCredited?: Zatoshis;
    mint?: string; // create: new mint
  };
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
