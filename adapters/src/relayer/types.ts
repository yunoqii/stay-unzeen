import type { ApiErrorCode } from "../errors";
import type { VenueId } from "../types";

/**
 * Relayer jobs. One job = one on-chain transaction (a withdraw with N parts is
 * N jobs, each with its own random `notBefore`). Amounts are already in
 * Solana units: ZEC <-> SOL conversion and holds are the ledger's job (core).
 *
 * Jobs carry no anon key, no deposit reference and no user data: the relayer
 * only knows "buy X lamports of mint M".
 */
export interface BuyJobSpec {
  kind: "buy";
  venue: VenueId;
  mint: string;
  /** Lamports to spend, venue fees included. */
  lamportsIn: bigint;
  /** Minimum tokens (base units) or the job fails with `slippage`. */
  minOut: bigint;
}

export interface SellJobSpec {
  kind: "sell";
  venue: VenueId;
  mint: string;
  /** Token base units to sell. */
  amount: bigint;
  /** Minimum lamports out (net of venue fees) or the job fails with `slippage`. */
  minLamports: bigint;
}

export interface CreateJobSpec {
  kind: "create";
  venue: VenueId;
  /**
   * From core (`relayer_jobs.meta`). `image` is the user's data URL; it is
   * re-encoded without metadata and published by the server before signing.
   */
  meta: { name: string; symbol: string; image?: string | null };
  /** First buy, lamports (venue fees included); 0 = create only. */
  lamportsIn: bigint;
  /** Minimum tokens of the first buy. */
  minOut: bigint;
}

export interface WithdrawJobSpec {
  kind: "withdraw";
  mint: string;
  /** Fresh user address (wallet, on curve). */
  to: string;
  /** Token base units for this part. */
  amount: bigint;
  /** SOL drop for the recipient's fees (core: `gas_lamports`); random in the default range if omitted. */
  gasLamports?: bigint;
}

export type JobSpec = BuyJobSpec | SellJobSpec | CreateJobSpec | WithdrawJobSpec;
export type JobKind = JobSpec["kind"];

/**
 * A signed transaction recorded BEFORE it is broadcast. Before any resend the
 * relayer checks every recorded attempt on chain, so a lost confirmation never
 * turns into a second buy.
 */
export interface SentAttempt {
  signature: string;
  lastValidBlockHeight: number;
  vault: string;
  /** unix ms */
  sentAt: number;
  /** base64 wire bytes, to rebroadcast after a restart (public data once sent). */
  rawTx?: string;
}

export interface Job {
  id: string;
  spec: JobSpec;
  /** unix ms; the job is not executed before this time (jitter). */
  notBefore: number;
  /** How many times the job has been claimed, this claim included. */
  claims: number;
  attempts: SentAttempt[];
}

export interface ClaimedJob extends Job {
  /** Random token of this claim; reports with a stale lease are rejected. */
  leaseId: string;
  /** unix ms; after this another worker may claim the job again. */
  leaseUntil: number;
}

/** Thrown by reportSent / reportResult when the lease was lost (expired and re-claimed). */
export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`lease lost for job ${jobId.slice(0, 8)}…`);
    this.name = "LeaseLostError";
  }
}

export interface TradeExecution {
  kind: "buy" | "sell";
  signature: string;
  slot: number;
  vault: string;
  mint: string;
  /** Tokens received (buy) / sold (sell), base units, from the TradeEvent. */
  tokenAmount: bigint;
  /** Lamports paid (buy) / received (sell), venue fees included, from the TradeEvent. */
  solAmount: bigint;
  networkFee: bigint;
  decimals: number;
  /** false: amounts are balance deltas (event not found). */
  fromEvent: boolean;
  /** Block time, unix seconds (feed `ts`); null if the node has none. */
  blockTime: number | null;
  /** Token symbol from on-chain metadata (feed fallback when `tokens` has no row); null if unknown. */
  symbol: string | null;
  /** Public market snapshot after the trade (tokens table); null if unreadable. */
  market: { priceSol: string; marketCapSol: string; status: "curve" | "graduated" } | null;
}

export interface WithdrawExecution {
  kind: "withdraw";
  signature: string;
  slot: number;
  vault: string;
  mint: string;
  to: string;
  tokenAmount: bigint;
  gasDropLamports: bigint;
  networkFee: bigint;
  decimals: number;
  blockTime: number | null;
}

export interface CreateExecution {
  kind: "create";
  signature: string;
  slot: number;
  vault: string;
  /** The new mint (`out_mint`). */
  mint: string;
  /** Fresh creator address recorded on chain (public). */
  creator: string;
  /** First buy: tokens received / lamports paid (fees included), 0/0 without one. */
  tokenAmount: bigint;
  solAmount: bigint;
  networkFee: bigint;
  decimals: number;
  blockTime: number | null;
  /** Public token row (`tokens`). */
  name: string;
  symbol: string;
  /** Sanitized image URL served by us / IPFS; null without image. */
  imageUrl: string | null;
  market: { priceSol: string; marketCapSol: string; status: "curve" | "graduated" } | null;
}

export type Execution = TradeExecution | CreateExecution | WithdrawExecution;

export type JobResult =
  /** Done on chain; amounts are the executed ones. */
  | { status: "executed"; execution: Execution }
  /** Final failure; holds are released by the ledger. `signature` if a tx landed with an error. */
  | { status: "failed"; code: ApiErrorCode; message: string; signature?: string }
  /** Transient: put back with a new `notBefore`. Recorded attempts are kept. */
  | { status: "retry"; code: ApiErrorCode; message: string; notBefore: number };

/** Storage of relayer jobs (in-memory now, Postgres per docs/RELAYER.md later). */
export interface JobQueue {
  /**
   * Leases the next due job (`notBefore <= now`, queued or lease expired),
   * increments `claims`. Null when nothing is due.
   */
  claim(opts: { workerId: string; now: number; leaseMs: number }): Promise<ClaimedJob | null>;
  /**
   * Durably records a signed tx of the job. Called BEFORE broadcasting it;
   * throws LeaseLostError (then nothing must be sent).
   */
  reportSent(job: { id: string; leaseId: string }, attempt: SentAttempt): Promise<void>;
  /** Final or retry outcome of the current claim; ends the lease. */
  reportResult(job: { id: string; leaseId: string }, result: JobResult): Promise<void>;
}
