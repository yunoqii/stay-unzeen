import { randomBytes, randomInt } from "node:crypto";
import { getAddress, parseEventLogs, type Address, type Hex, type LocalAccount, type TransactionReceipt } from "viem";
import { AdapterError, type ApiErrorCode } from "../../errors";
import type { MintVaults } from "../../relayer/mint-vaults";
import { LeaseLostError, type Lane } from "../../relayer/types";
import type { VaultLock } from "../../relayer/vaults";
import type { EvmExecutor, OnSigned } from "../executor";
import type { EvmKeyring } from "../keys";
import { ponsV2CurveAbi } from "../pons/abi/curve";
import { ponsV2TokenAbi } from "../pons/abi/token";
import { PHASE, type PonsAdapter } from "../pons/adapter";
import { reconcileCreator } from "../pons/creator";
import { readyToGraduate, spot } from "../pons/math";
import type { EvmTxResult } from "../types";
import type { EvmWithdrawer } from "../withdraw";
import { MemorySentClock, type LaunchStore, type SentClock } from "./launches";
import { fundVaults } from "./pool-state";
import type { HoodClaimedJob, HoodExecution, HoodJobResult, HoodJobSpec, HoodMarket, HoodQueue } from "./queue";

/**
 * Relayer engine of the Robinhood Chain instance (venue `pons`).
 * Invariants (same as Solana, RELAYER v12):
 * - the main tx of every job is recorded (`reportSent`: hash + nonce + vault)
 *   BEFORE broadcast; before signing anything new a recorded tx is resolved:
 *   landed -> that is the result; pending -> wait; dropped (unknown to the node
 *   after a grace period, or its nonce consumed by another tx) -> execute anew;
 * - one job at a time per vault: Postgres advisory lock (all processes) on top
 *   of the in-process nonce mutex;
 * - one vault per mint (`mint_vaults`), creates pin the vault that receives the tokens;
 * - create: creator index + start block stored BEFORE funding; a restart reuses
 *   the creator, and launches whose job settled otherwise are reconciled;
 * - amounts come from the landed tx only; unreadable (`amountsKnown = false`)
 *   -> retry and re-read, never credit a guess;
 * - quotes / market snapshots are taken for the ACTUAL vault of the job.
 * Events carry kind and code only (no ids, hashes, addresses, amounts).
 */

export interface HoodRelayerEvent {
  event: "executed" | "failed" | "retry" | "needs_review";
  kind: HoodJobSpec["kind"];
  code?: ApiErrorCode;
}

export interface HoodRelayerOptions {
  queue: HoodQueue;
  adapter: PonsAdapter;
  executor: EvmExecutor;
  keyring: EvmKeyring;
  /** Trading vaults of the pool (branch 0). */
  vaults: LocalAccount[];
  mintVaults: MintVaults;
  lock: VaultLock;
  launches: LaunchStore;
  /** Send time of every signed main tx (default: in memory; production: FileSentClock). */
  sentClock?: SentClock;
  withdrawer: EvmWithdrawer;
  /** Publishes the user's data-URL image server-side, returns its URL (on-chain `logo`). Default: no logo. */
  publishImage?: (dataUrl: string) => Promise<string | null>;
  workerId?: string;
  leaseMs?: number;
  /** Claims before an unsent job fails. Default 5. */
  maxClaims?: number;
  /** A recorded tx unknown to the node for this long is considered dropped. Default 60 s. */
  dropGraceMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (e: HoodRelayerEvent) => void;
}

/** Below this an attestation key can't pay one attest tx (~25k gas at a few gwei at most). */
export const ATTEST_MIN_GAS_WEI = 10n ** 12n;
/** Retry delay of an attest job while its key has no gas. */
export const ATTEST_NO_GAS_RETRY_MS = 10 * 60_000;

export class HoodRelayer {
  private readonly o: HoodRelayerOptions & Required<Pick<HoodRelayerOptions, "workerId" | "leaseMs" | "maxClaims" | "dropGraceMs" | "now" | "sleep">>;
  private readonly byAddress: Map<string, LocalAccount>;
  private readonly clock: SentClock;

  constructor(o: HoodRelayerOptions) {
    this.o = {
      workerId: randomBytes(4).toString("hex"),
      leaseMs: 10 * 60_000,
      maxClaims: 5,
      dropGraceMs: 60_000,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...o,
    };
    if (o.vaults.length === 0) throw new Error("hood relayer: no vaults");
    this.byAddress = new Map(o.vaults.map((v) => [getAddress(v.address), v]));
    this.clock = o.sentClock ?? new MemorySentClock();
  }

