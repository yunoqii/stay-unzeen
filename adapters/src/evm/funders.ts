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
 *   order with random pauses (`topUp`); never from a vault, never funder -> funder
 *   (no chain linking them), never right before a specific launch (the pick only
 *   uses balances already there);
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
  /** Keep each funder at about this balance (wei). Default 0.05 ETH. */
  targetWei?: bigint;
  /** Top up below this (wei). Default 0.02 ETH. */
  lowWei?: bigint;
  /** Top-up granularity (round lots). Default 0.01 ETH. */
  lotWei?: bigint;
  sleep?: (ms: number) => Promise<void>;
}

export class FunderPool {
  readonly count: number;
  private last = -1;
  private readonly o: Required<Omit<FunderPoolOptions, "sleep">> & { sleep: (ms: number) => Promise<void> };

  constructor(o: FunderPoolOptions) {
    this.o = {
      count: 8,
      targetWei: 50_000_000_000_000_000n,
      lowWei: 20_000_000_000_000_000n,
      lotWei: 10_000_000_000_000_000n,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...o,
    };
    if (!Number.isInteger(this.o.count) || this.o.count < 1 || this.o.count > 256) throw new RangeError("funder count must be 1..256");
    this.count = this.o.count;
  }

  accounts(): LocalAccount[] {
    return Array.from({ length: this.count }, (_, i) => this.o.keyring.funder(i));
  }

  /** A random funder (not the previous one) that can send `value` + gas. */
  async pick(value: bigint): Promise<LocalAccount> {
    const gas = quantizeGasLimit(21_000n) * this.o.executor.fees.maxFeePerGas;
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
   * pause between transfers. Stops at the first failure (counts only returned).
   */
  async topUp(pauseMs: [number, number] = [30_000, 300_000]): Promise<{ sent: number; totalWei: bigint }> {
    const plan = await this.plan();
    for (let i = plan.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [plan[i], plan[j]] = [plan[j]!, plan[i]!];
    }
    const src = this.o.keyring.rebalance(0);
    let sent = 0;
    let totalWei = 0n;
    for (const [k, p] of plan.entries()) {
      if (k > 0) await this.o.sleep(pauseMs[0] + randomInt(Math.max(1, pauseMs[1] - pauseMs[0])));
      await this.o.executor.transfer(src, this.o.keyring.funder(p.index).address, p.value);
      sent++;
      totalWei += p.value;
    }
    return { sent, totalWei };
  }
}
