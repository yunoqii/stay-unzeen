import {
  getBuyTokenAmountFromSolAmount,
  getBuyV3TokenAmountFromQuoteAmount,
  newBondingCurve,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from "@pump-fun/pump-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { toBN, toBig } from "./math";

/**
 * Fair-launch v2 (docs/analysis/fair-launch.md §3, owner decision 13.10):
 * split the launch buy over up to 5 vaults in ONE Jito bundle
 * (create+buy from vault A, then buy from B, C, ...). Pure planning and quoting:
 * no RPC, unit-tested.
 *
 * Why split at all: a vault can only spend what it holds. Constant product +
 * proportional fees means several buys in a row cost the same as one buy of
 * the sum (up to rounding and the fee tier of the market cap), so the split
 * never makes the launch cheaper; it is about capacity (and, optionally,
 * `maxPerVault` so no single pool vault becomes a top holder).
 *
 * Leg amounts are a function of the pool total and vault balances only (never
 * of single bids), even-ish and quantized to 0.001 SOL: they reveal nothing the
 * public launch total does not.
 */

export interface VaultCapacity {
  key: string;
  /** Spendable SOL right now, lamports. */
  sol: bigint;
}

export interface FairPlanConfig {
  /** Max legs in one bundle (Jito: 5). */
  maxLegs: number;
  /** Optional cap per leg, lamports (null = only the vault balance limits). */
  maxPerVault: bigint | null;
  /** Reserve on the create vault: rent of mint/curve/ATAs/ALT + fees + tip. */
  createReserve: bigint;
  /** Reserve on a buy leg: ATA + accumulator rent + fees + tip + the consolidation tx. */
  legReserve: bigint;
  /** Leg amounts are multiples of this (default 0.001 SOL); the create leg takes the remainder. */
  quantum: bigint;
  /** Smallest leg worth a tx. */
  minLeg: bigint;
}

export const DEFAULT_PLAN: Omit<FairPlanConfig, "createReserve" | "legReserve"> = {
  maxLegs: 5,
  maxPerVault: null,
  quantum: 1_000_000n,
  minLeg: 10_000_000n,
};

export interface PlannedLeg {
  vault: string;
  lamports: bigint;
}

export type FairPlan =
  /** One tx from `vault` (current v1 path). `lamports < total` = capped (rest refunded by core). */
  | { mode: "single"; vault: string; lamports: bigint; capped: boolean }
  /** legs[0] = create + first buy (vault A, the mint's pinned vault); Σ lamports <= total. */
  | { mode: "bundle"; legs: PlannedLeg[]; capped: boolean }
  /** Not even one vault can carry a minimal launch. */
  | { mode: "insufficient" };

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * Plans the launch buy of `total` lamports.
 * - `pinned`: the vault a previous attempt pinned the mint to (D4); it must be leg A.
 *   Otherwise A = the vault with the most capacity (callers pass candidates in
 *   random order, ties keep that order).
 * - `bundle: false` (Jito off / unavailable / out of tries): at most one tx, capped
 *   to what vault A can spend.
 */
export function planFairLaunch(
  total: bigint,
  vaults: readonly VaultCapacity[],
  cfg: FairPlanConfig,
  o: { pinned?: string | null; bundle: boolean },
): FairPlan {
  if (total <= 0n) throw new RangeError("total must be > 0");
  if (cfg.maxLegs < 1 || cfg.maxLegs > 5) throw new RangeError("maxLegs must be 1..5");
  if (cfg.quantum <= 0n) throw new RangeError("quantum must be > 0");
  const capOf = (v: VaultCapacity, reserve: bigint) => {
    const c = max(0n, v.sol - reserve);
    return cfg.maxPerVault !== null ? min(c, cfg.maxPerVault) : c;
  };
  let a: VaultCapacity | undefined;
  if (o.pinned) {
    a = vaults.find((v) => v.key === o.pinned) ?? { key: o.pinned, sol: 0n };
  } else {
    for (const v of vaults) if (!a || capOf(v, cfg.createReserve) > capOf(a, cfg.createReserve)) a = v;
  }
  if (!a) return { mode: "insufficient" };
  const capA = capOf(a, cfg.createReserve);
  if (capA >= total) return { mode: "single", vault: a.key, lamports: total, capped: false };
  // The create leg must itself buy something worth a tx (it carries the launch).
  if (capA < cfg.minLeg) return { mode: "insufficient" };

  const singleCapped = (): FairPlan => {
    const l = floorTo(capA, cfg.quantum);
    return l >= cfg.minLeg ? { mode: "single", vault: a.key, lamports: l, capped: true } : { mode: "insufficient" };
  };
  if (!o.bundle || cfg.maxLegs < 2) return singleCapped();

  // Other legs: largest capacity first, as few as needed.
  const others = vaults
    .filter((v) => v.key !== a.key)
    .map((v) => ({ key: v.key, cap: capOf(v, cfg.legReserve) }))
    .filter((v) => v.cap >= cfg.minLeg)
    .sort((x, y) => (y.cap > x.cap ? 1 : y.cap < x.cap ? -1 : 0));
  const chosen: { key: string; cap: bigint }[] = [{ key: a.key, cap: capA }];
  let sum = capA;
  for (const v of others) {
    if (sum >= total || chosen.length >= cfg.maxLegs) break;
    chosen.push(v);
    sum += v.cap;
  }
  if (chosen.length < 2) return singleCapped();
  const target = min(total, sum);
  const amounts = waterFill(target, chosen.map((c) => c.cap), cfg.quantum);
  const legs = chosen.map((c, i) => ({ vault: c.key, lamports: amounts[i]! })).filter((l, i) => i === 0 || l.lamports >= cfg.minLeg);
  if (legs.length < 2 || legs[0]!.lamports <= 0n) return singleCapped();
  const executed = legs.reduce((s, l) => s + l.lamports, 0n);
  return { mode: "bundle", legs, capped: executed < total };
}

/**
 * Splits `target` over capacities as evenly as they allow (water-filling),
 * every share a multiple of `quantum` except the remainder, which goes to the
 * first leg (the create leg) when it has room, else to any leg with room.
 * Σ result = target whenever Σ caps >= target.
 */
export function waterFill(target: bigint, caps: readonly bigint[], quantum: bigint): bigint[] {
  const n = caps.length;
  const out = new Array<bigint>(n).fill(0n);
  const order = caps.map((c, i) => ({ c, i })).sort((x, y) => (x.c > y.c ? 1 : x.c < y.c ? -1 : 0));
  let remaining = target;
  for (let k = 0; k < n; k++) {
    const { c, i } = order[k]!;
    const share = floorTo(remaining / BigInt(n - k), quantum);
    const amt = min(floorTo(c, quantum), share);
    out[i] = amt;
    remaining -= amt;
  }
  // Quantization remainder (< n * quantum unless caps bind): create leg first, then any leg with room.
  for (const i of [0, ...Array.from({ length: n }, (_, j) => j).filter((j) => j !== 0)]) {
    if (remaining <= 0n) break;
    const room = caps[i]! - out[i]!;
    const add = min(room, remaining);
    if (add > 0n) {
      out[i] = out[i]! + add;
      remaining -= add;
    }
  }
  return out;
}

export function floorTo(x: bigint, q: bigint): bigint {
  return x <= 0n ? 0n : (x / q) * q;
}

// ---------------------------------------------------------------------------
// fresh-curve quotes (the mint does not exist yet when the bundle is signed)
// ---------------------------------------------------------------------------

/** pump.fun curve right after create_v2 (SOL quote, no mayhem, schedule creator fee). */
export function freshCurve(global: Global, creator: PublicKey): BondingCurve {
  return { ...newBondingCurve(global), creator, isMayhemMode: false };
}

/**
 * Curve state after a buy of `tokens` (the curve leg of the program's
 * constant-product: sol = vq * t / (vt - t) + 1). Fees do not move reserves.
 * Approximate to a lamport; min_tokens_out keeps a margin for it.
 */
export function applyBuy(curve: BondingCurve, tokens: bigint): BondingCurve {
  const vt = toBig(curve.virtualTokenReserves);
  const vq = toBig(curve.virtualQuoteReserves);
  if (tokens <= 0n) return curve;
  if (tokens >= vt) throw new RangeError("buy exceeds virtual reserves");
  const sol = (vq * tokens) / (vt - tokens) + 1n;
  return {
    ...curve,
    virtualTokenReserves: toBN(vt - tokens),
    virtualQuoteReserves: toBN(vq + sol),
    realTokenReserves: toBN(toBig(curve.realTokenReserves) - tokens),
    realQuoteReserves: toBN(toBig(curve.realQuoteReserves) + sol),
  };
}

export interface LegQuote {
  /** Tokens the leg is quoted to get (base units). */
  tokens: bigint;
  /** Curve BEFORE this leg (what the leg's buy instruction is built against). */
  curveBefore: BondingCurve;
}

/**
 * Deterministic quotes of the legs on the fresh curve, in bundle order:
 * leg 0 = `create_v2 + buy_v2` (tokens for SOL, as `createIxs` computes them),
 * legs 1.. = `buy_exact_quote_in_v3` on the curve the previous legs left.
 */
export function quoteFairLegs(global: Global, feeConfig: FeeConfig, creator: PublicKey, lamports: readonly bigint[]): LegQuote[] {
  let curve = freshCurve(global, creator);
  const supply = toBig(global.tokenTotalSupply);
  let sold = 0n;
  const out: LegQuote[] = [];
  lamports.forEach((l, i) => {
    if (l <= 0n) throw new RangeError("leg lamports must be > 0");
    let tokens: bigint;
    if (i === 0) {
      tokens = toBig(
        getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: toBN(l), quoteMint: NATIVE_MINT }),
      );
    } else {
      tokens = toBig(
        getBuyV3TokenAmountFromQuoteAmount({
          global,
          feeConfig,
          mintSupply: curve.tokenTotalSupply,
          bondingCurve: curve,
          amount: toBN(l),
          curveBaseTokenBalance: toBN(supply - sold),
        }),
      );
    }
    out.push({ tokens, curveBefore: curve });
    curve = applyBuy(curve, tokens);
    sold += tokens;
  });
  return out;
}

