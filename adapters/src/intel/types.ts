/**
 * Token intel (FEATURES 6–8, docs/analysis/token-intel.md). Shapes follow the
 * draft `TokenSafety` of token-intel.md §5; the final table layout and API
 * live in docs/INTEL.md + core migration 0007 (written by core). Until those
 * land, the indexer works against `IntelStore` with an in-memory backend.
 */

export type RiskyExtension = "permanentDelegate" | "transferHook" | "transferFee" | "defaultFrozen" | "mintClose" | "pausable";

export interface TokenSafety {
  mint: string;
  /** Unix ms, floored to the tick boundary (>= 1 min): never the moment of a request (T5). */
  asOf: number;
  program: "spl-token" | "token-2022";
  authorities: {
    mintRevoked: boolean;
    freezeRevoked: boolean;
    /** updateAuthority == null (Token-2022 metadata) / !isMutable (Metaplex); null = no metadata found. */
    metadataImmutable: boolean | null;
    riskyExtensions: RiskyExtension[];
  };
  /** Absent: no snapshot (no index RPC configured, or the call failed this tick). */
  holders?: {
    /** Decimal string, 2 places: top-10 owners without curve, AMM pool, mayhem vault and Unzeen vaults. */
    top10Pct: string;
    /** null for Unzeen launches (T1) and when the dev is unknown. */
    devPct: string | null;
    /** All pool vaults together (shared inventory), from the largest accounts. */
    unzeenPoolPct: string;
    asOf: number;
  };
  /** Absent for Unzeen launches (T1) and unless INTEL_FULL=1. */
  dev?: { address: string; launchesSeen: number; rugsSeen: number; since: number };
  /** Absent unless INTEL_FULL=1. */
  firstBlocks?: {
    snipers: number;
    sniperPct: string;
    sameSlotBuyers: number;
    sameSlotPct: string;
    unzeenLaunchBuy: boolean;
  };
  market: {
    /** pump.fun curve / PumpSwap pool, or a Meteora DBC pool of Unzeen's config (docs/INTEL.md). */
    venue: "pumpfun" | "meteora-dbc" | null;
    status: "curve" | "graduated" | "unknown";
    curveProgressPct?: string;
    lpBurnedPct?: string;
  };
  socials?: { twitter?: string; telegram?: string; website?: string };
  /** Only our own /media/<sha40>.<ext>, never an external URL (T2). */
  image?: string;
  /** Name / symbol from on-chain metadata (public). */
  name?: string;
  symbol?: string;
  unzeen?: { launch: true };
}

/** Latest curve state from subscriptions/polling: kept in memory, written only in the tick transaction. */
export interface CurveUpdate {
  mint: string;
  progressPct: string;
  graduated: boolean;
  priceSol: string;
  marketCapSol: string;
  slot: number;
}

export interface WarmEntry {
  mint: string;
  /** Hot: snapshot every 5 min; else every 30 min. */
  hot: boolean;
  /** Pool token (core: in `tokens` / `mint_vaults`): priced on every tick (INTEL v2). */
  pinned?: boolean;
  /** as_of of the current snapshot (unix ms), null = none yet. */
  asOf: number | null;
}

/** Token card for mints not in `tokens` (intel_tokens). */
export interface TokenCard {
  mint: string;
  venue: "pumpfun" | "meteora-dbc" | "jupiter";
  symbol: string;
  name: string;
  image: string | null;
  decimals: number;
  status: "curve" | "graduated";
  priceSol: string;
  marketCapSol: string;
  /** Unix ms; unknown -> asOf. */
  createdAt: number;
}

/** Everything one tick writes, in ONE transaction (docs/INTEL.md "Тик индексатора" step 4). */
export interface TickCommit {
  /** Minute of the tick start (unix ms). */
  asOf: number;
  tickStartedAt: number;
  nextTickAt: number;
  rows: TokenSafety[];
  cards: TokenCard[];
  /** Mints whose account does not exist / is not an SPL mint -> token_safety.missing. */
  missing: string[];
  /** Every mint of the tick batch (real and decoys alike): intel_warm.expires_at = now + 7 d. Empty if the batch failed. */
  batch: string[];
  /** Real CAs that got a snapshot (or missing) this tick: removed from the queue. */
  consumed: string[];
  curveUpdates: CurveUpdate[];
  /** Current subscription set (real and decoy alike). */
  subscriptions: { account: string; mint: string; kind: "pump_curve" }[];
  /**
   * INTEL v2 price pass: one row per pinned mint read on this tick (`intel_prices`,
   * tick_at = tickStartedAt). Empty when the pass failed (nothing written).
   */
  prices?: PriceRow[];
}

/** `intel_prices` row: SOL per 1 whole token (> 0), curve status. */
export interface PriceRow {
  mint: string;
  priceSol: string;
  status: "curve" | "graduated";
}

/**
 * What the indexer needs from core's tables (docs/INTEL.md, migration 0007).
 * No method takes or returns "requested vs decoy"; the indexer never logs mints.
 */
export interface IntelStore {
  /** intel_warm (pinned + unexpired). */
  warmSet(): Promise<WarmEntry[]>;
  /** Up to `max` queued CAs, NOT removed (removed in commitTick.consumed). Called only at a tick. */
  peekLookups(max: number): Promise<string[]>;
  /** Mints launched through Unzeen (trades.kind = 'create'): T1. */
  unzeenLaunches(): Promise<Set<string>>;
  /**
   * Creator addresses derived by the relayer (public list, written before the
   * create is signed): a curve whose creator is here is an Unzeen launch even
   * before `trades` has its create row (T1 race).
   */
  poolCreators(): Promise<Set<string>>;
  /** Public pool vault addresses. */
  poolVaults(): Promise<Set<string>>;
  /** Socials / image already in the current snapshot (uri JSON is immutable): no refetch. */
  offchain(mint: string): Promise<OffchainInfo | null>;
  commitTick(t: TickCommit): Promise<void>;
}

export interface OffchainInfo {
  socials?: TokenSafety["socials"];
  image?: string;
  fetchedAt: number;
  ok: boolean;
}
