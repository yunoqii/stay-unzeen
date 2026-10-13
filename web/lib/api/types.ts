// Mirrors docs/API.md v0.9 (token intel, fair-launch and Verify blocks at the bottom). Do not diverge: change the contract first.
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
  /** v0.4: false -> POST create answers 503 venue_unavailable. */
  createEnabled?: boolean;
  /** v0.5: what the server has switched on (not a build-time flag of the front). */
  features?: {
    fullTrades: boolean;
    /** v0.6: false -> the whole fair-launch surface is hidden (no UI, no code loaded). */
    fairLaunch?: boolean;
  };
  /** v0.6: only with features.fairLaunch = true. */
  fairLaunch?: FairLaunchParams;
  /** v0.8: private orders (limit / take-profit / stop-loss). Absent = the server has no orders. */
  orders?: OrdersParams;
  /** v0.5: creator rules of Unzeen launches, enforced by the ledger. 0 = rule off. */
  launchRules?: {
    lockSecs: number;
    capBps: number;
    /** Max first buy of `create`, lamports (after rounding). */
    maxInitialBuyLamports: Lamports;
    /** v0.6: the same cap per enabled launchpad venue (create is checked against its own venue's curve). */
    maxInitialBuyLamportsByVenue?: Record<string, Lamports>;
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
  /** v0.7: creator fees owed to this key, per mint it launched (lamports). `claim` credits them as ZEC. */
  claimable: { mint: string; solAmount: Lamports }[];
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
      /** SOL per whole token (like Token.priceSol), > 0, at most 18 significant digits. */
      triggerPriceSol: DecimalString;
      /** limit_buy: zatoshis; the sell kinds: token base units. */
      amount: string;
      /** 50..5000; default PoolInfo.orders.defaultSlippageBps[kind]. v0.10: measured from the price tick that triggers it (minOut rounded down to 3 significant digits by the server). */
      slippageBps?: number;
      /** 3600..PoolInfo.orders.maxTtlSecs; default 86400. expiresAt is rounded UP to the hour. */
      ttlSecs?: number;
      exec?: "delayed" | "max"; // "now" -> 400
    }
  | { op: "order_cancel"; orderId: string }
  | { op: "chat"; mint: string; text: string; showCreatorBadge?: boolean }
  // v0.6 fair-launch (only with features.fairLaunch; otherwise 400 like an unknown op)
  | { op: "fl_create"; venue: "pumpfun"; meta: { name: string; symbol: string; image?: string }; windowSecs: number }
  | { op: "fl_bid"; launchId: string; holdZat: Zatoshis; ciphertext: string }
  | { op: "fl_cancel"; launchId: string }
  | { op: "fl_cancel_launch"; launchId: string };

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
  /** Lamports per 1 ZEC, pool spread included. */
  lamportsPerZec: Lamports;
  source: "near-1click" | "fixed"; // fixed: devnet only
  ts: number;
}

/** POST /api/actions. */
export interface ActionReceipt {
  id: string; // 32 hex
  /** v0.8: order_create answers "open", order_cancel "cancelled"; claim answers "executed" (v0.7). */
  status: ActionState | "open" | "cancelled";
  rate?: RateUsed; // buy / sell / create / withdraw_token
  /** v0.6: fl_create only. */
  launchId?: string;
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

export type OrderStatus = "open" | "triggered" | "filled" | "cancelled" | "expired" | "failed";

/** v0.8: only in Portfolio.orders (owner). Lives in the pool's ledger only, never on-chain. */
export interface Order {
  id: string; // 32 hex (= id of the order_create receipt)
  venue: "pumpfun";
  mint: string;
  kind: OrderKind;
  triggerPriceSol: DecimalString;
  /** limit_buy: zatoshis; the sell kinds: token base units. */
  amount: string;
  slippageBps: number;
  exec: "delayed" | "max";
  status: OrderStatus;
  /** unix ms, rounded down to the minute. */
  createdAt: number;
  /** unix ms, rounded up to the hour. */
  expiresAt: number;
  /** stop_loss: the condition held on one tick, waiting for the next one in a row. */
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
  defaultSlippageBps: Record<OrderKind, number>;
  /** stop_loss fires after this many ticks in a row at or below the trigger. */
  slConfirmTicks: number;
  /** Indexer price tick, seconds ("checks about once a minute"). */
  priceTick: { minSecs: number; maxSecs: number };
}

export interface ChatMessage {
  id: string;
  mint: string;
  nick: string; // short hash H(anonPubkey || mint)
  text: string;
  isCreator: boolean;
  ts: number;
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
  /** Rounded DOWN to 0.01 ZEC. Stated by the operator, not proven. */
  zecReserve: { amountZat: Zatoshis; height: number; attested: true };
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
