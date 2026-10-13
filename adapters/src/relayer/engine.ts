import { randomBytes } from "node:crypto";
import type { Signer } from "@solana/web3.js";
import { AdapterError, type ApiErrorCode } from "../errors";
import type { SignedTx } from "../tx";
import type { VenueId } from "../types";
import { planFairLaunch, scaleMinOut } from "../fair-bundle";
import type { ChainProbe, JobExecutor } from "./executors";
import type { FairBundler } from "./fair-bundler";
import { cryptoRng, retryNotBefore, type Rng } from "./random";
import {
  LeaseLostError,
  type ClaimedJob,
  type CreateExecution,
  type Execution,
  type FairCreateJobSpec,
  type JobQueue,
  type JobResult,
  type JobSpec,
  type Lane,
  type SentAttempt,
  type TradeExecution,
} from "./types";
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
  /** "bundle": a fair-launch Jito bundle was sent; "consolidate": leg tokens moved to the mint's vault. */
  kind: JobSpec["kind"] | "bundle" | "consolidate";
  code?: ApiErrorCode;
}

export interface Executors {
  trade: Partial<Record<VenueId, JobExecutor>>;
  withdraw: JobExecutor;
  /** RELAYER v3 attest; absent = attest jobs fail venue_unavailable (nothing signed). */
  attest?: JobExecutor;
}

