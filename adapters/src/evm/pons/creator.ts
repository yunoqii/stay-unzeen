import { encodeFunctionData, getAddress, type Address, type Hex, type LocalAccount } from "viem";
import { AdapterError } from "../../errors";
import type { EvmExecutor } from "../executor";
import { quantizeGasLimit } from "../fees";
import type { EvmKeyring } from "../keys";
import { ponsV2CurveAbi } from "./abi/curve";
import { ponsV2LaunchFactoryAbi } from "./abi/factory.generated";
import { ponsV2FeeEscrowAbi } from "./abi/fee-escrow.generated";
import { ponsV2MemeHookAbi } from "./abi/meme-hook.generated";
import { PHASE, type PonsAdapter } from "./adapter";
import { NATIVE_QUOTE } from "./addresses";
import { poolIdOf } from "./v4";

/**
 * Creator-fee collection of the pool's Pons launches (parity with
 * src/creator-fees.ts + relayer/fee-sweeper.ts on Solana) and reconciliation of
 * creator addresses whose launch never happened.
 *
 * Invariant (H7): one target = one fresh creator address of ONE launch; every
 * transaction is signed by that creator alone. Sweeps run on a global schedule
 * in random order with jitter, never on a user's request (claim stays a ledger
 * operation), so collection time links nothing to anyone.
 *
 * Fee path on Pons V2 (verified sources):
 *   curve (pre-graduation): `sweepFees(0)` by the creator (= curve.deployer)
 *     credits the creator share (fee minus protocol share, plus creator tax) to
 *     PonsV2FeeEscrow; allowed without the Pons operator because Unzeen launches
 *     have buyback disabled;
 *   hook (graduated): `sweepPoolFees(poolId, 0, 0)` only when nothing must be
 *     converted (memecoin-denominated fees need the Pons sweep operator, who
 *     sweeps them on its own schedule into the same escrow);
 *   escrow: `claim()` pays the creator; the creator then moves the ETH to a pool
 *     vault, keeping `keepWei` for its next claims' gas.
 */

export interface PonsLaunchRef {
  creatorIndex: number;
  token: Address;
}

export interface PonsFeeTarget extends PonsLaunchRef {
  creator: Address;
  phase: number;
  /** Creator share pending on the curve (wei). */
  curvePending: bigint;
  /** Creator share pending in the v4 hook in ETH (wei); memecoin side not sweepable by us. */
  poolPendingEth: bigint;
  /** Memecoin-denominated fees pending in the hook (operator-only conversion). */
  poolPendingToken: bigint;
  /** Already credited to the creator in the escrow (wei). */
  escrow: bigint;
  /** ETH on the creator address (wei). */
  balance: bigint;
}

export interface SweepStep {
  kind: "curve_sweep" | "pool_sweep" | "claim" | "to_vault";
  hash: Hex;
  networkFee: bigint;
  value?: bigint;
}

export interface SweepOutcome {
  target: PonsFeeTarget;
  steps: SweepStep[];
  /** ETH that reached the pool vault. */
  collected: bigint;
  vault: Address | null;
  skipped?: "below_threshold" | "no_gas";
}

