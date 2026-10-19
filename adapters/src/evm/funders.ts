import { randomInt } from "node:crypto";
import type { LocalAccount } from "viem";
import { AdapterError } from "../errors";
import type { EvmExecutor } from "./executor";
import { ceilToStep, quantizeGasLimit } from "./fees";
import type { EvmKeyring } from "./keys";

/**
 * Rotating funders (HD branch 4, indexes 0..N-1) for creator top-ups on
 * Robinhood Chain (review-numeric-hood §4: one funder = a public list of every
 * creator).
 *
 * Money path, all pool addresses, no user data:
 *   NEAR 1Click -> rebalance (branch 3) --round lots--> funder_i --round sum--> creator
 * Rules:
 * - each create takes ONE funder at random among those that can cover it, never
 *   the one used just before -> a funder's history shows ~1/N of the creators;
 * - funders are topped up ONLY by the rebalance address, in round lots, in random
 *   order with random pauses: at start, every 1–3 h (`topUp`) and when ETH arrives
 *   on the rebalance address (`topUpOnArrival`, GAP-8); never from a vault, never
 *   funder -> funder (no chain linking them). A create never triggers a top-up
 *   for itself: the pick only uses balances already there;
 * - creator leftovers return to the rebalance address (reconcile / fee sweep
 *   keeps them on the creator for gas), not to "the" funder.
 * On Solana there is no funder at all: the vault is the fee payer of the create
 * tx and the creator only co-signs (it never holds SOL). EVM has no separate
 * fee payer for an EOA, so the creator must hold ETH; this is the closest equivalent.
 */
export interface FunderPoolOptions {
  executor: EvmExecutor;
  keyring: EvmKeyring;
  /** Number of funders (indexes 0..count-1). Default 8. */
  count?: number;
  /** Keep each funder at about this balance (wei). Default 0.02 ETH (HOOD_FUNDER_TARGET_WEI). */
  targetWei?: bigint;
  /** Top up below this (wei). Default 0.011 ETH = one launch + gas (HOOD_FUNDER_LOW_WEI). */
  lowWei?: bigint;
  /** Top-up granularity (round lots). Default 0.005 ETH (HOOD_FUNDER_LOT_WEI). */
  lotWei?: bigint;
  sleep?: (ms: number) => Promise<void>;
}

/** GAP-7 defaults: small for the demo (one creator top-up of `ceil 0.01 ETH` + gas per launch). */
export const FUNDER_DEFAULTS = {
  targetWei: 20_000_000_000_000_000n, // 0.02 ETH
  lowWei: 11_000_000_000_000_000n, // 0.011 ETH
  lotWei: 5_000_000_000_000_000n, // 0.005 ETH
} as const;

/** Default poll of the rebalance address for new ETH (GAP-8), seconds. */
export const FUNDER_POLL_DEFAULT_SECS = 300;

