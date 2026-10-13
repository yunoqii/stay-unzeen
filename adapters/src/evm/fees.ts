/**
 * ONE fee profile for every pool transaction on Robinhood Chain
 * (docs/analysis/robinhood-chain.md §4, analogue of the quantized Solana priority fee):
 *
 * - type-2 (EIP-1559), `maxPriorityFeePerGas = 0`: on Arbitrum tips buy nothing
 *   (FCFS sequencer), so every tx pays exactly the base fee;
 * - `maxFeePerGas` is a pool-wide CONSTANT taken from a background cache,
 *   never computed per transaction: Now / Delayed / any job look the same on chain;
 * - `gasLimit` = estimate x 1.2 rounded UP to a 100k bucket.
 */

export const GAS_BUCKET = 100_000n;
/** Raise the constant once base fee x HEADROOM would not fit under it. */
export const FEE_HEADROOM = 4n;
/** Step the constant moves by (0.1 gwei), so all values are round. */
export const FEE_STEP_WEI = 100_000_000n;
/** Downward revisions at most once a day (the value must be boringly stable). */
export const FEE_LOWER_INTERVAL_MS = 24 * 3600 * 1000;

export function quantizeGasLimit(estimate: bigint): bigint {
  if (estimate <= 0n) throw new RangeError("gas estimate must be > 0");
  const padded = (estimate * 12n + 9n) / 10n; // x1.2, ceil
  return ((padded + GAS_BUCKET - 1n) / GAS_BUCKET) * GAS_BUCKET;
}

export function ceilToStep(v: bigint, step: bigint = FEE_STEP_WEI): bigint {
  return ((v + step - 1n) / step) * step;
}

export interface FeeProfile {
  type: "eip1559";
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: 0n;
}

/**
 * Background cache of the pool-wide `maxFeePerGas`.
 *
 * The value only rises when `baseFee x FEE_HEADROOM` exceeds it (else txs could
 * be rejected), and only falls back towards the configured floor once a day.
 * `refresh()` is called by a timer (`start`) or by the executor after a
 * "max fee per gas less than block base fee" rejection.
 */
export class EvmFeeCache {
  private value: bigint;
  private lastChange: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly floorWei: bigint,
    private readonly readBaseFee: () => Promise<bigint>,
    private readonly now: () => number = Date.now,
  ) {
    if (floorWei <= 0n) throw new RangeError("fee floor must be > 0");
    this.value = ceilToStep(floorWei);
    this.lastChange = this.now();
  }

  profile(): FeeProfile {
    return { type: "eip1559", maxFeePerGas: this.value, maxPriorityFeePerGas: 0n };
  }

  get maxFeePerGas(): bigint {
    return this.value;
  }

  async refresh(): Promise<bigint> {
    const base = await this.readBaseFee();
    const need = ceilToStep(base * FEE_HEADROOM);
    const floor = ceilToStep(this.floorWei);
    if (need > this.value) {
      this.value = need;
      this.lastChange = this.now();
    } else if (this.value > floor && this.now() - this.lastChange >= FEE_LOWER_INTERVAL_MS) {
      const lowered = need > floor ? need : floor;
      if (lowered < this.value) {
        this.value = lowered;
        this.lastChange = this.now();
      }
    }
    return this.value;
  }

  /** Background refresh (default every 10 min); errors keep the last value. */
  start(intervalMs = 10 * 60 * 1000, onError: (e: unknown) => void = () => undefined): void {
    if (this.timer) return;
    const tick = () => void this.refresh().catch(onError);
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
