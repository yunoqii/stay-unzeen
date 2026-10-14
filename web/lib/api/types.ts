// Mirrors docs/API.md v0.14 (token intel, fair-launch and Verify blocks at the bottom). Do not diverge: change the contract first.
//
// Units (docs/API.md "Единицы сумм"):
//   - spendable amounts: integer strings in BASE units (token base units, lamports, zatoshis)
//   - prices / stats: decimal strings in UI units
//   - timestamps: unix ms, except Candle.time (unix seconds)

/** v0.13: + raydium-launchlab (LaunchLab: platforms Unzeen / bonk.fun / stonk.fun) and bags (reserved, 503 until enabled). */
/** v0.18: + pons (Pons V2 on Robinhood Chain; a Solana server answers 503 venue_unavailable). */
export type Venue = "pumpfun" | "meteora-dbc" | "jupiter" | "raydium-launchlab" | "bags" | "pons";

/** v0.13: the curve's pair. ZEC = ZEC SPL (bridged, A7bd…QXaS). */
export type Quote = "SOL" | "USDC" | "USD1" | "ZEC";

/** v0.13: LaunchLab platform config (only with venue "raydium-launchlab"). */
export type LaunchPlatform = "unzeen" | "bonk" | "stonk";

/** v0.16: PoolInfo.venues[] */
export interface VenueInfo {
  venue: Venue;
  /** buy / sell accepted (false: mainnet-only venue on devnet, or actions off on this network). */
  trade: boolean;
  /** create accepted (trade && createEnabled && a launchpad; jupiter always false). */
  create: boolean;
  /** Pairs create takes here: "SOL" + the enabled ones from PoolInfo.quotes; empty when create is false. */
  quotes: Quote[];
  /** false (bags): the first buy is a separate trade after the launch, and can be front-run. */
  atomicFirstBuy: boolean;
  /** false (bags, jupiter): no creator fees reach claimable. */
  creatorFees: boolean;
  mainnetOnly: boolean;
}

/** v0.13: PoolInfo.quotes[]: a non-SOL pair enabled on this network. No entry = pair unavailable. */
export interface QuoteAsset {
  quote: Exclude<Quote, "SOL">;
  /** base58; on devnet pump.fun and Raydium use different USDC mints (separate entries). */
  mint: string;
  decimals: number;
  /** ZEC SPL: true (bridged asset, issuer risk). */
  bridged: boolean;
  /** Venues with this pair. */
  venues: Venue[];
  /** ZEC only: spread of the 1:1 parity, bps. */
  spreadBps?: number;
}

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
  /** v0.13: only on non-SOL pairs. */
  quoteMint?: string;
  /** v0.13: quote base units (integer); solAmount is then the SOL equivalent at trade time, or "0". */
  quoteAmount?: string;
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
  priceSol: DecimalString; // SOL per 1 whole token (SOL equivalent for non-SOL pairs, may be "0")
  marketCapSol: DecimalString; // SOL equivalent for non-SOL pairs, may be "0"
  createdAt: number; // unix ms
  /** v0.13: the curve's pair ("SOL" for every older token; treat absent as "SOL"). */
  quote: Quote;
  /** v0.13: absent for SOL. */
  quoteMint?: string;
  /** v0.13: quote per 1 whole token (UI units), when the relayer recorded it. */
  priceQuote?: DecimalString;
  /** v0.13: only with venue "raydium-launchlab". */
  platform?: LaunchPlatform;
}

/** v0.12: element of GET /api/tokens (Token + the fields the /tokens filters need). */
export interface TokenListItem extends Token {
  /** Launched through Unzeen (a public create of the pool). */
  unzeenLaunch: boolean;
  /** Pool trade volume of the mint over 24 h (buy + sell), SOL. */
  volume24hSol: DecimalString;
  /** Pool trades of the mint over 24 h. */
  unzeenTrades24h: number;
  /** Only with status "curve" and an indexer snapshot. */
  curveProgressPct?: DecimalString;
}

/** v0.12: element of GET /api/tokens?source=discovery (indexer snapshot), only with features.discovery. */
export interface DiscoveryToken {
  mint: string;
  /** May be "" while metadata is not read yet. */
  symbol: string;
  name: string;
  venue: "pumpfun" | "meteora-dbc";
  status: "curve" | "graduated";
  decimals: number;
  priceSol: DecimalString;
  marketCapSol: DecimalString;
  createdAt: number;
  curveProgressPct?: DecimalString;
  unzeenLaunch: boolean;
  /** unix ms of the indexer tick the numbers belong to. */
  asOf: number;
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
  /** v0.17: base-unit string without an i64 limit: lamports, or the pair quote's base units with `quote=1`. */
  volume: string;
}

/**
 * v0.18 GET /api/rates: public display rates, approximate, display only (never the price of an action — that
 * one comes from PoolInfo.rate / the receipt's RateUsed). Same answer for everyone, refreshed by a server timer
 * (1Click, ~60 s); 503 until the first data. All values are decimal strings (6 significant digits).
 */
export interface Rates {
  usd: { ZEC: DecimalString; SOL: DecimalString; ETH: DecimalString };
  /** SOL / ETH per 1 ZEC (from the same USD prices). */
  pairs: { "ZEC/SOL": DecimalString; "ZEC/ETH": DecimalString };
  approximate: true;
  source: "near-1click";
  /** Unix ms when the server's timer got the prices. */
  ts: number;
}

