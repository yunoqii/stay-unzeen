// Mirrors docs/API.md v0.5 (token intel block at the bottom). Do not diverge: change the contract first.
//
// Units (docs/API.md "Единицы сумм"):
//   - spendable amounts: integer strings in BASE units (token base units, lamports, zatoshis)
//   - prices / stats: decimal strings in UI units
//   - timestamps: unix ms, except Candle.time (unix seconds)

export type Venue = "pumpfun" | "meteora-dbc" | "jupiter";

/**
 * Execution mode of buy / sell / withdraw (owner decision 12.10, docs/ARCHITECTURE.md):
 * "now" 1-3 s with a priority fee, "delayed" 30-60 s batches, "max" 5-15 min batches.
 */
export type ExecMode = "now" | "delayed" | "max";

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
  /** v0.4 fees. The flat fee of exec "now" (`nowFeeZat` or `nowFeeLamports`) is pending in docs/API.md. */
  fees?: {
    nowFeeZat?: Zatoshis;
    createFeeZat?: Zatoshis;
    withdrawZecFeeZat?: Zatoshis;
    withdrawTokenGasLamports?: Lamports;
    withdrawTokenCostLamports?: Lamports;
    nowFeeLamports?: Lamports;
  };
  /** v0.5: what the server has switched on (not a build-time flag of the front). */
  features?: { fullTrades: boolean };
  /** v0.5: creator rules of Unzeen launches, enforced by the ledger. 0 = rule off. */
  launchRules?: {
    lockSecs: number;
    capBps: number;
    /** Max first buy of `create`, lamports (after rounding). */
    maxInitialBuyLamports: Lamports;
  };
  /** v0.4: public rate from the background cache. Absent = no rate (actions -> 503). */
  rate?: {
    lamportsPerZec: Lamports; // mid
    lamportsPerZecBuy: Lamports;
    lamportsPerZecSell: Lamports;
    spreadBps: number;
    source: "near-1click" | "fixed";
    ts: number;
  };
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
  /**
   * Status of the owner's actions of the last 24 h (pending in docs/API.md, analysis N-2). Comes with
   * every fixed-interval portfolio poll, so the client never polls a single action and never reveals
   * when it settled.
   */
  actions?: (ActionStatus & { id: string; kind?: ActionKind })[];
}

/** Body of POST /api/actions. anonPubkey/nonce/ts/sig go in x-unzeen-* headers, not here. */
export type SignedAction =
  | { op: "buy"; venue: Venue; mint: string; zecIn: Zatoshis; minOut: TokenBaseUnits; exec?: ExecMode }
  | { op: "sell"; venue: Venue; mint: string; amount: TokenBaseUnits; minZecOut: Zatoshis; exec?: ExecMode }
  | {
      op: "create";
      venue: Venue; // "jupiter" -> 400
      // name 1..32 chars, symbol 1..10 ASCII alnum, image: data:image/(png|jpeg|webp);base64,... up to 512 KiB
      meta: { name: string; symbol: string; image?: string };
      initialBuyZec?: Zatoshis;
    }
  // Not supported yet (400 "op not supported yet"): claim, order_create, order_cancel, chat. UI shows "soon".
  | { op: "claim"; mint?: string }
  | { op: "withdraw_zec"; to: string; amount: Zatoshis; exec?: "delayed" | "max" }
  | {
      op: "withdraw_token";
      mint: string;
      amount: TokenBaseUnits;
      to: string | string[];
      smart?: { parts: number; maxDelayMin: number }; // parts 2..5, to.length === parts
      exec?: "delayed" | "max"; // withdrawals are never "now"
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

/**
 * What actually goes on the wire: the action plus `pad`, random filler that brings every body to a
 * fixed size bucket so its length does not reveal the op or the mode (pending in docs/API.md, R-web-3).
 */
export type PaddedAction = SignedAction & { pad?: string };

/** v0.4: "sent" = tx signed and sent, waiting for finality. ActionReceipt is only ever "queued". */
export type ActionState = "queued" | "sent" | "executed" | "failed";

export type ActionKind = "buy" | "sell" | "create" | "withdraw_zec" | "withdraw_token";

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
  /** v0.5: execution time, unix ms rounded DOWN to the minute; only while `fill` is kept. */
  executedAt?: number;
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
  | "feature_disabled"
  | "creator_locked"
  | "creator_cap"
  | "internal";

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

// ---- token intel (docs/API.md v0.5, "Безопасность токена и лента сделок") ----

/** 202 body of GET /api/tokens/:mint/safety and of GET /api/tokens/:mint for a cold (unknown) mint. */
export interface PendingResponse {
  status: "pending";
  /** Until the next fixed tick; the same for everyone asking in this window. */
  retryAfterMs: number;
}

export const isPending = (x: unknown): x is PendingResponse =>
  !!x && typeof x === "object" && (x as { status?: unknown }).status === "pending";

export type RiskyExtension = "permanentDelegate" | "transferHook" | "transferFee" | "defaultFrozen" | "mintClose" | "pausable";

/** Rules the pool enforces in its ledger for tokens launched through Unzeen. */
export type UnzeenRule = "creator_initial_buy_locked_24h" | "initial_buy_cap_5pct" | "authorities_revoked" | (string & {});

/** GET /api/tokens/:mint/safety (200). Public, no signature, identical for every caller. */
export interface TokenSafety {
  mint: string;
  /** unix ms, rounded to the tick boundary (never the time of the first request). */
  asOf: number;
  program: "spl-token" | "token-2022";
  authorities: {
    mintRevoked: boolean;
    freezeRevoked: boolean;
    /** updateAuthority == null; null = unknown. */
    metadataImmutable: boolean | null;
    riskyExtensions: RiskyExtension[];
  };
  /** Absent = no snapshot yet. */
  holders?: {
    /** Decimal string, %. Excludes the curve, the AMM pool and Unzeen vaults. */
    top10Pct: DecimalString;
    /** null for Unzeen launches (dev is anonymous) and when the dev is unknown. */
    devPct: DecimalString | null;
    /** Share of all pool vaults (shared inventory of every unzeen holder). */
    unzeenPoolPct: DecimalString;
    asOf: number;
  };
  /** Behind the Helius upgrade flag; never present for Unzeen launches. */
  dev?: {
    address: string;
    launchesSeen: number;
    rugsSeen: number;
    since: number;
  };
  /** Behind the Helius upgrade flag. */
  firstBlocks?: {
    snipers: number;
    sniperPct: DecimalString;
    sameSlotBuyers: number;
    sameSlotPct: DecimalString;
    unzeenLaunchBuy: boolean;
  };
  market: {
    venue: Venue;
    status: "curve" | "graduated";
    curveProgressPct?: DecimalString;
    lpBurnedPct?: DecimalString;
  };
  /** Normalized https links. */
  socials?: { twitter?: string; telegram?: string; website?: string };
  /** Only our /media/<sha40>.<ext>, never an external URL. */
  image?: string;
  unzeen?: { launch: true; rules: UnzeenRule[] };
}

export type TradeFilter = "all" | "unzeen" | "whales" | "dev";
export type TradeTag = "whale" | "dev" | "sniper";

/** GET /api/tokens/:mint/trades?filter=... */
export interface TokenTrade extends FeedEvent {
  /** Public address for other traders, "unzeen" for pool vaults. */
  trader: string;
  /** "dev" is never set on vault trades. */
  tags: TradeTag[];
}
