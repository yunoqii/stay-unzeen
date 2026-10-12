import BN from "bn.js";

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const BPS_DENOM = 10_000n;

export function toBN(x: bigint): BN {
  if (x < 0n) throw new RangeError("negative amount");
  return new BN(x.toString(10), 10);
}

export function toBig(x: BN): bigint {
  return BigInt(x.toString(10));
}

/** Rounds down: the minimum acceptable output for `bps` of slippage. */
export function minOutWithSlippage(expected: bigint, slippageBps: number): bigint {
  assertBps(slippageBps);
  return (expected * (BPS_DENOM - BigInt(slippageBps))) / BPS_DENOM;
}

/** Rounds up: the maximum acceptable input for `bps` of slippage. */
export function maxInWithSlippage(expected: bigint, slippageBps: number): bigint {
  assertBps(slippageBps);
  const num = expected * (BPS_DENOM + BigInt(slippageBps));
  return (num + BPS_DENOM - 1n) / BPS_DENOM;
}

function assertBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new RangeError(`slippage bps must be an integer in 0..10000, got ${bps}`);
  }
}

/**
 * Exact decimal string of `value / 10^decimals`, trailing zeros trimmed.
 * `formatUnits(1_500_000_000n, 9) === "1.5"`.
 */
export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let s = whole.toString(10);
  if (decimals > 0 && frac > 0n) {
    s += "." + frac.toString(10).padStart(decimals, "0").replace(/0+$/, "");
  }
  return neg ? "-" + s : s;
}

/** Parses a decimal string into base units. Rejects excess precision. */
export function parseUnits(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m || m[1] === undefined) throw new RangeError(`not a decimal: ${value}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new RangeError(`too many decimals in ${value} (max ${decimals})`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/**
 * Spot price of a constant-product curve, SOL per 1 whole token, as a decimal
 * string with `precision` fractional digits (18 keeps ~10 significant digits for pump prices ~1e-8) (rounded down).
 * price = (vQuote / 1e9) / (vToken / 10^decimals)
 */
export function spotPriceSol(
  virtualQuoteReserves: bigint,
  virtualTokenReserves: bigint,
  tokenDecimals: number,
  precision = 18,
): string {
  if (virtualTokenReserves === 0n) return "0";
  const scale = 10n ** BigInt(precision);
  const num = virtualQuoteReserves * 10n ** BigInt(tokenDecimals) * scale;
  const den = virtualTokenReserves * LAMPORTS_PER_SOL;
  return formatUnits(num / den, precision);
}