  /** Claims and processes one due job. False when nothing was due. */
  async tick(lane?: Lane): Promise<boolean> {
    const job = await this.o.queue.claim({ workerId: this.o.workerId, leaseMs: this.o.leaseMs, ...(lane ? { lane } : {}) });
    if (!job) return false;
    let result: HoodJobResult;
    try {
      result = await this.process(job);
    } catch (e) {
      if (e instanceof LeaseLostError) return true;
      result = { status: "retry", code: "internal", message: "unexpected relayer error", notBefore: this.o.now() + 30_000 };
    }
    try {
      await this.o.queue.reportResult(job, result);
    } catch (e) {
      if (!(e instanceof LeaseLostError)) throw e;
      return true;
    }
    if (result.status === "executed" || result.status === "failed") await this.clock.forget(job.id).catch(() => undefined);
    if (result.status === "executed" && job.spec.kind === "create") await this.o.launches.delete(job.id).catch(() => undefined);
    // review-hood-final #10: a failed create returns its creator's ETH now, not at the next restart.
    if (result.status === "failed" && job.spec.kind === "create") await this.reconcileOne(job.id).catch(() => undefined);
    this.o.onEvent?.({ event: result.status, kind: job.spec.kind, ...(result.status === "failed" || result.status === "retry" ? { code: result.code } : {}) });
    return true;
  }

  /** Lane loops until `signal` aborts (now / batch / attest, like Solana). */
  async run(signal: AbortSignal, onError: (e: unknown) => void = () => undefined, idleMs = 1_000): Promise<void> {
    const loop = async (lane: Lane) => {
      while (!signal.aborted) {
        const busy = await this.tick(lane).catch((e) => (onError(e), false));
        if (!busy) await this.o.sleep(idleMs);
      }
    };
    await Promise.all([loop("now"), loop("batch"), loop("attest")]);
  }

  // -------------------------------------------------------------------------

  /** RELAYER v15: a LANDED tx whose result could not be read -> needs_review (never failed: no refund). */
  private review(message: string): HoodJobResult {
    return { status: "needs_review", message };
  }

  private retry(code: ApiErrorCode, message: string, ms: number): HoodJobResult {
    return { status: "retry", code, message, notBefore: this.o.now() + ms };
  }

  private fromError(e: unknown, job: HoodClaimedJob): HoodJobResult {
    if (e instanceof LeaseLostError) throw e;
    const a = e instanceof AdapterError ? e : new AdapterError("internal", e instanceof Error ? e.message : String(e));
    // Maybe broadcast: never fail, resolve the recorded hash on the next claim.
    if (a.stage === "confirm" && !a.landedErr) return this.retry("venue_unavailable", a.message, 5_000);
    const transient = a.apiCode === "venue_unavailable" || a.apiCode === "pool_liquidity";
    if (transient && job.claims < this.o.maxClaims) return this.retry(a.apiCode, a.message, 15_000 + randomInt(15_000));
    return { status: "failed", code: a.apiCode, message: a.message };
  }

  private async process(job: HoodClaimedJob): Promise<HoodJobResult> {
    if (job.sent) {
      let r: HoodJobResult | null;
      try {
        r = await this.resolveSent(job);
      } catch (e) {
        // RPC trouble -> later; anything else here happens AFTER the tx was found landed
        // (receipt / logs not parseable): needs_review, never failed (review-hood-final #8).
        r = e instanceof AdapterError && e.apiCode === "venue_unavailable" ? this.retry("venue_unavailable", "RPC error", 15_000) : this.review("landed tx could not be parsed");
      }
      if (r) return r;
    } else if (job.claims > this.o.maxClaims) {
      return { status: "failed", code: "venue_unavailable", message: "too many attempts" };
    }
    const signer = await this.signerFor(job);
    if ("status" in signer) return signer;
    const lease = await this.o.lock.tryAcquire(signer.lockAddress);
    if (!lease) return this.retry("venue_unavailable", "vault busy", 2_000 + randomInt(3_000));
    try {
      return await this.execute(job, signer.vault);
    } catch (e) {
      return this.fromError(e, job);
    } finally {
      await lease.release();
    }
  }