export interface RelayerOptions {
  queue: JobQueue;
  pool: VaultPool;
  executors: Executors;
  probe: ChainProbe;
  /** D4: mint -> vault pins. Without it vaults rotate freely (tests, legacy). */
  mintVaults?: MintVaults;
  /**
   * Fair-launch v2: multi-vault Jito bundles (mainnet, pump.fun). Absent (devnet,
   * Jito disabled) = every fair_create is the v1 single tx, exactly as before.
   */
  fairBundler?: FairBundler;
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
  private readonly o: Required<Omit<RelayerOptions, "onEvent" | "mintVaults" | "fairBundler">> &
    Pick<RelayerOptions, "onEvent" | "mintVaults" | "fairBundler">;
  /** Fair bundles whose leg tokens still sit on leg vaults (retried after each tick, best effort). */
  private readonly strays: { mint: string; to: string; from: string; tries: number }[] = [];

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
    if (result.status === "executed" && result.execution.kind === "create" && result.execution.legs?.length) {
      // D4: move the legs' tokens to the mint's vault right after the launch settles.
      for (const l of result.execution.legs) this.strays.push({ mint: result.execution.mint, to: result.execution.vault, from: l.vault, tries: 0 });
    }
    await this.consolidateStrays();
    return true;
  }

  /**
   * Fair-launch v2 consolidation (D4: one vault per mint): every leg vault
   * sends its whole balance of the new mint to the create vault. Idempotent by
   * balance (a repeat finds 0 or fails on insufficient funds, never doubles).
   * Best effort: a busy vault is retried on the next tick; after 20 tries the
   * stray stays where it is (still pool inventory, counted by Verify).
   */
  private async consolidateStrays(): Promise<void> {
    const fb = this.o.fairBundler;
    if (!fb || this.strays.length === 0) return;
    for (const s of [...this.strays]) {
      const signer = await this.o.pool.lockVault(s.from).catch(() => null);
      if (!signer) {
        if (++s.tries >= 20) this.strays.splice(this.strays.indexOf(s), 1);
        continue;
      }
      try {
        await fb.consolidate(s.mint, s.to, signer);
        this.strays.splice(this.strays.indexOf(s), 1);
        this.o.onEvent?.({ event: "executed", kind: "consolidate" });
      } catch {
        if (++s.tries >= 20) this.strays.splice(this.strays.indexOf(s), 1);
        this.o.onEvent?.({ event: "retry", kind: "consolidate" });
      } finally {
        await this.o.pool.release(signer).catch(() => undefined);
      }
    }
  }

  /**
   * R-relayer-1: independent loops in one process. The now lane polls often
   * and is never stuck behind an epoch being executed by the batch lane.
   * RELAYER v5 §3: attest has a third loop of its own, so a fair-launch root
   * is sent within its ~30 s window even while the now lane is busy with a
   * long fair_create (attest signs with its own key: no vault contention).
   * Errors are reported without the lane (R-relayer-6: no exec_mode in logs).
   */
  async runLanes(
    signal: AbortSignal,
    idle: { nowMs: number; batchMs: number; attestMs?: number } = { nowMs: 300, batchMs: 1_000 },
    onError?: (e: unknown) => void,
  ): Promise<void> {
    await Promise.all([
      this.run(signal, idle.nowMs, onError, "now"),
      this.run(signal, idle.batchMs, onError, "batch"),
      this.run(signal, idle.attestMs ?? idle.nowMs, onError, "attest"),
    ]);
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
  private async vaultRequest(spec: JobSpec, ex: JobExecutor): Promise<{ req: VaultRequest; pinFor: string | null }> {
    const req = ex.vaultRequest(spec);
    const mv = this.o.mintVaults;
    if (!mv) return { req, pinFor: null };
    if (spec.kind === "create") return { req: { ...req, load: await mv.load() }, pinFor: null };
    if (spec.kind === "attest") return { req, pinFor: null };
    if (spec.kind === "fair_create") {
      // The mint is fixed by core and identical on every attempt: a retry must
      // use the vault the first attempt pinned (D4), like a buy of a known mint.
      const mint = spec.mintKeypair.publicKey.toBase58();
      const pinned = await mv.get(mint);
      if (pinned) return { req: { ...req, only: pinned }, pinFor: null };
      return { req: { ...req, load: await mv.load() }, pinFor: mint };
    }
    const pinned = await mv.get(spec.mint);
    if (pinned) return { req: { ...req, only: pinned }, pinFor: null };
    if (spec.kind === "buy") return { req: { ...req, load: await mv.load() }, pinFor: spec.mint };
    return { req, pinFor: null };
  }

  private executor(spec: JobSpec): JobExecutor {
    if (spec.kind === "withdraw") return this.o.executors.withdraw;
    if (spec.kind === "attest") {
      if (!this.o.executors.attest) throw new AdapterError("venue_unavailable", "no attestation key configured");
      return this.o.executors.attest;
    }
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
    if (job.spec.kind === "fair_create" && job.spec.venue === "pumpfun" && this.o.fairBundler) {
      return this.processFair(job, job.spec, ex, this.o.fairBundler);
    }
    return this.sendFresh(job, ex, job.spec);
  }

  /**
   * Fresh single-transaction attempts of `spec` (the job's own spec, or a
   * capped fair_create from the fair-launch fallback).
   */
  private async sendFresh(job: ClaimedJob, ex: JobExecutor, spec: JobSpec): Promise<JobResult> {
    for (let i = 0; i < this.o.maxSendAttempts; i++) {
      let vault: Signer;
      let pinFor: string | null;
      const own = ex.ownSigner?.(spec) ?? null;
      try {
        if (own) {
          vault = own; // attest: the attestation key signs and pays; no vault lease
          pinFor = null;
        } else {
          const v = await this.vaultRequest(spec, ex);
          pinFor = v.pinFor;
          vault = await this.o.pool.acquire(v.req);
        }
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
          tx = await ex.prepare(spec, vault);
        } catch (e) {
          const ae = ex.classify(e);
          if (ae.code === "venue_unavailable" && i + 1 < this.o.maxSendAttempts) continue;
          return this.fromError(job, ae);
        }
        if (spec.kind === "create" && this.o.mintVaults) {
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
        const early = ex.earlyOutSig?.(spec) ?? null;
        if (early) attempt.outSig = early;
        // Durable record first: if this throws, nothing has been sent.
        await this.o.queue.reportSent(job, attempt);
        if (!own) await this.o.pool.markUsed(attempt.vault, attempt.sentAt).catch(() => undefined);
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
        if (!own) await this.o.pool.release(vault).catch(() => undefined);
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
      if (a.bundle) {
        // Never rebroadcast leg 0 alone (that would unbundle the launch): resend the whole bundle.
        const raws = bundleRaws(a);
        if (raws && this.o.fairBundler) await this.o.fairBundler.resend(raws);
      } else if (raw) {
        await this.o.probe.rebroadcast(raw);
      }
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
    if (job.spec.kind === "fair_create" && execution.kind === "create" && this.o.fairBundler) {
      return this.withLegs(job, a, execution, this.o.fairBundler);
    }
    return { status: "executed", execution };
  }

  /**
   * Fair-launch v2: leg 0 landed; add the other legs of its bundle. Legs come
   * from the attempt record or, when it was lost (Postgres without
   * `bundle_legs`, restart), from the chain once the shared blockhash expired
   * (an unbundled leg may still land until then). A leg that is still pending
   * keeps the job open; a leg that failed or never landed is simply not part
   * of the launch (its lamports were not spent: core refunds them pro rata).
   */
  private async withLegs(job: ClaimedJob, a: SentAttempt, base: CreateExecution, fb: FairBundler): Promise<JobResult> {
    let legs = a.bundle?.legs;
    if (!legs) {
      // In-process single attempt (raw bytes known, no bundle): nothing else to read.
      if (a.rawTx) return { status: "executed", execution: base };
      if (!(await fb.expired(a.lastValidBlockHeight).catch(() => false))) {
        return this.retry(job, "venue_unavailable", "launch landed, waiting for legs", 10_000);
      }
      try {
        legs = await fb.discoverLegs(base.mint, base.vault, this.o.pool.keys());
      } catch {
        return this.retry(job, "venue_unavailable", "launch landed, legs not readable yet", 5_000);
      }
    }
    const done: TradeExecution[] = [];
    let creatorFee = base.creatorFee ?? null;
    for (const l of legs) {
      let st;
      try {
        st = await this.o.probe.state(l.signature, a.lastValidBlockHeight);
      } catch {
        return this.retry(job, "venue_unavailable", "leg state unknown", 5_000);
      }
      if (st.state === "pending") return this.retry(job, "venue_unavailable", "leg unresolved", this.o.pollMs);
      if (st.state === "expired" || st.err !== null) continue;
      const r = await fb.legResult(l.signature, l.vault, base.mint).catch(() => null);
      if (!r) return this.retry(job, "venue_unavailable", "leg landed, amounts not readable yet", 5_000);
      creatorFee = creatorFee !== null && r.creatorFee !== null ? creatorFee + r.creatorFee : null;
      done.push({
        kind: "buy",
        signature: r.signature,
        slot: r.slot,
        vault: r.vault,
        mint: r.mint,
        tokenAmount: r.tokenAmount,
        solAmount: r.solAmount,
        networkFee: r.networkFee,
        decimals: r.decimals,
        fromEvent: true,
        blockTime: r.blockTime ?? null,
        symbol: base.symbol,
        market: null,
      });
    }
    if (done.length === 0) return { status: "executed", execution: base };
    const sum = (f: (e: { tokenAmount: bigint; solAmount: bigint; networkFee: bigint }) => bigint) =>
      done.reduce((s, e) => s + f(e), f(base));
    const market = (await fb.market?.(base.mint).catch(() => null)) ?? base.market;
    return {
      status: "executed",
      execution: {
        ...base,
        tokenAmount: sum((e) => e.tokenAmount),
        solAmount: sum((e) => e.solAmount),
        networkFee: sum((e) => e.networkFee),
        creatorFee,
        market,
        legs: done,
      },
    };
  }

  /**
   * Fair-launch v2 fresh attempts. Plans the launch over the vaults' current
   * balances:
   * - one vault can carry it -> exactly the v1 single tx (`sendFresh`);
   * - else, Jito available and tries left -> one bundle (leg 0 = create from the
   *   pinned / richest vault, then buys from up to 4 others), all recorded
   *   before the send, resolved on leg 0 (shared blockhash);
   * - else -> ONE capped tx (what one vault can spend, min_out scaled by the
   *   same ratio); core refunds the rest pro rata from out_lamports.
   * The mint keypair is core's, identical on every attempt and path.
   */
  private async processFair(job: ClaimedJob, spec: FairCreateJobSpec, ex: JobExecutor, fb: FairBundler): Promise<JobResult> {
    const mint = spec.mintKeypair.publicKey.toBase58();
    // Bundles already tried for this job: recorded ones (memory) or claims so far (Postgres keeps one attempt).
    const used = Math.max(job.attempts.filter((x) => x.bundle).length, job.claims - 1);
    let triesLeft = Math.max(0, fb.bundleTries - used);
    for (let i = 0; i < this.o.maxSendAttempts; i++) {
      const pinned = (await this.o.mintVaults?.get(mint)) ?? null;
      let plan;
      try {
        const keys = this.shuffled(this.o.pool.keys());
        const sol = await this.o.pool.solBalances(keys);
        plan = planFairLaunch(spec.lamportsIn, keys.map((k) => ({ key: k, sol: sol.get(k) ?? 0n })), fb.plan, {
          pinned,
          bundle: triesLeft > 0 && fb.available(),
        });
      } catch (e) {
        return this.fromError(job, ex.classify(e));
      }
      if (plan.mode === "insufficient") return this.retryOrFail(job, "pool_liquidity", "no vault can carry the launch");
      if (plan.mode === "single") {
        if (!plan.capped) return this.sendFresh(job, ex, spec);
        let capped: FairCreateJobSpec;
        try {
          const [full, part] = await Promise.all([fb.freshQuote(spec.lamportsIn), fb.freshQuote(plan.lamports)]);
          capped = { ...spec, lamportsIn: plan.lamports, minOut: scaleMinOut(spec.minOut, part, full) };
        } catch (e) {
          return this.fromError(job, ex.classify(e));
        }
        return this.sendFresh(job, ex, capped);
      }

      // Bundle: lock every leg vault (never waits; busy -> retry soon).
      triesLeft--;
      const signers: Signer[] = [];
      try {
        for (const l of plan.legs) {
          const s = await this.o.pool.lockVault(l.vault);
          if (!s) return this.retry(job, "venue_unavailable", "vaults busy", 2_000);
          signers.push(s);
        }
        const a = plan.legs[0]!.vault;
        if (!pinned && this.o.mintVaults) {
          const winner = await this.o.mintVaults.assign(mint, a);
          if (winner !== a) return this.retry(job, "venue_unavailable", "mint pinned elsewhere", 500);
        }
        let prepared;
        try {
          prepared = await fb.prepare(spec, plan.legs.map((l, k) => ({ vault: signers[k]!, lamports: l.lamports })));
        } catch (e) {
          const ae = ex.classify(e);
          if (ae.code === "venue_unavailable" && i + 1 < this.o.maxSendAttempts) continue;
          return this.fromError(job, ae);
        }
        const [leg0, ...rest] = prepared.legs;
        if (!leg0 || leg0.vault !== a) throw new AdapterError("internal", "bundle leg 0 is not the create vault");
        const attempt: SentAttempt = {
          signature: leg0.signature,
          lastValidBlockHeight: leg0.lastValidBlockHeight,
          vault: a,
          sentAt: this.o.clock.now(),
          rawTx: Buffer.from(leg0.raw).toString("base64"),
          bundle: { legs: rest.map((l) => ({ signature: l.signature, vault: l.vault, rawTx: Buffer.from(l.raw).toString("base64") })) },
        };
        // Durable record of EVERY leg first: if this throws, nothing has been sent.
        await this.o.queue.reportSent(job, attempt);
        for (const l of prepared.legs) await this.o.pool.markUsed(l.vault, attempt.sentAt).catch(() => undefined);
        try {
          await fb.send(prepared.legs.map((l) => l.raw));
        } catch (e) {
          const ae = ex.classify(e);
          if (ae.stage === "build" || ae.stage === "preflight") {
            // Leg 0 rejected by simulation: nothing was relayed.
            if (ae.code === "venue_unavailable" && i + 1 < this.o.maxSendAttempts) continue;
            return this.fromError(job, ae);
          }
          // Relay error: it may still have been accepted. Resolve on chain below.
        }
        const r = await this.resolve(job, ex, attempt, true);
        if (r) return r;
        this.o.onEvent?.({ event: "resend", kind: "bundle" });
        // Expired without landing (every leg shares leg 0's blockhash): next try, or the fallback.
      } finally {
        for (const s of signers) await this.o.pool.release(s).catch(() => undefined);
      }
    }
    return this.retryOrFail(job, "venue_unavailable", "launch did not land");
  }

  private shuffled<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.o.rng.int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
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

/** Wire bytes of a recorded bundle (leg 0 first); null when any are missing (after a restart). */
function bundleRaws(a: SentAttempt): Uint8Array[] | null {
  if (!a.rawTx || !a.bundle || a.bundle.legs.some((l) => !l.rawTx)) return null;
  return [Buffer.from(a.rawTx, "base64"), ...a.bundle.legs.map((l) => Buffer.from(l.rawTx!, "base64"))];
}
