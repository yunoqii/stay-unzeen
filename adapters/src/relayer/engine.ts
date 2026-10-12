import { randomBytes } from "node:crypto";
import type { Signer } from "@solana/web3.js";
import { AdapterError, type ApiErrorCode } from "../errors";
import type { SignedTx } from "../tx";
import type { VenueId } from "../types";
import type { ChainProbe, JobExecutor } from "./executors";
import { cryptoRng, retryNotBefore, type Rng } from "./random";
import { LeaseLostError, type ClaimedJob, type Execution, type JobQueue, type JobResult, type JobSpec, type Lane, type SentAttempt } from "./types";
import type { MintVaults } from "./mint-vaults";
import { VaultsBusyError, type VaultPool, type VaultRequest } from "./vaults";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Privacy-safe relayer events: kind and outcome code only. Never job ids,
 * signatures, vaults, amounts or mints (review-day3: no action_id next to a
 * signature; AdapterError.cause carries addresses, so not even messages).
 */
export interface RelayerEvent {
  event: "executed" | "failed" | "retry" | "resend";
  kind: JobSpec["kind"];
  code?: ApiErrorCode;
}

export interface Executors {
  trade: Partial<Record<VenueId, JobExecutor>>;
  withdraw: JobExecutor;
}

export interface RelayerOptions {
  queue: JobQueue;
  pool: VaultPool;
  executors: Executors;
  probe: ChainProbe;
  /** D4: mint -> vault pins. Without it vaults rotate freely (tests, legacy). */
  mintVaults?: MintVaults;
  clock?: Clock;
  rng?: Rng;
  workerId?: string;
  /** Lease per claim; must exceed the worst-case processing time. */
  leaseMs?: number;
  /** Fresh signed transactions per claim (after an expired blockhash). */
  maxSendAttempts?: number;
  /** Claims before a transient failure becomes final. */
  maxClaims?: number;
  /** Poll interval / budget while waiting for an ambiguous send to resolve. */
  pollMs?: number;
  resolveTimeoutMs?: number;
  onEvent?: (e: RelayerEvent) => void;
}

/** Codes worth retrying later (pool can be topped up, RPC can recover). */
const TRANSIENT: ReadonlySet<ApiErrorCode> = new Set(["venue_unavailable", "pool_liquidity"]);

/**
 * Executes relayer jobs. Invariants:
 * - every signed tx is recorded (`reportSent`) BEFORE broadcast;
 * - before signing anything new, every recorded attempt is resolved on chain:
 *   landed -> that is the result; pending -> wait, never send a second one;
 *   only expired (finalized height past lastValidBlockHeight) allows a resend;
 * - one in-flight transaction per vault (VaultPool busy set);
 * - executed amounts come from the landed tx; unreadable -> retry, never 0.
 */
export class Relayer {
  private readonly o: Required<Omit<RelayerOptions, "onEvent" | "mintVaults">> & Pick<RelayerOptions, "onEvent" | "mintVaults">;

  constructor(opts: RelayerOptions) {
    this.o = {
      clock: systemClock,
      rng: cryptoRng,
      workerId: randomBytes(4).toString("hex"),
      leaseMs: 10 * 60_000,
      maxSendAttempts: 3,
      maxClaims: 3, // RELAYER.md §4: unsent jobs fail after 3 claims
      pollMs: 2_000,
      resolveTimeoutMs: 120_000,
      ...opts,
    };
  }

  /**
   * Claims and processes one due job (of `lane`, if given). Returns false when
   * nothing was due. The lane only selects WHICH job is claimed: the job is
   * then processed exactly the same way (same executor, same fee, same tx).
   */
  async tick(lane?: Lane): Promise<boolean> {
    const job = await this.o.queue.claim({
      workerId: this.o.workerId,
      now: this.o.clock.now(),
      leaseMs: this.o.leaseMs,
      ...(lane ? { lane } : {}),
    });
    if (!job) return false;
    let result: JobResult;
    try {
      result = await this.process(job);
    } catch (e) {
      if (e instanceof LeaseLostError) return true; // another worker owns it now
      // Unknown state (a tx may be in flight): never fail, retry and re-resolve.
      result = {
        status: "retry",
        code: "internal",
        message: "unexpected relayer error",
        notBefore: retryNotBefore(this.o.clock.now(), job.claims, this.o.rng),
      };
    }
    try {
      await this.o.queue.reportResult(job, result);
    } catch (e) {
      if (!(e instanceof LeaseLostError)) throw e;
    }
    this.emit(job.spec.kind, result);
    return true;
  }