/** Positive integer wei from env; unset / empty -> `dflt`; anything else -> start-up error. */
export function weiEnv(env: NodeJS.ProcessEnv, name: string, dflt: bigint): bigint {
  const raw = env[name]?.trim();
  if (!raw) return dflt;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer in wei`);
  const v = BigInt(raw);
  if (v <= 0n) throw new Error(`${name} must be > 0`);
  return v;
}

/**
 * Funder thresholds from env (GAP-7): HOOD_FUNDER_TARGET_WEI, HOOD_FUNDER_LOW_WEI,
 * HOOD_FUNDER_LOT_WEI (integers, wei). Requires 0 < low < target and lot <= target.
 */
export function funderOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): { targetWei: bigint; lowWei: bigint; lotWei: bigint } {
  const targetWei = weiEnv(env, "HOOD_FUNDER_TARGET_WEI", FUNDER_DEFAULTS.targetWei);
  const lowWei = weiEnv(env, "HOOD_FUNDER_LOW_WEI", FUNDER_DEFAULTS.lowWei);
  const lotWei = weiEnv(env, "HOOD_FUNDER_LOT_WEI", FUNDER_DEFAULTS.lotWei);
  if (lowWei >= targetWei) throw new Error("HOOD_FUNDER_LOW_WEI must be below HOOD_FUNDER_TARGET_WEI");
  if (lotWei > targetWei) throw new Error("HOOD_FUNDER_LOT_WEI must not exceed HOOD_FUNDER_TARGET_WEI");
  return { targetWei, lowWei, lotWei };
}

/** GAP-8 poll interval of the rebalance address (HOOD_FUNDER_POLL_SECS, 30..3600, default 300), ms. */
export function funderPollMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HOOD_FUNDER_POLL_SECS?.trim();
  const secs = raw ? Number(raw) : FUNDER_POLL_DEFAULT_SECS;
  if (!Number.isInteger(secs) || secs < 30 || secs > 3600) throw new Error("HOOD_FUNDER_POLL_SECS must be an integer 30..3600");
  return secs * 1000;
}

export class FunderPool {
  readonly count: number;
  private last = -1;
  /** Rebalance balance seen by the last `topUpOnArrival` (null = not read yet). */
  private seenRebalance: bigint | null = null;
  /** Serializes top-ups (start, 1–3 h cycle and arrival poll never overlap: one nonce stream). */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly o: Required<Omit<FunderPoolOptions, "sleep">> & { sleep: (ms: number) => Promise<void> };

  constructor(o: FunderPoolOptions) {
    this.o = {
      count: 8,
      ...FUNDER_DEFAULTS,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...o,
    };
    if (!Number.isInteger(this.o.count) || this.o.count < 1 || this.o.count > 256) throw new RangeError("funder count must be 1..256");
    if (this.o.lowWei >= this.o.targetWei) throw new RangeError("funder lowWei must be below targetWei");
    if (this.o.lotWei <= 0n || this.o.lotWei > this.o.targetWei) throw new RangeError("funder lotWei must be 1..targetWei");
    this.count = this.o.count;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Gas of one plain transfer at the current fee cap. */
  private transferGas(): bigint {
    return quantizeGasLimit(21_000n) * this.o.executor.fees.maxFeePerGas;
  }

  accounts(): LocalAccount[] {
    return Array.from({ length: this.count }, (_, i) => this.o.keyring.funder(i));
  }

  /** A random funder (not the previous one) that can send `value` + gas. */
  async pick(value: bigint): Promise<LocalAccount> {
    const gas = this.transferGas();
    const accs = this.accounts();
    const bal = await Promise.all(accs.map((a) => this.o.executor.balance(a.address)));
    let ok = accs.map((_, i) => i).filter((i) => bal[i]! >= value + gas);
    if (ok.length > 1) ok = ok.filter((i) => i !== this.last);
    if (ok.length === 0) throw new AdapterError("insufficient_sol", "no funder can cover this launch; top up funders from the rebalance address");
    const i = ok[randomInt(ok.length)]!;
    this.last = i;
    return accs[i]!;
  }

  /** Which funders are below `lowWei` and how much (round lots) brings them to ~target. */
  async plan(): Promise<{ index: number; value: bigint }[]> {
    const accs = this.accounts();
    const bal = await Promise.all(accs.map((a) => this.o.executor.balance(a.address)));
    const out: { index: number; value: bigint }[] = [];
    bal.forEach((b, index) => {
      if (b < this.o.lowWei) out.push({ index, value: ceilToStep(this.o.targetWei - b, this.o.lotWei) });
    });
    return out;
  }

  /**
   * Tops up low funders FROM THE REBALANCE ADDRESS only, random order, random
   * pause between transfers. Only what the rebalance address can pay (value + gas
   * each) is sent; the rest waits for the next ETH. Stops at the first failure
   * (counts only returned). Serialized with every other top-up.
   */
  topUp(pauseMs: [number, number] = [30_000, 300_000]): Promise<{ sent: number; totalWei: bigint }> {
    return this.serial(() => this.topUpNow(pauseMs));
  }

  /**
   * GAP-8: called every few minutes. Reads the rebalance address; when its balance
   * GREW since the previous read (1Click delivered ETH, a creator leftover came
   * back), tops up low funders right away instead of waiting for the 1–3 h cycle.
   * The first call only records the balance (the start-up top-up already ran).
   * Timing: the trigger is any inflow to the rebalance address. That includes a
   * creator leftover returned by launch reconcile, so a top-up CAN follow a
   * launch by a few minutes (poll + random pauses); it is still a round lot from
   * the rebalance address to a random low funder, never sized or timed for a
   * specific creator, and the next create picks among existing balances.
   */
  topUpOnArrival(pauseMs: [number, number] = [30_000, 300_000]): Promise<{ arrived: boolean; sent: number; totalWei: bigint }> {
    return this.serial(async () => {
      const bal = await this.o.executor.balance(this.o.keyring.rebalance(0).address);
      const prev = this.seenRebalance;
      this.seenRebalance = bal;
      if (prev === null || bal <= prev) return { arrived: false, sent: 0, totalWei: 0n };
      const r = await this.topUpNow(pauseMs);
      return { arrived: true, ...r };
    });
  }

  private async topUpNow(pauseMs: [number, number]): Promise<{ sent: number; totalWei: bigint }> {
    const plan = await this.plan();
    for (let i = plan.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [plan[i], plan[j]] = [plan[j]!, plan[i]!];
    }
    const src = this.o.keyring.rebalance(0);
    let sent = 0;
    let totalWei = 0n;
    if (plan.length === 0) {
      this.seenRebalance = await this.o.executor.balance(src.address).catch(() => this.seenRebalance);
      return { sent, totalWei };
    }
    const gas = this.transferGas();
    let budget = await this.o.executor.balance(src.address);
    for (const p of plan) {
      if (budget < p.value + gas) continue; // not enough on the rebalance address yet
      if (sent > 0) await this.o.sleep(pauseMs[0] + randomInt(Math.max(1, pauseMs[1] - pauseMs[0])));
      await this.o.executor.transfer(src, this.o.keyring.funder(p.index).address, p.value);
      budget -= p.value + gas;
      sent++;
      totalWei += p.value;
    }
    // Our own outflow is not an "arrival": re-read after sending.
    this.seenRebalance = await this.o.executor.balance(src.address).catch(() => this.seenRebalance);
    return { sent, totalWei };
  }
}