  /** Vault (or attestation key) of the job; picks + pins a vault for a first buy. */
  private async signerFor(job: HoodClaimedJob): Promise<{ vault: LocalAccount; lockAddress: string } | HoodJobResult> {
    const s = job.spec;
    if (s.kind === "attest") {
      const a = this.o.keyring.attest(s.purpose);
      return { vault: a, lockAddress: getAddress(a.address) };
    }
    if (s.kind === "fund_vaults") {
      const r = this.o.keyring.rebalance(0);
      return { vault: r, lockAddress: getAddress(r.address) };
    }
    if (s.kind === "create") {
      const v = this.o.vaults[randomInt(this.o.vaults.length)]!;
      return { vault: v, lockAddress: getAddress(v.address) };
    }
    const pinned = await this.o.mintVaults.get(s.token);
    let addr = pinned;
    if (!addr) {
      if (s.kind !== "buy") return { status: "failed", code: "pool_liquidity", message: "no vault holds this token" };
      const pick = this.o.vaults[randomInt(this.o.vaults.length)]!;
      addr = await this.o.mintVaults.assign(s.token, getAddress(pick.address));
    }
    const v = this.byAddress.get(getAddress(addr));
    if (!v) return { status: "failed", code: "internal", message: "pinned vault is not a key of this relayer" };
    return { vault: v, lockAddress: getAddress(v.address) };
  }

  private onSigned(job: HoodClaimedJob, vault: Address, outSig?: string): OnSigned {
    return async (tx) => {
      // Clock first: a hash we may have broadcast is never forgotten (reportSent only keeps the last one).
      await this.clock.mark(job.id, tx.hash, this.o.now());
      await this.o.queue.reportSent(job, { hash: tx.hash, nonce: tx.nonce, vault: getAddress(vault), sentAt: this.o.now(), ...(outSig ? { outSig } : {}) });
    };
  }

  private async execute(job: HoodClaimedJob, vault: LocalAccount): Promise<HoodJobResult> {
    const s = job.spec;
    const a = this.o.adapter;
    switch (s.kind) {
      case "buy": {
        const r = await a.buy(s.token, s.weiIn, s.minOut, { vault, onSigned: this.onSigned(job, vault.address) });
        return this.tradeResult(r);
      }
      case "sell": {
        const r = await a.sell(s.token, s.amount, s.minWei, { vault, onSigned: this.onSigned(job, vault.address) });
        return this.tradeResult(r);
      }
      case "create":
        return this.executeCreate(job, s, vault);
      case "withdraw": {
        const w = await this.o.withdrawer.withdrawToken({
          vault,
          token: s.token,
          to: s.to,
          amount: s.amount,
          ...(s.gasWei !== undefined ? { gasDropWei: s.gasWei } : {}),
          onSigned: this.onSigned(job, vault.address),
        });
        return {
          status: "executed",
          execution: { kind: "withdraw", hash: w.hash, block: w.blockNumber, vault: w.vault, token: w.asset as Address, to: w.to, amount: w.received, networkFee: w.networkFee + (w.drop?.networkFee ?? 0n) },
        };
      }
      case "fund_vaults": {
        const { sent, plan } = await fundVaults(this.o.executor, vault, this.o.vaults.map((v) => v.address), s.wei, this.onSigned(job, vault.address));
        return {
          status: "executed",
          execution: { kind: "fund_vaults", hash: sent.hash, block: sent.receipt.blockNumber, vault: getAddress(vault.address), wei: plan.total, networkFee: sent.networkFee },
        };
      }
      case "attest": {
        // The owner funds attestation keys (never a vault). Without gas the tx can't be paid: wait
        // ATTEST_NO_GAS_RETRY_MS instead of signing one that never lands and re-resolving it every
        // few seconds (hood 23-26.10: thousands of RPC calls per job). RPC error -> just try.
        const gas = await this.o.executor.read.getBalance({ address: vault.address }).catch(() => null);
        if (gas !== null && gas < ATTEST_MIN_GAS_WEI) return this.retry("pool_liquidity", "attestation key has no gas", ATTEST_NO_GAS_RETRY_MS);
        // Zero-value self-tx whose calldata is exactly the 32-byte root (EVM analogue of the SPL memo).
        const data = `0x${s.memo}` as Hex;
        const outSig = s.purpose === "verify" ? await vault.signMessage!({ message: { raw: data } }) : undefined;
        const sent = await this.o.executor.send(vault, { to: vault.address, data, value: 0n }, { onSigned: this.onSigned(job, vault.address, outSig) });
        const blockTime = await this.blockTime(sent.receipt.blockNumber);
        if (blockTime === null) return this.retry("venue_unavailable", "block time not readable yet", 5_000);
        return {
          status: "executed",
          execution: { kind: "attest", hash: sent.hash, block: sent.receipt.blockNumber, blockTime, vault: getAddress(vault.address), memo: s.memo, outSig: outSig ?? null, networkFee: sent.networkFee },
        };
      }
    }
  }

