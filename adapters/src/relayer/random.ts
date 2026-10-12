import { randomInt } from "node:crypto";

/**
 * Randomness for timing, vault choice and gas drops. Production uses the
 * CSPRNG: predictable delays would let an observer line up deposits, actions
 * and on-chain trades. Tests inject a seeded generator.
 */
export interface Rng {
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
}

export const cryptoRng: Rng = {
  int(min, max) {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError(`bad range [${min}, ${max}]`);
    }
    return min === max ? min : randomInt(min, max + 1);
  },
};

/** Deterministic generator (mulberry32) for tests only. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int(min, max) {
      if (max < min) throw new RangeError(`bad range [${min}, ${max}]`);
      return min + Math.floor(next() * (max - min + 1));
    },
  };
}

/** Random bigint in [min, max] (inclusive); range must fit in 2^48. */
export function randomBigInt(rng: Rng, min: bigint, max: bigint): bigint {
  if (max < min) throw new RangeError("bad range");
  const span = max - min;
  if (span > 2n ** 47n) throw new RangeError("range too large");
  return min + BigInt(rng.int(0, Number(span)));
}

/** API.md "Правила исполнения": epoch 3–10 s plus 0–20 s jitter per action. */
export interface ActionJitter {
  epochMinMs: number;
  epochMaxMs: number;
  jitterMaxMs: number;
}

export const DEFAULT_ACTION_JITTER: ActionJitter = { epochMinMs: 3_000, epochMaxMs: 10_000, jitterMaxMs: 20_000 };

/** `not_before` of a new buy / sell job. */
export function actionNotBefore(now: number, rng: Rng, j: ActionJitter = DEFAULT_ACTION_JITTER): number {
  return now + rng.int(j.epochMinMs, j.epochMaxMs) + rng.int(0, j.jitterMaxMs);
}

/** Random delay window of each withdraw part. */
export interface WithdrawDelay {
  minMs: number;
  maxMs: number;
}

/** Default: 1–10 min after the request (API.md: always a random delay). */
export const DEFAULT_WITHDRAW_DELAY: WithdrawDelay = { minMs: 60_000, maxMs: 600_000 };

/**
 * `not_before` per withdraw part: independent uniform delays, so parts are not
 * evenly spaced and their order on chain is random.
 */
export function withdrawSchedule(now: number, parts: number, rng: Rng, d: WithdrawDelay = DEFAULT_WITHDRAW_DELAY): number[] {
  if (!Number.isInteger(parts) || parts < 1) throw new RangeError("parts must be >= 1");
  return Array.from({ length: parts }, () => now + rng.int(d.minMs, d.maxMs));
}

/** Backoff for a retried job: 5 s · 2^(claims-1), capped at 5 min, plus 0–50 % jitter. */
export function retryNotBefore(now: number, claims: number, rng: Rng): number {
  const base = Math.min(300_000, 5_000 * 2 ** Math.max(0, claims - 1));
  return now + base + rng.int(0, Math.floor(base / 2));
}

/** Gas drop range for withdraw recipients, lamports. */
export interface GasDropRange {
  min: bigint;
  max: bigint;
}

/** 0.002–0.004 SOL: covers ATA rent of a later sell or a few hundred transfers. */
export const DEFAULT_GAS_DROP: GasDropRange = { min: 2_000_000n, max: 4_000_000n };

/** Random (not a fixed fingerprint value) gas drop. */
export function pickGasDrop(rng: Rng, r: GasDropRange = DEFAULT_GAS_DROP): bigint {
  return randomBigInt(rng, r.min, r.max);
}

/**
 * Splits `amount` into `parts` random positive shares (sum = amount), each at
 * least half of the even share, so no part equals the original buy amount.
 */
export function splitAmount(amount: bigint, parts: number, rng: Rng): bigint[] {
  if (!Number.isInteger(parts) || parts < 1) throw new RangeError("parts must be >= 1");
  if (amount < BigInt(parts) * 1_000n) throw new RangeError("amount too small to split");
  if (parts === 1) return [amount];
  const weights = Array.from({ length: parts }, () => rng.int(1_000, 2_000));
  const total = BigInt(weights.reduce((a, b) => a + b, 0));
  const out = weights.map((w) => (amount * BigInt(w)) / total);
  const rest = amount - out.reduce((a, b) => a + b, 0n);
  out[rng.int(0, parts - 1)]! += rest;
  return out;
}