  /**
   * R-relayer-1: two independent loops in one process. The now lane polls
   * often and is never stuck behind an epoch being executed by the batch lane.
   * Errors are reported without the lane (R-relayer-6: no exec_mode in logs).
   */
  async runLanes(
    signal: AbortSignal,
    idle: { nowMs: number; batchMs: number } = { nowMs: 300, batchMs: 1_000 },
    onError?: (e: unknown) => void,
  ): Promise<void> {
    await Promise.all([this.run(signal, idle.nowMs, onError, "now"), this.run(signal, idle.batchMs, onError, "batch")]);
  }

  /** Runs until `signal` aborts; sleeps `idleMs` when nothing is due. */
  async run(signal: AbortSignal, idleMs = 1_000, onError?: (e: unknown) => void, lane?: Lane): Promise<void> {
    while (!signal.aborted) {
      let worked = false;
      try {
        worked = await this.tick(lane);
      } catch (e) {
        // DB / RPC trouble in claim or report (D7): nothing is failed here. A
        // job whose report was lost keeps its recorded signature; its lease
        // runs out and the next claim resolves it on chain first.
        onError?.(e);
        await this.o.clock.sleep(Math.max(idleMs, 2_000));
        continue;
      }
      if (!worked) await this.o.clock.sleep(idleMs);
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Vault constraints of a job (D4: one vault per mint).
   * - mint pinned: only that vault;
   * - buy of a new mint / create: least loaded vaults preferred, then pinned
   *   (`pinFor`; create pins its new mint after signing);
   * - sell / withdraw of an unpinned mint (positions from before the pins):
   *   any vault holding enough.
   */
  private async vaultRequest(job: ClaimedJob, ex: JobExecutor): Promise<{ req: VaultRequest; pinFor: string | null }> {
    const req = ex.vaultRequest(job.spec);
    const mv = this.o.mintVaults;
    if (!mv) return { req, pinFor: null };
    const spec = job.spec;
    if (spec.kind === "create") return { req: { ...req, load: await mv.load() }, pinFor: null };
    const pinned = await mv.get(spec.mint);
    if (pinned) return { req: { ...req, only: pinned }, pinFor: null };
    if (spec.kind === "buy") return { req: { ...req, load: await mv.load() }, pinFor: spec.mint };
    return { req, pinFor: null };
  }

  private executor(spec: JobSpec): JobExecutor {
    if (spec.kind === "withdraw") return this.o.executors.withdraw;
    const ex = this.o.executors.trade[spec.venue];
    if (!ex) throw new AdapterError("venue_unavailable", `no executor for venue ${spec.venue}`);
    return ex;
  }

  private async process(job: ClaimedJob): Promise<JobResult> {
    let ex: JobExecutor;
    try {
      ex = this.executor(job.spec);
    } catch (e) {
      // Venue not served by this relayer (e.g. no Meteora config on this network):
      // nothing was ever signed for it, so failing releases the hold safely.
      if (e instanceof AdapterError && job.attempts.length === 0) return this.failed(e);
      throw e;
    }

    // 1. Resolve everything sent before (crash, lost lease, ambiguous error).
    for (const a of [...job.attempts].reverse()) {
      const r = await this.resolve(job, ex, a, false);
      if (r) return r;
    }

    // 2. Nothing can land any more: build and send fresh transactions.
    for (let i = 0; i < this.o.maxSendAttempts; i++) {
      let vault: Signer;
      let pinFor: string | null;
      try {
        const v = await this.vaultRequest(job, ex);
        pinFor = v.pinFor;
        vault = await this.o.pool.acquire(v.req);
      } catch (e) {
        if (e instanceof VaultsBusyError) return this.retry(job, "venue_unavailable", "vaults busy", 2_000);
        return this.fromError(job, ex.classify(e));
      }
      try {
        const vaultKey = vault.publicKey.toBase58();
        if (pinFor !== null && this.o.mintVaults) {
          // First buy of a mint: pin it to this vault (another worker may have won the race).
          const winner = await this.o.mintVaults.assign(pinFor, vaultKey);
          if (winner !== vaultKey) return this.retry(job, "venue_unavailable", "mint pinned elsewhere", 500);
        }
        let tx: SignedTx;
        try {
          tx = await ex.prepare(job.spec, vault);
        } catch (e) {
          const ae = ex.classify(e);
          if (ae.code === "venue_unavailable" && i + 1 < this.o.maxSendAttempts) continue;
          return this.fromError(job, ae);
        }
        if (job.spec.kind === "create" && this.o.mintVaults) {
          // The new mint is known only now; pin it before anything is sent.
          const mint = (tx as SignedTx & { mint?: string }).mint;
          if (mint) await this.o.mintVaults.assign(mint, vaultKey);
        }
        const attempt: SentAttempt = {
          signature: tx.signature,
          lastValidBlockHeight: tx.lastValidBlockHeight,
          vault: vault.publicKey.toBase58(),
          sentAt: this.o.clock.now(),
          rawTx: Buffer.from(tx.raw).toString("base64"),
        };
        // Durable record first: if this throws, nothing has been sent.
        await this.o.queue.reportSent(job, attempt);
        await this.o.pool.markUsed(attempt.vault, attempt.sentAt).catch(() => undefined);
        try {
          await ex.submit(tx);
        } catch (e) {
          const ae = ex.classify(e);
          if (ae.landedErr) return this.failed(ae, tx.signature);
          if (ae.stage === "build" || ae.stage === "preflight") {
            // Rejected before broadcast: these bytes can never land.
            if (ae.code === "venue_unavailable" && i + 1 < this.o.maxSendAttempts) {
              this.o.onEvent?.({ event: "resend", kind: job.spec.kind });
              continue;
            }
            return this.fromError(job, ae);
          }
          // May have been broadcast: resolve on chain before anything else.
          const r = await this.resolve(job, ex, attempt, true);
          if (r) return r;
          this.o.onEvent?.({ event: "resend", kind: job.spec.kind });
          continue; // expired, never landed: safe to rebuild
        }
        return this.finalize(job, ex, attempt);
      } finally {
        await this.o.pool.release(vault).catch(() => undefined);
      }
    }
    return this.retryOrFail(job, "venue_unavailable", "transaction did not land");
  }

  /**
   * Settles a recorded attempt. Returns a result when it decides the job
   * (landed ok / landed with error / still pending), null when it expired
   * without landing (then a new transaction is allowed).
   */
  private async resolve(job: ClaimedJob, ex: JobExecutor, a: SentAttempt, justSent: boolean): Promise<JobResult | null> {
    const deadline = this.o.clock.now() + this.o.resolveTimeoutMs;
    const raw = a.rawTx ? Buffer.from(a.rawTx, "base64") : null;
    for (;;) {
      let st;
      try {
        st = await this.o.probe.state(a.signature, a.lastValidBlockHeight);
      } catch {
        st = null; // RPC trouble: we know nothing, keep waiting
      }
      if (st?.state === "landed") {
        if (st.err === null) return this.finalize(job, ex, a);
        const logs = await this.o.probe.logs(a.signature).catch(() => null);
        return this.failed(ex.classify(new Error(`transaction failed: ${JSON.stringify(st.err)}`), logs), a.signature);
      }
      if (st?.state === "expired") return null;
      if (this.o.clock.now() >= deadline) {
        // Still may land: keep the attempt recorded, come back later.
        return this.retry(job, "venue_unavailable", justSent ? "transaction unresolved" : "previous transaction unresolved", this.o.pollMs);
      }
      if (raw) await this.o.probe.rebroadcast(raw);
      await this.o.clock.sleep(this.o.pollMs);
    }
  }

  private async finalize(job: ClaimedJob, ex: JobExecutor, a: SentAttempt): Promise<JobResult> {
    let execution: Execution | null = null;
    try {
      execution = await ex.result(job.spec, a);
    } catch {
      execution = null;
    }
    // Landed but unreadable: keep the job (attempt recorded), re-read later.
    // Never report zero amounts as executed.
    if (!execution) return this.retry(job, "venue_unavailable", "landed, amounts not readable yet", 5_000);
    return { status: "executed", execution };
  }

  private fromError(job: ClaimedJob, e: AdapterError): JobResult {
    return TRANSIENT.has(e.apiCode) ? this.retryOrFail(job, e.apiCode, e.message) : this.failed(e);
  }

  private failed(e: AdapterError, signature?: string): JobResult {
    return { status: "failed", code: e.apiCode, message: e.code, ...(signature ? { signature } : {}) };
  }

  /**
   * Only called once every recorded attempt is known not to have landed, so
   * failing (and releasing the user's hold) cannot lose money.
   */
  private retryOrFail(job: ClaimedJob, code: ApiErrorCode, message: string): JobResult {
    if (job.claims >= this.o.maxClaims) return { status: "failed", code, message };
    return { status: "retry", code, message, notBefore: retryNotBefore(this.o.clock.now(), job.claims, this.o.rng) };
  }

  private retry(_job: ClaimedJob, code: ApiErrorCode, message: string, delayMs: number): JobResult {
    return { status: "retry", code, message, notBefore: this.o.clock.now() + delayMs };
  }

  private emit(kind: JobSpec["kind"], r: JobResult): void {
    if (!this.o.onEvent) return;
    if (r.status === "executed") this.o.onEvent({ event: "executed", kind });
    else this.o.onEvent({ event: r.status, kind, code: r.code });
  }
}