export interface PonsFeeSweeperOptions {
  adapter: PonsAdapter;
  executor: EvmExecutor;
  keyring: EvmKeyring;
  /** Vault that receives a target's ETH (rotate between calls). */
  pickVault: () => LocalAccount;
  /** Sweep only when the creator would collect at least this much (wei). Default 0.0005 ETH. */
  minCollectWei?: bigint;
  /** ETH left on the creator for future claims. Default 0.0005 ETH. */
  keepWei?: bigint;
  /** Transfers to the vault are rounded down to this step (round amounts). Default 0.0001 ETH. */
  transferStepWei?: bigint;
  /** Random pause between targets in runOnce, ms [min, max]. Default [5 s, 60 s]. */
  jitterMs?: [number, number];
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class PonsFeeSweeper {
  private readonly o: Required<Omit<PonsFeeSweeperOptions, "sleep" | "random" | "jitterMs">> & {
    sleep: (ms: number) => Promise<void>;
    random: () => number;
    jitterMs: [number, number];
  };

  constructor(o: PonsFeeSweeperOptions) {
    this.o = {
      ...o,
      minCollectWei: o.minCollectWei ?? 500_000_000_000_000n,
      keepWei: o.keepWei ?? 500_000_000_000_000n,
      transferStepWei: o.transferStepWei ?? 100_000_000_000_000n,
      jitterMs: o.jitterMs ?? [5_000, 60_000],
      sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: o.random ?? Math.random,
    };
  }

  private get read() {
    return this.o.executor.read;
  }

  async inspect(ref: PonsLaunchRef): Promise<PonsFeeTarget> {
    const a = this.o.adapter;
    const creator = this.o.keyring.account("creator", ref.creatorIndex).address;
    const info = await a.launchInfo(ref.token);
    if (getAddress(info.creatorFeeRecipient) !== getAddress(creator)) {
      // Fee recipient moved (Pons owner override): nothing of ours to collect.
      throw new AdapterError("not_found", "creator is no longer the fee recipient of this launch");
    }
    const [escrow, balance] = await Promise.all([
      this.read.readContract({ address: a.deployment.feeEscrow, abi: ponsV2FeeEscrowAbi, functionName: "balanceOf", args: [creator] }),
      this.o.executor.balance(creator),
    ]);
    let curvePending = 0n;
    let poolPendingEth = 0n;
    let poolPendingToken = 0n;
    if (info.phase === PHASE.NotGraduated) {
      const [fee, tax, share] = await Promise.all([
        this.read.readContract({ address: info.curve, abi: ponsV2CurveAbi, functionName: "quoteFeeBalance" }),
        this.read.readContract({ address: info.curve, abi: ponsV2CurveAbi, functionName: "creatorTaxBalance" }),
        this.read.readContract({ address: info.curve, abi: ponsV2CurveAbi, functionName: "protocolFeeShareBps" }),
      ]);
      curvePending = fee - (fee * BigInt(share)) / 10_000n + tax;
    } else if (info.phase === PHASE.PoolCreated) {
      const id = poolIdOf(a.poolKey(info));
      const hook = a.deployment.memeHook;
      const r = (fn: "pendingFees" | "pendingCreatorTax", cur: Address) =>
        this.read.readContract({ address: hook, abi: ponsV2MemeHookAbi, functionName: fn, args: [id, cur] }) as Promise<bigint>;
      const [fEth, tEth, fTok, tTok, launch] = await Promise.all([
        r("pendingFees", NATIVE_QUOTE),
        r("pendingCreatorTax", NATIVE_QUOTE),
        r("pendingFees", info.token),
        r("pendingCreatorTax", info.token),
        this.read.readContract({ address: hook, abi: ponsV2MemeHookAbi, functionName: "launches", args: [id] }) as Promise<readonly unknown[]>,
      ]);
      const protocolShareBps = BigInt(launch[8] as number);
      poolPendingEth = fEth - (fEth * protocolShareBps) / 10_000n + tEth;
      poolPendingToken = fTok + tTok;
    }
    return { ...ref, token: info.token, creator: getAddress(creator), phase: info.phase, curvePending, poolPendingEth, poolPendingToken, escrow, balance };
  }

  /** Discovers the targets worth sweeping now (threshold on what would reach the vault). */
  async plan(refs: readonly PonsLaunchRef[]): Promise<PonsFeeTarget[]> {
    const out: PonsFeeTarget[] = [];
    for (const r of refs) {
      const t = await this.inspect(r).catch(() => null);
      if (t && this.collectable(t) >= this.o.minCollectWei) out.push(t);
    }
    return out;
  }

  collectable(t: PonsFeeTarget): bigint {
    // Pool ETH is only sweepable by us when no memecoin conversion is pending.
    const pool = t.poolPendingToken === 0n ? t.poolPendingEth : 0n;
    const spare = t.balance > this.o.keepWei ? t.balance - this.o.keepWei : 0n;
    return t.curvePending + pool + t.escrow + spare;
  }

  /** One target: sweep -> claim -> move to a vault. Every tx signed by the creator only. */
  async sweepOne(t0: PonsFeeTarget): Promise<SweepOutcome> {
    const ex = this.o.executor;
    const a = this.o.adapter;
    const creator = this.o.keyring.account("creator", t0.creatorIndex);
    const steps: SweepStep[] = [];
    if (this.collectable(t0) < this.o.minCollectWei) return { target: t0, steps, collected: 0n, vault: null, skipped: "below_threshold" };
    const minGas = quantizeGasLimit(200_000n) * ex.fees.maxFeePerGas;
    if (t0.balance < minGas) return { target: t0, steps, collected: 0n, vault: null, skipped: "no_gas" };

    const info = await a.launchInfo(t0.token);
    if (info.phase === PHASE.NotGraduated && t0.curvePending > 0n) {
      const s = await ex.send(creator, { to: info.curve, data: encodeFunctionData({ abi: ponsV2CurveAbi, functionName: "sweepFees", args: [0n] }) });
      steps.push({ kind: "curve_sweep", hash: s.hash, networkFee: s.networkFee });
    } else if (info.phase === PHASE.PoolCreated && t0.poolPendingEth > 0n && t0.poolPendingToken === 0n) {
      const id = poolIdOf(a.poolKey(info));
      const s = await ex.send(creator, {
        to: a.deployment.memeHook,
        data: encodeFunctionData({ abi: ponsV2MemeHookAbi, functionName: "sweepPoolFees", args: [id, 0n, 0n] }),
      });
      steps.push({ kind: "pool_sweep", hash: s.hash, networkFee: s.networkFee });
    }
    const escrow = await this.read.readContract({ address: a.deployment.feeEscrow, abi: ponsV2FeeEscrowAbi, functionName: "balanceOf", args: [creator.address] });
    if (escrow > 0n) {
      const s = await ex.send(creator, { to: a.deployment.feeEscrow, data: encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claim", args: [] }) });
      steps.push({ kind: "claim", hash: s.hash, networkFee: s.networkFee, value: escrow });
    }
    const bal = await ex.balance(creator.address);
    const gasCost = quantizeGasLimit(21_000n) * ex.fees.maxFeePerGas;
    const spare = bal > this.o.keepWei + gasCost ? bal - this.o.keepWei - gasCost : 0n;
    const value = (spare / this.o.transferStepWei) * this.o.transferStepWei;
    let vault: LocalAccount | null = null;
    if (value > 0n) {
      vault = this.o.pickVault();
      const s = await ex.transfer(creator, vault.address, value);
      steps.push({ kind: "to_vault", hash: s.hash, networkFee: s.networkFee, value });
    }
    return { target: t0, steps, collected: value, vault: vault ? getAddress(vault.address) : null };
  }

  /** One global pass: plan, shuffle, sweep each with a random pause. Errors of one target never stop the pass. */
  async runOnce(refs: readonly PonsLaunchRef[], signal?: AbortSignal): Promise<{ outcomes: SweepOutcome[]; failed: number }> {
    const targets = await this.plan(refs);
    for (let i = targets.length - 1; i > 0; i--) {
      const j = Math.floor(this.o.random() * (i + 1));
      [targets[i], targets[j]] = [targets[j]!, targets[i]!];
    }
    const outcomes: SweepOutcome[] = [];
    let failed = 0;
    for (const [i, t] of targets.entries()) {
      if (signal?.aborted) break;
      if (i > 0) {
        const [lo, hi] = this.o.jitterMs;
        await this.o.sleep(lo + Math.floor(this.o.random() * Math.max(0, hi - lo)));
      }
      try {
        outcomes.push(await this.sweepOne(t));
      } catch {
        failed++;
      }
    }
    return { outcomes, failed };
  }
}

// ---------------------------------------------------------------------------
// Reconciliation of a creator whose launch never happened
// ---------------------------------------------------------------------------

export type ReconcileResult =
  | { status: "launched"; creator: Address; token: Address; curve: Address; launchTx: Hex }
  | { status: "unused"; creator: Address; balance: bigint } // never sent a tx: retry the launch with the same index
  | { status: "refunded"; creator: Address; hash: Hex; value: bigint }
  | { status: "empty"; creator: Address; balance: bigint }; // nothing (worth) returning

/**
 * Finds out what happened to creator `index`: launched (TokenLaunched with
 * deployer = creator since `fromBlock`), unused (nonce 0, the launch can be
 * retried with the same index), or stuck (nonce > 0 without a launch: a
 * reverted / dropped attempt, or `abandon`ed) -> its ETH goes back to the FUNDER,
 * never to a vault. Logs are scanned in chunks (public RPCs cap the range).
 */
export async function reconcileCreator(
  o: { adapter: PonsAdapter; executor: EvmExecutor; keyring: EvmKeyring },
  index: number,
  opts: { fromBlock: bigint; toBlock?: bigint; chunk?: bigint; abandon?: boolean },
): Promise<ReconcileResult> {
  const ex = o.executor;
  const creator = o.keyring.account("creator", index);
  const addr = getAddress(creator.address);
  const head = opts.toBlock ?? (await ex.read.getBlockNumber({ cacheTime: 0 }));
  const chunk = opts.chunk ?? 2_000n;
  for (let from = opts.fromBlock; from <= head; from += chunk) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n;
    const logs = await ex.read.getContractEvents({
      address: o.adapter.deployment.factory,
      abi: ponsV2LaunchFactoryAbi,
      eventName: "TokenLaunched",
      args: { deployer: addr },
      fromBlock: from,
      toBlock: to,
    });
    const hit = logs[0];
    if (hit) {
      const args = hit.args as { token: Address; curve: Address };
      return { status: "launched", creator: addr, token: getAddress(args.token), curve: getAddress(args.curve), launchTx: hit.transactionHash };
    }
  }
  const [nonce, balance] = await Promise.all([ex.read.getTransactionCount({ address: addr, blockTag: "latest" }), ex.balance(addr)]);
  if (nonce === 0 && !opts.abandon) return { status: "unused", creator: addr, balance };
  const gasCost = quantizeGasLimit(21_000n) * ex.fees.maxFeePerGas;
  if (balance <= gasCost) return { status: "empty", creator: addr, balance };
  const value = balance - gasCost;
  const s = await ex.transfer(creator, o.keyring.funder().address, value);
  return { status: "refunded", creator: addr, hash: s.hash, value };
}