/** v0.18 PoolInfo.chain: the chain of this origin. */
export interface ChainInfo {
  id: "solana" | "hood";
  network: "mainnet-beta" | "devnet" | "hood" | "hood-testnet";
  mainnet: boolean;
  /** Gas / quote coin: lamports or wei in the *Lamports fields. */
  native: { symbol: "SOL" | "ETH"; decimals: 9 | 18 };
  evmChainId?: 4663 | 46630;
}

/** GET /api/pool: public, no pubkey, no cookies. Same for every user. */
export interface PoolInfo {
  /** Pool Unified Address (Orchard/Ironwood receiver only). */
  address: string;
  network: "main" | "test";
  /** 2 bytes hex for the unz1 memo and HTTP signatures: "0202" (testnet + devnet) or "0101" (mainnet + mainnet-beta); v0.18 + "0111" / "0212" (Robinhood Chain). */
  chainId: string;
  /** v0.18: the chain of this origin. Absent on older servers (= Solana). */
  chain?: ChainInfo;
  /** Below this a deposit is not credited (stays with the pool as dust). */
  minDepositZat: Zatoshis;
  /** Minimum amount of an action from the balance (zecIn / withdraw_zec). */
  minActionZat: Zatoshis;
  /** v0.11: minimum of a claim (ZEC equivalent of claimable), <= minActionZat. */
  minClaimZat?: Zatoshis;
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
  /** v0.4: false -> POST create answers 503 venue_unavailable. */
  createEnabled?: boolean;
  /** v0.5: what the server has switched on (not a build-time flag of the front). */
  features?: {
    fullTrades: boolean;
    /** v0.6: false -> the whole fair-launch surface is hidden (no UI, no code loaded). */
    fairLaunch?: boolean;
    /** v0.12 chat: absent = no chat (no tab, every chat_* op -> 400). */
    chat?: true;
    /** v0.12: GET /api/tokens?source=discovery (fresh launchpad tokens via the indexer). Off by default. */
    discovery?: true;
    /** v0.12 cover traffic (R8): the server accepts `op:"noop"`. Absent = the client sends none. */
    noop?: true;
    /** v0.19 scenarios (UNZEEN_SCENARIOS). Absent = off, every scenario_* op -> 400. */
    scenarios?: true;
  };
  /** v0.19: only with features.scenarios. */
  scenarios?: ScenarioParams;
  /** v0.12 chat: only with features.chat. */
  chat?: ChatParams;
  /** v0.6: only with features.fairLaunch = true. */
  fairLaunch?: FairLaunchParams;
  /** v0.8: private orders (limit / take-profit / stop-loss). Absent = the server has no orders. */
  orders?: OrdersParams;
  /** v0.13: enabled non-SOL pairs (empty / absent = SOL only). */
  quotes?: QuoteAsset[];
  /** v0.16: enabled venues (UNZEEN_VENUES order) and what each takes right now. Absent on older servers. */
  venues?: VenueInfo[];
  /** v0.5: creator rules of Unzeen launches, enforced by the ledger. 0 = rule off. */
  launchRules?: {
    lockSecs: number;
    capBps: number;
    /** Max first buy of `create`, lamports (after rounding). */
    maxInitialBuyLamports: Lamports;
    /** v0.6: the same cap per enabled launchpad venue (create is checked against its own venue's curve). */
    maxInitialBuyLamportsByVenue?: Record<string, Lamports>;
    /** v0.17: ZEC pairs: max first buy of `create` in ZEC SPL units (= zatoshis), step 0.0001 ZEC; only venues with the ZEC pair on (`{}` on devnet). */
    maxInitialBuyZecUnitsByVenue?: Record<string, string>;
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
  /**
   * v0.7: creator fees owed to this key, per mint it launched. solAmount: lamports (SOL / USDC / USD1 pairs);
   * v0.14 zecAmount: zatoshis (ZEC pairs, credited 1:1). `claim` credits both as ZEC.
   */
  claimable: { mint: string; solAmount: Lamports; zecAmount?: Zatoshis }[];
  /** Last 20, newest first. */
  deposits: DepositInfo[];
  /**
   * Status of the owner's actions of the last 24 h (pending in docs/API.md, analysis N-2). Comes with
   * every fixed-interval portfolio poll, so the client never polls a single action and never reveals
   * when it settled.
   */
  actions?: (ActionStatus & { id: string; kind?: ActionKind })[];
  /** v0.8: open / triggered first, then closed (amounts and price kept 24 h after closing); at most 20. */
  orders?: Order[];
  /** v0.6, only with features.fairLaunch: the key's last 20 sealed bids. */
  fairBids?: FairBid[];
  /** v0.6, only with features.fairLaunch: launches created by this key. */
  fairLaunches?: OwnFairLaunch[];
  /** v0.19, only with features.scenarios: at most 5, active first, then closed within 24 h. */
  scenarios?: Scenario[];
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
      exec?: ExecMode;
      /** v0.13: the pair (default "SOL"); the venue must list it in PoolInfo.quotes. */
      quote?: Quote;
      /** v0.13: only raydium-launchlab (default "unzeen"). */
      platform?: LaunchPlatform;
    }
  // v0.7: creator fees -> ZEC balance, ledger only (no on-chain tx). Response { id, status: "executed", rate }.
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
  // v0.8 private orders. Response { id, status: "open" } / { id, status: "cancelled" }.
  | {
      op: "order_create";
      venue: "pumpfun";
      mint: string;
      kind: OrderKind;
      /** SOL per whole token (like Token.priceSol), > 0, at most 18 significant digits. Every kind except bracket (there: 400). */
      triggerPriceSol?: DecimalString;
      /** v0.15 bracket only (required): take-profit leg price, same format. */
      tpPriceSol?: DecimalString;
      /** v0.15 bracket only (required): stop-loss leg price, < tpPriceSol. */
      slPriceSol?: DecimalString;
      /** v0.15 bracket only: slippage of the SL leg, 50..5000; default defaultSlippageBps.stop_loss. */
      slSlippageBps?: number;
      /** v0.15: re-arm after a slippage failure (at most PoolInfo.orders.maxRearms times, until expiresAt). Default false. */
      rearm?: boolean;
      /** limit_buy: zatoshis; the sell kinds: token base units. */
      amount: string;
      /** 50..5000; default PoolInfo.orders.defaultSlippageBps[kind] (bracket: the TP leg). v0.10: measured from the price tick that triggers it (minOut rounded down to 3 significant digits by the server). */
      slippageBps?: number;
      /** 3600..PoolInfo.orders.maxTtlSecs; default 86400. expiresAt is rounded UP to the hour. */
      ttlSecs?: number;
      exec?: "delayed" | "max"; // "now" -> 400
    }
  | { op: "order_cancel"; orderId: string }
  // Chat (v0.12): body exactly ChatParams.bodyBytes (1024), never in Portfolio.actions.
  | { op: "chat"; mint: string; text: string; showCreatorBadge?: boolean; slow?: boolean }
  | { op: "chat_delete"; id: string }
  | { op: "chat_hide"; id: string }
  | { op: "chat_report"; id: string; reason: ChatReportReason }
  // Cover traffic (v0.12, R8): same endpoint, same 1024 bytes, no effect.
  | { op: "noop" }
  // v0.6 fair-launch (only with features.fairLaunch; otherwise 400 like an unknown op)
  | { op: "fl_create"; venue: "pumpfun"; meta: { name: string; symbol: string; image?: string }; windowSecs: number }
  | { op: "fl_bid"; launchId: string; holdZat: Zatoshis; ciphertext: string }
  | { op: "fl_cancel"; launchId: string }
  | { op: "fl_cancel_launch"; launchId: string }
  // v0.19 scenarios (only with features.scenarios). create: body padded to 16 KiB; start/cancel: 1 KiB.
  | { op: "scenario_create"; plan: ScenarioPlan; replaces?: string } // -> { id, status: "active" | "waiting_start" }
  | { op: "scenario_start"; id: string } // -> { id, status: "active" }
  | { op: "scenario_cancel"; id: string } // -> { id, status: "cancelled" }
  | { op: "scenario_cancel"; all: true };

/**
 * What actually goes on the wire: the action plus `pad`, random filler that brings every body to a
 * fixed size bucket so its length does not reveal the op or the mode (pending in docs/API.md, R-web-3).
 */
export type PaddedAction = SignedAction & { pad?: string };

/** v0.4: "sent" = tx signed and sent, waiting for finality. ActionReceipt is only ever "queued". */
export type ActionState = "queued" | "sent" | "executed" | "failed";

export type ActionKind = "buy" | "sell" | "create" | "withdraw_zec" | "withdraw_token" | "claim";

/** Rate fixed when the action was accepted. */
export interface RateUsed {
  /** Lamports per 1 ZEC, pool spread included. v0.13: absent on ZEC pairs. */
  lamportsPerZec?: Lamports;
  /** v0.13: the action ran on a ZEC SPL pair (1:1 parity, no SOL rate). */
  quote?: "ZEC";
  /** v0.13: ZEC SPL base units per 1 ZEC, spread included (buy 1e8·(1−s), sell 1e8·(1+s)). */
  quotePerZec?: string;
  source: "near-1click" | "fixed" | "parity"; // fixed: devnet only; parity: ZEC SPL 1:1
  ts: number;
}

/** A rate with a ZEC/SOL price (every pair except ZEC). */
export type SolRateUsed = RateUsed & { lamportsPerZec: Lamports };

/** POST /api/actions. */
export interface ActionReceipt {
  id: string; // 32 hex
  /** v0.8: order_create answers "open", order_cancel "cancelled"; claim answers "executed" (v0.7). v0.19: scenario_* answer their plan status. */
  status: ActionState | "open" | "cancelled" | "active" | "waiting_start";
  rate?: RateUsed; // buy / sell / create / withdraw_token
  /** v0.6: fl_create only. */
  launchId?: string;
  /** v0.12: op "chat" only: your nickname in this token's chat (member or creator, by the badge flag). */
  nick?: string;
  /** v0.19: scenario_cancel {all: true} answers { ids, status: "cancelled" } (no id). */
  ids?: string[];
}

/** GET /api/actions/:id (owner only). */
/** v0.17: ActionStatus.parts[] */
export interface WithdrawPart {
  /** Token base units of this part (after the cut and the 3-significant-digit rounding). */
  amount: TokenBaseUnits;
  /** Unix ms (whole seconds): not sent before this. */
  notBefore: number;
  status: "queued" | "sent" | "confirmed" | "failed";
}

export interface ActionStatus {
  status: ActionState;
  /** First confirmed signature; dropped 24 h after execution. */
  solanaTx?: string;
  error?: ErrorCode;
  rate?: RateUsed;
  /**
   * v0.17: withdraw_token only, owner only, while the jobs are linked (up to 24 h after execution): the real
   * parts after the server's cut and rounding (A1). Their sum is never the signed amount.
   */
  parts?: WithdrawPart[];
  /** v0.5: execution time, unix ms rounded DOWN to the minute; only while `fill` is kept. */
  executedAt?: number;
  /** After execution, kept 24-48 h. */
  fill?: {
    tokenAmount: TokenBaseUnits;
    solAmount?: Lamports;
    /** v0.13: ZEC pairs: ZEC SPL base units of the trade (instead of solAmount). */
    quoteAmount?: string;
    quoteMint?: string;
    zecSpent?: Zatoshis;
    zecCredited?: Zatoshis;
    mint?: string; // create: new mint
  };
}

/** v0.15: + bracket (take-profit and stop-loss on one position, one cancels the other). */
export type OrderKind = "limit_buy" | "limit_sell" | "take_profit" | "stop_loss" | "bracket";

export type OrderStatus = "open" | "triggered" | "filled" | "cancelled" | "expired" | "failed";

/** v0.8: only in Portfolio.orders (owner). Lives in the pool's ledger only, never on-chain. */
export interface Order {
  id: string; // 32 hex (= id of the order_create receipt)
  venue: "pumpfun";
  mint: string;
  kind: OrderKind;
  /** bracket (v0.15): the TP leg price. */
  triggerPriceSol: DecimalString;
  /** limit_buy: zatoshis; the sell kinds: token base units. */
  amount: string;
  /** bracket: the TP leg. */
  slippageBps: number;
  exec: "delayed" | "max";
  /** v0.15 bracket only. */
  slPriceSol?: DecimalString;
  slSlippageBps?: number;
  /** v0.15 bracket only: which leg fired (triggered / filled, and failed after firing). */
  leg?: "tp" | "sl";
  /** v0.15: re-arm after slippage is on. */
  rearm?: true;
  /** v0.15: times re-armed so far (0..maxRearms); absent from servers before v0.15. */
  rearms?: number;
  status: OrderStatus;
  /** unix ms, rounded down to the minute. */
  createdAt: number;
  /** unix ms, rounded up to the hour. */
  expiresAt: number;
  /** stop_loss / the SL leg of a bracket: the condition held on one tick, waiting for the next one in a row. */
  armed?: true;
  /** triggered / filled / failed after the trigger: the trade's status is in Portfolio.actions. */
  actionId?: string;
  error?: ErrorCode;
}

/** PoolInfo.orders (v0.8). */
export interface OrdersParams {
  kinds: OrderKind[];
  venues: "pumpfun"[];
  maxOpenPerKey: number;
  maxOpenPerMint: number;
  maxTtlSecs: number;
  defaultTtlSecs: number;
  /** v0.15 bracket: its TP leg (500); its SL leg uses stop_loss. Absent on servers before v0.15. */
  defaultSlippageBps: Record<Exclude<OrderKind, "bracket">, number> & { bracket?: number };
  /** v0.15: how many times an order with rearm returns to open after slippage (3). */
  maxRearms?: number;
  /** stop_loss fires after this many ticks in a row at or below the trigger. */
  slConfirmTicks: number;
  /** Indexer price tick, seconds ("checks about once a minute"). */
  priceTick: { minSecs: number; maxSecs: number };
}

// ---- chat (docs/API.md v0.12, "Чат") ----

export type ChatReportReason = "spam" | "scam" | "abuse";
/** v0.12 tombstones; "creator" is not one (creator hides stay as messages with hiddenByCreator), still tolerated. */
export type ChatRemovedReason = "deleted" | "creator" | "reports" | "operator";

/** PoolInfo.chat */
export interface ChatParams {
  /** Admission: ZEC available + held + tokens at the tick price must be at least this (zatoshis). */
  minAccountZat: Zatoshis;
  maxChars: number; // 280
  maxJsonBytes: number; // 800: JSON.stringify(text) in UTF-8
  bodyBytes: number; // 1024: every chat_* body is exactly this long
  rate: { minIntervalSecs: number; perHour: number; perDay: number };
  reportHideThreshold: number;
  slowDelaySecs: { min: number; max: number };
  retentionDays: number;
}

export interface ChatMessage {
  /** 32 hex, 128 random bits. */
  id: string;
  mint: string;
  /** 8 chars Crockford base32, lower case: HMAC(K_chat, ...) on the server. No pubkey, no signature anywhere. */
  nick: string;
  /** The creator's separate nickname in this chat (verified by the pool, not by a public proof). */
  isCreator: boolean;
  text: string;
  /** unix ms: the epoch boundary it was published on, never the time the request arrived. */
  ts: number;
  /** Decimal string, publication order; random within one batch. */
  seq: string;
  /** Hidden by the token's creator: the text stays, a reader can reveal it; re-sent in `after=` with a new seq. */
  hiddenByCreator?: true;
}

/** GET /api/tokens/:mint/chat */
export interface ChatPage {
  messages: ChatMessage[];
  /** Tombstones, kept 24 h. */
  removed: { id: string; reason: ChatRemovedReason }[];
  /** Highest seq of the events in this page: pass it as after=. */
  cursor: string;
  more: boolean;
  pad?: string;
}

/** v0.9: GET /api/creator (signed). Owner only; none of it is public anywhere (T1). */
export interface CreatorCabinet {
  /** Tokens created by this key (create / fl_create), newest first, at most 50. */
  tokens: CreatorToken[];
  /** Spaces up to a multiple of 4096 bytes; ignore. */
  pad?: string;
}

export interface CreatorToken {
  mint: string;
  symbol: string;
  name: string;
  image?: string;
  decimals: number;
  venue: "pumpfun" | "meteora-dbc";
  status: "curve" | "graduated";
  /** Only on the curve and with an indexer snapshot. */
  curveProgressPct?: DecimalString;
  /** unix ms (= Token.createdAt). */
  createdAt: number | null;
  fees: {
    /** = Portfolio.claimable[mint].solAmount ("0" when nothing); claim -> ZEC. */
    claimableLamports: Lamports;
    /** Claimed so far for this mint (since v0.9). */
    claimedLamports: Lamports;
    /** v0.14: = Portfolio.claimable[mint].zecAmount (ZEC pairs; otherwise "0"). */
    claimableZat?: Zatoshis;
    /** v0.14: claimed so far in zatoshis for this mint. */
    claimedZat?: Zatoshis;
  };
  /** Pool trade volume of the mint (buy + sell), all time. */
  volumeLamports: Lamports;
  trades: number;
  /** From the indexer snapshot; null while there is none. */
  holders: number | null;
  holdersAsOf?: number;
  /** Lock of the launch buy (launchRules.lockSecs). */
  lock: { lockedAmount: TokenBaseUnits; until: number | null };
  /** Creator position cap through the pool (launchRules.capBps). */
  cap: { capBps: number; capTokens: TokenBaseUnits; positionTokens: TokenBaseUnits };
}

/** v0.9 k-anonymity: a category built from fewer than 5 events is the string "<5". */
export type KCount = number | "<5";
export type KAmount = DecimalString | "<5";

/** v0.9: GET /api/stats (public). One snapshot a day; no live aggregates. 404 before the first one. */
export interface PlatformStats {
  /** unix ms: 00:00 UTC of the snapshot day; all data strictly before it. */
  asOf: number;
  volumeSol: KAmount;
  trades: KCount;
  launches: KCount;
  zecShielded: KAmount;
  byVenue: Record<Venue, { volumeSol: KAmount; trades: KCount; launches: KCount }>;
  /** <= 10 by pool volume over topWindowDays before asOf; only tokens with >= 5 pool trades in the window. */
  topTokens: (Token & { volumeSol: DecimalString; trades: number })[];
  topWindowDays: number;
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
  | "launch_closed" // 409 (v0.6)
  | "already_bid" // 409 (v0.6)
  | "bad_ciphertext" // 400 (v0.6)
  | "launch_full" // 409 (v0.8): the launch already has 1024 bids
  | "order_limit" // 422 (v0.8): > 10 open orders per key or > 4 per key and mint
  | "order_not_open" // 409 (v0.8): order_cancel of an order that is no longer open
  | "order_unsupported_mint" // 422 (v0.8): mint not traded by the pool, not pump.fun, or graduated
  | "chat_text_invalid" // 400 (v0.12)
  | "chat_not_eligible" // 403 (v0.12): account below PoolInfo.chat.minAccountZat; never says by how much
  | "chat_muted" // 403 (v0.12)
  | "not_creator" // 403 (v0.12)
  | "scenario_invalid" // 400 (v0.19): structure, references, ranges; details { step, code }
  | "scenario_rule" // 422 (v0.19): privacy rule P1-P9; details { step, code }
  | "scenario_limit" // 422 (v0.19): more than maxActivePerKey active plans
  | "scenario_not_active" // 409 (v0.19): start / cancel from the wrong status
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
export type UnzeenRule =
  | "creator_initial_buy_locked_24h"
  | "initial_buy_cap_5pct"
  | "authorities_revoked"
  | "fair_launch_sealed_bids" // v0.6
  | (string & {});

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

// ---- fair-launch (docs/API.md v0.6, internal until 28.10) ----
// Types only: erased at build time. Runtime code lives in lib/fair and components/fair, which load
// only when PoolInfo.features.fairLaunch is true.

/** PoolInfo.fairLaunch */
export interface FairLaunchParams {
  /** Allowed bid windows, seconds (default [120, 300, 600, 1800]). */
  windowsSecs: number[];
  /** Hold denominations, zatoshis, ascending. */
  holdTiersZat: Zatoshis[];
  /** Cap of the total buy, bps of supply. */
  maxTotalBps: number;
  /** Cap of the total buy on this network's curve; null = curve unknown (fl_create -> 503). */
  maxTotalLamports: Lamports | null;
  /** Cap of the creator's bid (= launchRules.maxInitialBuyLamports). */
  creatorMaxLamports: Lamports | null;
  /** Fewer valid bids than this -> result.bids = "<5". */
  minBidsForCount: number;
  drand: {
    chainHash: string;
    publicKey: string;
    /** unix SECONDS */
    genesis: number;
    /** seconds */
    period: number;
    scheme: "bls-unchained-g1-rfc9380";
  };
}

export type FairLaunchStatus = "open" | "closed" | "revealing" | "executing" | "launched" | "failed" | "cancelled";

/** GET /api/launches, /api/launches/:id. Public, identical for everyone. */
export interface FairLaunch {
  /** 32 hex (16 bytes) = launchId in the bid plaintext. */
  id: string;
  venue: "pumpfun";
  meta: { name: string; symbol: string };
  status: FairLaunchStatus;
  /** unix ms: the Delayed epoch boundary after fl_create. */
  publishedAt: number;
  /** unix ms = publishedAt + windowSecs * 1000 */
  closeAt: number;
  drand: {
    /** R: encrypt to exactly this round. */
    round: number;
    /** t(R), unix ms (> closeAt). */
    roundTime: number;
    /** hex 48 bytes, after the beacon was verified. */
    signature?: string;
  };
  /** From `closed` on. */
  commitment?: {
    /** hex sha256 */
    root: string;
    attestation?: {
      /** SPL Memo tx whose data is exactly `root`. */
      solanaTx: string;
      slot: number;
      signer: string;
      matches: boolean;
      /** v0.8: block time of the memo-tx, unix SECONDS (null while unknown). */
      blockTime: number | null;
      /** v0.8: blockTime·1000 + 2000 < drand.roundTime. Only `true` lets the UI say "anchored before the round". */
      beforeRound: boolean;
    };
  };
  /** launched only */
  result?: {
    mint: string;
    solanaTx: string;
    totalLamports: Lamports;
    tokenAmount: TokenBaseUnits;
    decimals: number;
    priceSol: DecimalString;
    bids: number | "<5";
    oversubscribed: boolean;
  };
  /** internal (v0.8): the set of bids did not match the committed root; everything was returned. */
  failure?: "no_bids" | "drand_unavailable" | "venue_unavailable" | "tx_failed" | "internal";
  rules: UnzeenRule[];
}

/** Portfolio.fairBids (owner only). */
export interface FairBid {
  launchId: string;
  holdZat: Zatoshis;
  status: "sealed" | "cancelled" | "invalid" | "revealed" | "settled" | "released";
  amountZat?: Zatoshis;
  tokenAmount?: TokenBaseUnits;
  chargedZat?: Zatoshis;
  releasedZat?: Zatoshis;
  /** From `closed` on: inclusion proof (hex). */
  proof?: { leaf: string; path: string[] };
}

/** Portfolio.fairLaunches (creator only). */
export interface OwnFairLaunch {
  launchId: string;
  /** scheduled: not published yet (now < publishedAt). */
  status: "scheduled" | FairLaunchStatus;
  publishedAt: number;
  closeAt: number;
}

// ---- Verify (v0.7): proof of liabilities, public vaults, attested ZEC reserve ----

/**
 * "ZEC" or a base58 mint. In hashes: ZEC = 32 zero bytes, a mint = its 32 decoded bytes. v0.10: there is no
 * "SOL" tree any more (creator fees owed are in the creator's ZEC leaf); any other id is an unknown asset.
 */
export type AssetId = "ZEC" | (string & {});

export interface VerifyAnchor {
  /** SPL Memo tx whose data is exactly the 64-hex rootsDigest. */
  solanaTx: string;
  slot: number;
  /** Memo read back from the chain equals rootsDigest. false = incident (re-anchored automatically). */
  matches: boolean;
  /** v0.10: block time of the memo-tx (unix s), null while unknown. */
  blockTime?: number | null;
}

/** GET /api/verify/snapshots: root history, newest first. */
export interface VerifySnapshotSummary {
  id: number;
  /** unix ms, floored to the minute (= takenAtSec * 1000). */
  takenAt: number;
  /** hex, 32 bytes */
  rootsDigest: string;
  /** Present once the memo-tx is confirmed. */
  anchor?: VerifyAnchor;
}

export interface VerifyTree {
  asset: AssetId;
  decimals: number;
  /** Rounding granule in base units (ZEC 100000 zat; v0.10: a mint "1", exact sums). */
  granule: string;
  /** hex, 32 bytes */
  root: string;
  /** Base units, integer string (u128). */
  sum: string;
}

export interface VerifyVault {
  /** base58, also the ed25519 pubkey that signed `sig`. */
  address: string;
  /** base58 ed25519 over utf8("unzeen/verify/v1/vault\n" + chainId + "\n" + snapshotId + "\n" + address). */
  sig: string;
  lamports: Lamports;
  tokens: { mint: string; amount: TokenBaseUnits }[];
}

/** GET /api/verify, GET /api/verify/:id. */
export interface VerifySnapshot extends VerifySnapshotSummary {
  chainId: string;
  /** v0.17: 2 = rootsDigest v2 (also signs quoteAssets). Absent = 1 (older snapshots). */
  /** v0.20: 3 = Robinhood Chain snapshots (u128 leaves, ERC-20 assets); Solana stays 2. */
  digestVersion?: 1 | 2 | 3;
  /** N, the same for every tree of the snapshot. */
  leaves: number;
  solanaSlot: number;
  zcashHeight: number;
  /**
   * Pool attestation key (base58) + its signature over the 32 digest bytes. v0.10: present as soon as the
   * key signed the digest, before the memo-tx; `anchor` follows once the memo-tx is confirmed.
   */
  operator?: { pubkey: string; sig: string };
  trees: VerifyTree[];
  vaults: VerifyVault[];
  /** v0.10: only the gas of queued token withdrawals: subtracted from the cover. */
  committedLamports: Lamports;
  /** Rate SOL counts towards the ZEC cover. Absent = there was no rate. */
  rateLamportsPerZecSell?: Lamports;
  /** v0.10: rate creators' claimable lamports were converted into ZEC liabilities at (ceil). */
  rateLamportsPerZecBuy?: Lamports;
  /** v0.13: the pool's quote assets (their ATA balances are in vaults[].tokens). Never in the liability trees. */
  quoteAssets?: VerifyQuoteAsset[];
  /** Rounded DOWN to 0.01 ZEC. Stated by the operator, not proven. */
  zecReserve: { amountZat: Zatoshis; height: number; attested: true };
}

/** v0.13: VerifySnapshot.quoteAssets[] */
export interface VerifyQuoteAsset {
  mint: string;
  quote: "ZEC" | "USDC" | "USD1";
  decimals: number;
  /** ZEC SPL: bridged. */
  bridged: boolean;
  /** true only for ZEC SPL: counts towards the ZEC cover 1:1. USDC / USD1 are shown, never counted. */
  counted: boolean;
  /** A vault balance below this is dust and does not count (base units). */
  dustBelow: string;
}

export interface VerifyPathNode {
  hash: string;
  sum: string;
}

export interface VerifyProofPiece {
  piece: number;
  leafIndex: number;
  /** Base units, a multiple of the granule. */
  value: string;
  /** hex, 32 bytes */
  blind: string;
  /** Siblings bottom-up; the sibling is on the right when the leafIndex bit at that level is 0. */
  path: VerifyPathNode[];
}

/** GET /api/verify/proof (signed, owner only, always exactly 64 KiB on the wire). */
export interface VerifyProof {
  snapshotId: number;
  /** Empty when the key held nothing at the snapshot. */
  proofs: { asset: AssetId; decimals: number; pieces: VerifyProofPiece[] }[];
  /** More than 12 assets: ZEC + 11 random ones. */
  truncated: boolean;
  /** Spaces: the response is always exactly 65536 bytes, its size says nothing about the assets. */
  pad?: string;
}

// ---- scenarios (API.md v0.19, Scenarios section; vectors core/testdata/scenario-vectors.json) ----
// One signature, a linear chain of at most 12 blocks that the server runs step by step through the same
// paths as manual actions. Every type of the feature lives here, so the diff against API.md v0.19 is one place.

export type ScenarioBlockType =
  | "manual_start"
  | "time_at"
  | "price_cross"
  | "deposit_received"
  | "own_result"
  | "curve_progress"
  | "wait_fixed"
  | "wait_random"
  | "buy"
  | "sell"
  | "sell_all"
  | "swap"
  | "dca"
  | "order_place"
  | "order_cancel"
  | "create"
  | "claim"
  | "withdraw_token"
  | "withdraw_zec"
  | "check_safety"
  | "repeat"
  | "end"
  | "chat";
// The sealed-bid launch blocks of the spec are not part of this union on purpose: their names must not
// reach a public bundle before 28.10 (P10). They join through the lazy fair-launch chunk later.

/** PoolInfo.scenarios (v0.19). The floors are published for the UI's "≈"; the server enforces them. */
export interface ScenarioParams {
  /** Enabled blocks (no chat without features.chat). */
  blocks: ScenarioBlockType[];
  maxSteps: number; // 12
  maxRuns: number; // 40
  maxActivePerKey: number; // 3
  /** maxNoWithdraw (v0.19): plans without withdraw_* may live up to 7 days. */
  ttlSecs: { min: number; max: number; maxNoWithdraw?: number; default: number };
  floors: ScenarioFloors;
}

export interface ScenarioFloors {
  afterDepositSecs: [number, number];
  timeAtJitterSecs: [number, number];
  fixedWaitJitterPct: number;
  /** v0.19: at least ±30 s. */
  fixedWaitJitterMinSecs?: number;
  withdrawAfterTradeMinSecs: number;
  withdrawExtraSecs: [number, number];
  swapGapSecs: [number, number];
  swapShaveBps: [number, number];
  chatAfterTradeSecs: [number, number];
  repeatJitterPct: number;
  dcaWeightJitterPct: number;
  tradeGapEpochs: [number, number];
}

export type MintRef = string | { step: number };
export type AmountSpec = { abs: string } | { pct: number; of: "balance" | { step: number } };
export type Guard = { slippageBps: number } | { limitPrice: DecimalString };
export type OnFailTarget = "stop" | "skip" | { goto: number };
export type OnFail = OnFailTarget | { retry: 1 | 2 | 3; then: OnFailTarget };

export interface SafetyRequire {
  authoritiesRevoked?: boolean;
  noRiskyExtensions?: boolean;
  maxTop10Pct?: number;
  /** features.fullTrades only. */
  maxDevPct?: number;
  minLpBurnedPct?: number;
  /** features.fullTrades only. */
  maxSniperPct?: number;
}

type OrderCreateBody = Extract<SignedAction, { op: "order_create" }>;
type CreateBody = Extract<SignedAction, { op: "create" }>;
export type ScenarioOrder = Omit<OrderCreateBody, "op" | "amount" | "mint"> & { amount: AmountSpec; mint: MintRef };
export type ScenarioCreate = Omit<CreateBody, "op" | "initialBuyZec"> & { initialBuyZec?: AmountSpec };
type TradeExec = "now" | "delayed" | "max";

export type ScenarioBlock =
  | { type: "manual_start" }
  | { type: "time_at"; at: number }
  | { type: "price_cross"; mint: MintRef; op: "gte" | "lte"; priceSol: DecimalString; timeoutSecs?: number }
  | { type: "deposit_received"; minZat: Zatoshis; timeoutSecs?: number }
  | { type: "own_result"; ref: { step: number } | { orderId: string } | { actionId: string }; on: "filled" | "failed" | "any"; timeoutSecs?: number }
  | { type: "curve_progress"; mint: MintRef; gtePct?: number; graduated?: true; timeoutSecs?: number }
  | { type: "wait_fixed"; secs: number }
  | { type: "wait_random"; minSecs: number; maxSecs: number }
  | { type: "buy"; venue: Venue; mint: MintRef; zec: AmountSpec; guard: Guard; exec: TradeExec }
  | { type: "sell"; venue: Venue; mint: MintRef; amount: AmountSpec; guard: Guard; exec: TradeExec }
  | { type: "sell_all"; venue: Venue; mint: MintRef; guard: Guard; exec: TradeExec }
  | { type: "swap"; from: MintRef; to: MintRef; amount: AmountSpec; guardSell: Guard; guardBuy: Guard; venueSell?: Venue; venueBuy?: Venue; exec: "delayed" | "max" }
  | { type: "dca"; side: "buy" | "sell"; venue: Venue; mint: MintRef; total: AmountSpec; slices: number; everySecs: { min: number; max: number }; guard: Guard; exec: "delayed" | "max" }
  | { type: "order_place"; order: ScenarioOrder }
  | { type: "order_cancel"; ref: { step: number } | { orderId: string } }
  | { type: "create"; create: ScenarioCreate }
  | { type: "claim"; mint?: MintRef }
  | { type: "withdraw_token"; mint: MintRef; amount: AmountSpec; to: string | string[]; smart?: { parts: number; maxDelayMin: number }; exec: "delayed" | "max" }
  | { type: "withdraw_zec"; to: string; amount: AmountSpec; exec: "delayed" | "max" }
  | { type: "check_safety"; mint: MintRef; require: SafetyRequire; onFalse: "stop" | { goto: number } }
  | { type: "repeat"; from: number; times: number }
  | { type: "end" }
  | { type: "chat"; mint: MintRef; text: string; showCreatorBadge?: boolean };

export interface ScenarioStep {
  /** 0..maxSteps-1, unique in the plan. */
  id: number;
  block: ScenarioBlock;
  /** Default "stop". */
  onFail?: OnFail;
}

export interface ScenarioPlan {
  v: 1;
  /** Default ttlSecs.default; expiresAt is rounded UP to the hour. */
  ttlSecs?: number;
  steps: ScenarioStep[];
}

export type ScenarioStatus = "waiting_start" | "active" | "done" | "failed" | "cancelled" | "expired";
export type ScenarioStepStatus = "pending" | "waiting" | "running" | "done" | "skipped" | "failed";

/**
 * Error of a scenario step. ErrorCode plus two the draft names in prose but does not list (difference to
 * report): "timeout" (a trigger ran out of time) and "check_failed" (check_safety said no and onFalse is "stop").
 */
export type ScenarioStepError = ErrorCode | "timeout" | "check_failed";

export interface ScenarioStepState {
  id: number;
  status: ScenarioStepStatus;
  runs: number;
  /** Unix ms, rounded DOWN to the minute. */
  nextAt?: number;
  actionId?: string;
  orderId?: string;
  error?: ScenarioStepError;
}

/** Portfolio.scenarios[] (owner only). */
export interface Scenario {
  id: string;
  status: ScenarioStatus;
  /** Unix ms, rounded down to the minute. */
  createdAt: number;
  /** Unix ms, rounded up to the hour. */
  expiresAt: number;
  cursor: number;
  /**
   * v0.20: no longer sent — the plan and its addresses live only on the device that signed it (lib/scenarios/
   * store.ts). Older servers sent an echo with "sealed" / masked addresses.
   */
  plan?: ScenarioPlan;
  steps: ScenarioStepState[];
  error?: ScenarioStepError;
}

/** details of scenario_invalid / scenario_rule errors. */
export interface ScenarioErrorDetails {
  step: number;
  code: string;
}