  private async executeCreate(job: HoodClaimedJob, s: Extract<HoodJobSpec, { kind: "create" }>, vault: LocalAccount): Promise<HoodJobResult> {
    let pl = await this.o.launches.get(job.id);
    if (!pl) {
      pl = { creatorIndex: await this.o.keyring.allocateCreator(), fromBlock: await this.o.executor.read.getBlockNumber({ cacheTime: 0 }) };
      await this.o.launches.put(job.id, pl); // durable BEFORE the funder touches the creator
    }
    const logo = s.meta.image && this.o.publishImage ? await this.o.publishImage(s.meta.image) : null;
    try {
      const r = await this.o.adapter.create(
        { name: s.meta.name, symbol: s.meta.symbol, ...(logo ? { logo } : {}) },
        s.weiIn,
        { creatorIndex: pl.creatorIndex, vault, minOut: s.minOut, onSigned: this.onSigned(job, vault.address) },
      );
      return this.createResult(r, s, logo);
    } catch (e) {
      if (!(e instanceof AdapterError) || !/creator address already launched/.test(e.message)) throw e;
      // The creator already sent its launch (recorded hash lost / dropped from our view): find it.
      const rec = await reconcileCreator({ adapter: this.o.adapter, executor: this.o.executor, keyring: this.o.keyring }, pl.creatorIndex, { fromBlock: pl.fromBlock });
      if (rec.status === "launched") {
        const receipt = await this.o.executor.read.getTransactionReceipt({ hash: rec.launchTx });
        const tx = await this.o.executor.read.getTransaction({ hash: rec.launchTx });
        await this.o.queue.reportSent(job, { hash: rec.launchTx, nonce: tx.nonce, vault: getAddress(vault.address), sentAt: this.o.now() });
        const r = await this.o.adapter.resultFromReceipt("create", receipt, { vault: vault.address, creatorIndex: pl.creatorIndex });
        return this.createResult(r, s, logo);
      }
      // Burned creator (reverted / abandoned): its ETH went back to the funder; next attempt uses a fresh one.
      await this.o.launches.delete(job.id);
      return this.retry("venue_unavailable", "creator reconciled, retrying with a fresh one", 5_000);
    }
  }

  // -------------------------------------------------------------------------
  // Recorded tx resolution
  // -------------------------------------------------------------------------

  /**
   * A recorded main tx is resolved BEFORE anything new is signed (review-hood-final #1, #5):
   * - every hash ever signed for the job is looked up on every provider;
   * - an RPC error (429, timeout...) is never "not sent": retry later;
   * - "unknown" on every provider -> wait `dropGraceMs` from the SEND time (SentClock,
   *   not updated_at), look again, and only then execute anew (nonce cache reset).
   */
  private async resolveSent(job: HoodClaimedJob): Promise<HoodJobResult | null> {
    const sent = job.sent!;
    const hashes = [...new Set([sent.hash, ...((await this.clock.hashes(job.id)) as Hex[])])];
    // RPC part only (errors -> retry); parsing a landed receipt happens outside (errors -> needs_review).
    type Seen = { landed: TransactionReceipt } | "pending" | "unknown";
    const look = async (): Promise<Seen> => {
      let pending = false;
      for (const h of hashes) {
        const st = await this.o.executor.lookup(h);
        if (st.state === "landed") return { landed: st.receipt };
        if (st.state === "pending") pending = true;
      }
      return pending ? "pending" : "unknown";
    };
    const settle = async (seen: Exclude<Seen, "unknown">): Promise<HoodJobResult> => {
      if (seen === "pending") return this.retry("venue_unavailable", "tx pending", 2_000);
      if (seen.landed.status !== "success") {
        const err = await this.o.executor.explainRevert(seen.landed);
        return { status: "failed", code: err.apiCode, message: err.message };
      }
      return this.fromReceipt(job, seen.landed);
    };
    let first: Seen;
    try {
      first = await look();
    } catch {
      return this.retry("venue_unavailable", "RPC error while resolving a recorded tx", 10_000 + randomInt(10_000));
    }
    if (first !== "unknown") return settle(first);
    let at = sent.sentAtReliable ? sent.sentAt : await this.clock.get(job.id, sent.hash);
    if (at === null) {
      // Recorded by an older build / another host: start the grace now.
      await this.clock.mark(job.id, sent.hash, this.o.now());
      at = this.o.now();
    }
    const signer = await this.signerAddressOf(job);
    let used: number;
    try {
      used = await this.o.executor.read.getTransactionCount({ address: signer, blockTag: "latest" });
    } catch {
      return this.retry("venue_unavailable", "RPC error while reading the nonce", 10_000);
    }
    const nonceTaken = used > sent.nonce;
    if (!nonceTaken && this.o.now() - at < this.o.dropGraceMs) return this.retry("venue_unavailable", "tx not visible yet", 5_000);
    // Second look, a moment later, every provider, every hash of the job: is the tx in that nonce ours?
    await this.o.sleep(2_000);
    let second: Seen;
    try {
      second = await look();
    } catch {
      return this.retry("venue_unavailable", "RPC error while resolving a recorded tx", 10_000 + randomInt(10_000));
    }
    if (second !== "unknown") return settle(second);
    // Proven not ours / never accepted: it can never land. Re-read the nonce from chain next send.
    this.o.executor.nonces.reset(signer);
    // create: executeCreate sees the used creator and reconciles it (finds the launch if it landed).
    return null;
  }

