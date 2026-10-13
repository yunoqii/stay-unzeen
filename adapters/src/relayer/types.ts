import type { Keypair } from "@solana/web3.js";
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

/**
 * RELAYER v3 `fair_create`: one atomic create + buy of a fair launch. Like
 * create, but the mint keypair comes from core (`mint_secret`) and is the same
 * on every attempt, so a retry can never create a second mint. The keypair is
 * secret until the tx lands: never log the spec.
 */
export interface FairCreateJobSpec {
  kind: "fair_create";
  venue: VenueId;
  meta: { name: string; symbol: string; image?: string | null };
  /** The whole launch buy, lamports (venue fees included). */
  lamportsIn: bigint;
  /** Minimum tokens (> 0). */
  minOut: bigint;
  mintKeypair: Keypair;
}

/** RELAYER v3 `attest`: SPL Memo with exactly `memo` (64 hex), signed by the pool's attestation key. */
export interface AttestJobSpec {
  kind: "attest";
  memo: string;
  /**
   * F14: which attestation key signs (`meta.purpose`): "verify" = the public
   * Verify operator key, "fair" = the fair-launch key. Missing -> "fair", so a
   * job without the marker never uses the public Verify key.
   */
  purpose: "verify" | "fair";
}

/**
 * RELAYER v7 `fund_vaults` (core 0015, `meta.purpose = "rebalance"`): ONE tx
 * from the pool's rebalance address spreading up to `lamports` over the vaults.
 */
export interface FundVaultsJobSpec {
  kind: "fund_vaults";
  lamports: bigint;
}

/**
 * RELAYER v7 `consolidate` (core 0017): move the WHOLE balance of `mint` from
 * the fair-launch leg vault `from` (`meta.from`) to the mint's vault `to` (`dest`).
 */
export interface ConsolidateJobSpec {
  kind: "consolidate";
  mint: string;
  from: string;
  to: string;
}

export type JobSpec = BuyJobSpec | SellJobSpec | CreateJobSpec | WithdrawJobSpec | FairCreateJobSpec | AttestJobSpec | FundVaultsJobSpec | ConsolidateJobSpec;
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
  /**
   * RELAYER v6 §4 (review E10): Verify attest only — `out_sig` written together
   * with the signature and `vault`, BEFORE broadcast, so the operator signature
   * is published without waiting for the anchor.
   */
  outSig?: string;
  /**
   * Fair-launch v2: this attempt is a Jito bundle. `signature` / `rawTx` /
   * `vault` are leg 0 (create + first buy); `legs` are the other buys, signed
   * with the SAME blockhash (so leg 0 expired => every leg expired). Recorded
   * before the bundle is sent. Postgres keeps them only with the proposed
   * `relayer_jobs.bundle_legs` column; without it they are rediscovered on
   * chain after the blockhash expired (FairBundler.discoverLegs).
   */
  bundle?: { legs: BundleLeg[] };
}

/** A non-create leg of a fair-launch bundle (public data once sent). */
export interface BundleLeg {
  signature: string;
  vault: string;
  /** base64 wire bytes (memory queue only), to resend the bundle. */
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
  /** RELAYER v6 `out_creator_fee` (0013): creator fee of this launch tx; null = unknown (core estimates). */
  creatorFee?: bigint | null;
  /**
   * Fair-launch v2 bundle: the other legs that landed (each a buy with its own
   * signature, one feed row each). `tokenAmount` / `solAmount` / `networkFee` /
   * `creatorFee` above are then the TOTALS of the launch (leg 0 + these), as
   * core settles one launch per job; `signature`/`slot`/`vault` stay leg 0's.
   */
  legs?: TradeExecution[];
}

/** attest: memo read back from the confirmed tx (`out_memo`); `vault` = attestation key. */
export interface AttestExecution {
  kind: "attest";
  signature: string;
  slot: number;
  vault: string;
  memo: string;
  networkFee: bigint;
  blockTime: number | null;
  /**
   * RELAYER v4 `out_sig`: base58 ed25519 of the attestation key over the 32
   * bytes hex-decoded from the job's `meta.memo`. Core checks it against
   * `vault` before publishing it as the operator signature.
   */
  outSig?: string;
}

/** fund_vaults: lamports that reached the vaults (`out_lamports`); `vault` = rebalance address. */
export interface FundExecution {
  kind: "fund_vaults";
  signature: string;
  slot: number;
  vault: string;
  lamports: bigint;
  networkFee: bigint;
  blockTime: number | null;
}

/**
 * consolidate: tokens moved (`out_token_amount`); `vault` = the leg vault.
 * `signature` null = the vault held nothing (no tx was needed).
 */
export interface ConsolidateExecution {
  kind: "consolidate";
  signature: string | null;
  slot: number | null;
  vault: string;
  mint: string;
  to: string;
  tokenAmount: bigint;
  networkFee: bigint;
}

/** fair_create executes like create (same feed rows); `CreateExecution.mint` = pubkey of `mint_secret`. */
export type Execution = TradeExecution | CreateExecution | WithdrawExecution | AttestExecution | FundExecution | ConsolidateExecution;

export type JobResult =
  /** Done on chain; amounts are the executed ones. */
  | { status: "executed"; execution: Execution }
  /** Final failure; holds are released by the ledger. `signature` if a tx landed with an error. */
  | { status: "failed"; code: ApiErrorCode; message: string; signature?: string }
  /** Transient: put back with a new `notBefore`. Recorded attempts are kept. */
  | { status: "retry"; code: ApiErrorCode; message: string; notBefore: number };

/**
 * relayer_jobs.exec_mode (core 0005). Lives only in the queue layer: it never
 * reaches a JobSpec, an executor (no instruction differs by mode, R-relayer-3)
 * or a log line (R-relayer-6).
 */
export type ExecMode = "now" | "delayed" | "max";

/**
 * Claim lane (R-relayer-1):
 * - "now": only exec_mode = 'now', taken as soon as due, by its own worker
 *   (never queued behind an epoch batch);
 * - "batch": delayed/max, random order among jobs of the same epoch
 *   (same not_before), N-4.
 * - "attest": only op = 'attest' (RELAYER v5 §3). Its own loop, so the
 *   fair-launch root goes out within the ~30 s before the drand round even
 *   while the now lane drives a long fair_create / the batch lane an epoch.
 *   Attest jobs are never taken by the now / batch lanes. Fair-launch attests
 *   before Verify ones (the Verify anchor has no deadline).
 * Omitted: any job, attest first (tests, single-loop tools).
 */
export type Lane = "now" | "batch" | "attest";

/** Storage of relayer jobs (in-memory now, Postgres per docs/RELAYER.md later). */
export interface JobQueue {
  /**
   * Leases the next due job (`notBefore <= now`, queued or lease expired),
   * increments `claims`. Null when nothing is due.
   */
  claim(opts: { workerId: string; now: number; leaseMs: number; lane?: Lane }): Promise<ClaimedJob | null>;
  /**
   * Durably records a signed tx of the job. Called BEFORE broadcasting it;
   * throws LeaseLostError (then nothing must be sent).
   */
  reportSent(job: { id: string; leaseId: string }, attempt: SentAttempt): Promise<void>;
  /** Final or retry outcome of the current claim; ends the lease. */
  reportResult(job: { id: string; leaseId: string }, result: JobResult): Promise<void>;
}