/**
 * Per-leg `min_tokens_out` from core's aggregate `min_out` (RELAYER v6 item 6:
 * the relayer does not recompute slippage, it only distributes core's floor):
 * min_i = floor(min_out * q_i / Q), at least 1. Σ min_i <= min_out <= Q.
 * Throws when the legs cannot reach `min_out` at all (core's quote is stale).
 */
export function splitMinOut(minOut: bigint, quotes: readonly bigint[]): bigint[] {
  const q = quotes.reduce((s, x) => s + x, 0n);
  if (minOut <= 0n) throw new RangeError("minOut must be > 0");
  if (q < minOut) throw new RangeError(`legs quote ${q} < min_out ${minOut}`);
  return quotes.map((x) => max(1n, (minOut * x) / q));
}

/** Capped single tx: core's floor scaled to the part actually bought (same ratio). */
export function scaleMinOut(minOut: bigint, partQuote: bigint, fullQuote: bigint): bigint {
  if (fullQuote <= 0n) throw new RangeError("fullQuote must be > 0");
  return max(1n, (minOut * partQuote) / fullQuote);
}

/** Single-tx quote of `lamports` on the fresh curve (leg 0 alone). */
export function quoteFreshBuy(global: Global, feeConfig: FeeConfig, lamports: bigint): bigint {
  return toBig(
    getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: toBN(lamports), quoteMint: NATIVE_MINT }),
  );
}