  private async signerAddressOf(job: HoodClaimedJob): Promise<Address> {
    if (job.spec.kind === "create") {
      const pl = await this.o.launches.get(job.id);
      if (pl) return getAddress(this.o.keyring.account("creator", pl.creatorIndex).address);
    }
    return job.sent!.vault;
  }

  private async fromReceipt(job: HoodClaimedJob, receipt: TransactionReceipt): Promise<HoodJobResult> {
    const s = job.spec;
    const vault = job.sent!.vault;
    switch (s.kind) {
      case "buy":
      case "sell":
        return this.tradeResult(await this.o.adapter.resultFromReceipt(s.kind, receipt, { vault, token: s.token }));
      case "create": {
        const pl = await this.o.launches.get(job.id);
        const r = await this.o.adapter.resultFromReceipt("create", receipt, { vault, ...(pl ? { creatorIndex: pl.creatorIndex } : {}) });
        return this.createResult(r, s, null);
      }
      case "withdraw": {
        const to = getAddress(s.to);
        const amount = parseEventLogs({ abi: ponsV2TokenAbi, logs: receipt.logs, eventName: "Transfer" })
          .filter((l) => getAddress(l.address) === s.token && getAddress(l.args.to) === to)
          .reduce((x, l) => x + l.args.value, 0n);
        if (amount === 0n) return this.review("landed withdraw: transfer not readable");
        return {
          status: "executed",
          execution: { kind: "withdraw", hash: receipt.transactionHash, block: receipt.blockNumber, vault, token: s.token, to, amount, networkFee: receipt.gasUsed * receipt.effectiveGasPrice },
        };
      }
      case "fund_vaults": {
        const tx = await this.o.executor.read.getTransaction({ hash: receipt.transactionHash });
        return {
          status: "executed",
          execution: { kind: "fund_vaults", hash: receipt.transactionHash, block: receipt.blockNumber, vault, wei: tx.value, networkFee: receipt.gasUsed * receipt.effectiveGasPrice },
        };
      }
      case "attest": {
        const tx = await this.o.executor.read.getTransaction({ hash: receipt.transactionHash });
        const memo = tx.input.slice(2).toLowerCase();
        const blockTime = await this.blockTime(receipt.blockNumber);
        if (blockTime === null) return this.retry("venue_unavailable", "block time not readable yet", 5_000);
        return {
          status: "executed",
          execution: { kind: "attest", hash: receipt.transactionHash, block: receipt.blockNumber, blockTime, vault, memo, outSig: null, networkFee: receipt.gasUsed * receipt.effectiveGasPrice },
        };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  private async tradeResult(r: EvmTxResult): Promise<HoodJobResult> {
    if (!r.amountsKnown) return this.review("landed tx: amounts not readable (re-read before crediting)");
    return {
      status: "executed",
      execution: {
        kind: r.kind === "sell" ? "sell" : "buy",
        hash: r.hash,
        block: r.blockNumber,
        blockTime: r.blockTime,
        vault: r.vault,
        token: r.token,
        tokenAmount: r.tokenAmount,
        quoteWei: r.quoteAmount,
        networkFee: r.networkFee + r.sideTxs.reduce((x, t) => x + t.networkFee, 0n),
        symbol: await this.symbol(r.token),
        market: await this.market(r),
      },
    };
  }

  private async createResult(r: EvmTxResult, s: Extract<HoodJobSpec, { kind: "create" }>, logo: string | null): Promise<HoodJobResult> {
    const share = await this.o.executor.read
      .readContract({ address: r.curve, abi: ponsV2CurveAbi, functionName: "protocolFeeShareBps" })
      .catch(() => null);
    // Creator fee generated by the launch tx itself (stays with the pool, RELAYER v6 §1).
    const creatorFee = share === null ? null : r.venueFee - (r.venueFee * BigInt(share)) / 10_000n + r.creatorTax;
    return {
      status: "executed",
      execution: {
        kind: "create",
        hash: r.hash,
        block: r.blockNumber,
        blockTime: r.blockTime,
        vault: r.vault,
        token: r.token,
        tokenAmount: r.tokenAmount,
        quoteWei: r.quoteAmount,
        networkFee: r.networkFee + r.sideTxs.reduce((x, t) => x + t.networkFee, 0n),
        creator: r.creator!,
        name: s.meta.name,
        symbol: s.meta.symbol,
        imageUrl: logo,
        creatorFee,
        market: await this.market(r),
      },
    };
  }

  /** Public market snapshot after the trade (curve route only; v4 / LI.FI: price left to the indexer). */
  private async market(r: EvmTxResult): Promise<HoodMarket | null> {
    if (r.route !== "curve") return null;
    try {
      const info = await this.o.adapter.launchInfo(r.token);
      // Never "0": graduated prices come from the v4 price loop (pool-state.writeTokenPrices).
      if (info.phase !== PHASE.NotGraduated) return null;
      const { state } = await this.o.adapter.curveState(r.curve, r.blockNumber);
      const sp = spot(state);
      return { priceEth: sp.price, marketCapEth: sp.marketCap, status: state.graduated || readyToGraduate(state) ? "graduated" : "curve" };
    } catch {
      return null;
    }
  }

  private async symbol(token: Address): Promise<string | null> {
    return this.o.executor.read.readContract({ address: token, abi: ponsV2TokenAbi, functionName: "symbol" }).catch(() => null);
  }

  private async blockTime(n: bigint): Promise<number | null> {
    try {
      return Number((await this.o.executor.read.getBlock({ blockNumber: n })).timestamp);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Restart reconcile of pending launches
  // -------------------------------------------------------------------------

  /**
   * For every stored launch whose job is no longer in flight: confirmed -> drop
   * the entry; failed / gone -> reconcile the creator (refund to the funder if it
   * never launched). In-flight jobs are left to `tick`. Returns counts only.
   */
  private async reconcileOne(id: string): Promise<void> {
    const pl = await this.o.launches.get(id);
    if (!pl) return;
    await reconcileCreator({ adapter: this.o.adapter, executor: this.o.executor, keyring: this.o.keyring }, pl.creatorIndex, { fromBlock: pl.fromBlock, abandon: true });
    await this.o.launches.delete(id);
  }

  async reconcileLaunches(): Promise<{ kept: number; dropped: number; refunded: number; orphanLaunches: number }> {
    const out = { kept: 0, dropped: 0, refunded: 0, orphanLaunches: 0 };
    for (const [id, pl] of await this.o.launches.all()) {
      const st = await this.o.queue.status(id);
      if (st && !st.settled && st.status !== "confirmed" && st.status !== "failed") {
        out.kept++;
        continue;
      }
      if (st?.status === "confirmed") {
        await this.o.launches.delete(id);
        out.dropped++;
        continue;
      }
      const rec = await reconcileCreator({ adapter: this.o.adapter, executor: this.o.executor, keyring: this.o.keyring }, pl.creatorIndex, {
        fromBlock: pl.fromBlock,
        abandon: true,
      });
      if (rec.status === "refunded") out.refunded++;
      if (rec.status === "launched") out.orphanLaunches++; // pool holds the tokens; operator alert (counts only)
      await this.o.launches.delete(id);
      out.dropped++;
    }
    return out;
  }
}
