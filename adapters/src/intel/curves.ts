import BN from "bn.js";
import type { BondingCurve } from "@pump-fun/pump-sdk";
import { FEE_DENOMINATOR, getTotalFeeNumeratorFromIncludedFeeAmount, type PoolConfig, type VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";

/**
 * Per-token curve state for the price pass (API v0.28 `TokenCurve`, INTEL v4):
 * the CURRENT constant-product reserves of a token's curve (or of the DBC curve
 * segment it is in), the trade fee and how a buy pays it. One formula for every
 * venue (core and UI alike):
 *
 *   k = S·T; sell a: S·a/(T+a)·(1−f)
 *   buy x lamports: added  -> net = x/(1+f);  input -> net = x·(1−f);  tokens = T·net/(S+net)
 *                   output -> tokens = T·x/(S+x)·(1−f)
 *
 * Pure functions over decoded accounts: no RPC, no user input.
 */

export type BuyFee = "added" | "input" | "output";

export interface CurveState {
  /** S, lamports. */
  virtualSol: bigint;
  /** T, token base units. */
  virtualTokens: bigint;
  /** Total trade fee now, b.p.; null = core fills it in (pump.fun: FeeConfig tier of launch_curves). */
  feeBps: number | null;
  buyFee: BuyFee;
  /** Net lamports into the curve until it ends (or the current DBC segment does). */
  buyLimitLamports: bigint | null;
  /** DBC: tokens until the lower bound of the current segment. */
  sellLimitTokens: bigint | null;
}

/** intel_prices.curve JSON (decimal strings; keys as API.md TokenCurve without asOf). */
export function curveJson(c: CurveState): Record<string, string | number> {
  return {
    virtualSol: c.virtualSol.toString(),
    virtualTokens: c.virtualTokens.toString(),
    ...(c.feeBps !== null ? { feeBps: c.feeBps } : {}),
    buyFee: c.buyFee,
    ...(c.buyLimitLamports !== null ? { buyLimitLamports: c.buyLimitLamports.toString() } : {}),
    ...(c.sellLimitTokens !== null ? { sellLimitTokens: c.sellLimitTokens.toString() } : {}),
  };
}

const big = (x: BN | bigint | number): bigint => (typeof x === "bigint" ? x : BigInt(x.toString(10)));

/** Progress "0.00".."100.00" (floor) of `num / den`. */
export function pct2(num: bigint, den: bigint): string {
  if (den <= 0n) return "100.00";
  const bp = num <= 0n ? 0n : num >= den ? 10_000n : (num * 10_000n) / den;
  return `${bp / 100n}.${(bp % 100n).toString().padStart(2, "0")}`;
}

/**
 * pump.fun bonding curve: S, T = virtual reserves. The fee is charged on top of
 * the SOL into the curve ("added"). The curve ends when its real tokens are sold:
 * buying R real tokens takes S·R/(T−R) lamports net (ceil).
 */
export function pumpCurveState(curve: Pick<BondingCurve, "virtualQuoteReserves" | "virtualTokenReserves" | "realTokenReserves">): CurveState | null {
  const s = big(curve.virtualQuoteReserves);
  const t = big(curve.virtualTokenReserves);
  const r = big(curve.realTokenReserves);
  if (s <= 0n || t <= 0n) return null;
  const limit = r > 0n && r < t ? (s * r + (t - r) - 1n) / (t - r) : r >= t ? null : 0n;
  return { virtualSol: s, virtualTokens: t, feeBps: null, buyFee: "added", buyLimitLamports: limit, sellLimitTokens: null };
}

const Q128 = 1n << 128n;

type DbcPoolState = Pick<VirtualPool["poolState"], "sqrtPrice" | "quoteReserve" | "volatilityTracker" | "activationPoint">;
type DbcConfig = Pick<PoolConfig, "curve" | "sqrtStartPrice" | "migrationSqrtPrice" | "migrationQuoteThreshold" | "collectFeeMode" | "poolFees">;

/** Fee probe size (lamports): DBC fee does not depend on size except with a rate limiter, where small sizes pay the base fee. */
const DBC_FEE_PROBE = new BN(1_000_000);

/**
 * Meteora DBC: concentrated-liquidity segments in sqrt price (Q64.64). Inside
 * the segment holding the current sqrt price `P` with liquidity `L` the curve is
 * constant product with S = L·P / 2^128 (quote), T = L / P (base): exactly the
 * SDK's getDeltaAmountQuote / getDeltaAmountBase. Limits are the segment bounds
 * (and the migration price / quote threshold). Fee: base (scheduler / rate
 * limiter at a small size) + dynamic, at `currentPoint` (slot or unix seconds per
 * the config's activation type); collect mode QuoteToken -> "input", OutputToken -> "output".
 */
export function dbcCurveState(pool: DbcPoolState, config: DbcConfig, currentPoint: BN | null): CurveState | null {
  const sp = big(pool.sqrtPrice);
  if (sp <= 0n) return null;
  const stop = big(config.migrationSqrtPrice);
  let lower = big(config.sqrtStartPrice);
  for (const seg of config.curve) {
    const upperRaw = big(seg.sqrtPrice);
    const liq = big(seg.liquidity);
    if (upperRaw === 0n || liq === 0n) break;
    const upper = stop > 0n && stop < upperRaw ? stop : upperRaw;
    if (upper > sp) {
      const s = (liq * sp) / Q128;
      const t = liq / sp;
      if (s <= 0n || t <= 0n) return null;
      let buyLimit = (liq * (upper - sp)) / Q128;
      const left = big(config.migrationQuoteThreshold) - big(pool.quoteReserve);
      if (left >= 0n && left < buyLimit) buyLimit = left;
      const sellLimit = lower > 0n && sp > lower ? (liq * (sp - lower)) / (lower * sp) : null;
      let feeBps: number | null = null;
      if (currentPoint) {
        try {
          const num = getTotalFeeNumeratorFromIncludedFeeAmount(
            config.poolFees as never,
            pool.volatilityTracker as never,
            currentPoint,
            pool.activationPoint,
            DBC_FEE_PROBE,
            1 /* QuoteToBase */,
          );
          feeBps = Math.round((Number(num.toString(10)) * 10_000) / FEE_DENOMINATOR);
        } catch {
          feeBps = null;
        }
      }
      if (feeBps === null || !Number.isFinite(feeBps) || feeBps < 0 || feeBps > 9_900) return null;
      return {
        virtualSol: s,
        virtualTokens: t,
        feeBps,
        buyFee: Number(config.collectFeeMode) === 1 ? "output" : "input",
        buyLimitLamports: buyLimit,
        sellLimitTokens: sellLimit,
      };
    }
    lower = upper;
    if (upper === stop) break;
  }
  return null;
}

/** DBC progress (= meteora.ts dbcProgressPct): quote raised / migration threshold. */
export function dbcProgress(pool: Pick<DbcPoolState, "quoteReserve">, config: Pick<DbcConfig, "migrationQuoteThreshold">): string {
  return pct2(big(pool.quoteReserve), big(config.migrationQuoteThreshold));
}

export interface LaunchLabPoolFacts {
  virtualA: BN | bigint;
  virtualB: BN | bigint;
  realA: BN | bigint;
  realB: BN | bigint;
  totalFundRaisingB: BN | bigint;
  status: number | BN;
}

/**
 * Raydium LaunchLab, curve type 0 (constant product over virtual reserves):
 * S = virtualB + realB, T = virtualA − realA. Fees (1e-6 units) are protocol
 * (GlobalConfig.tradeFeeRate) + platform + creator, deducted from the quote in
 * on a buy ("input") and from the quote out on a sell. Ends at totalFundRaisingB.
 * Other curve types (fixed price, linear) -> null (no constant-product state).
 */
export function launchLabCurveState(
  pool: LaunchLabPoolFacts,
  config: { curveType: number | BN; tradeFeeRate: BN | bigint },
  platform: { feeRate: BN | bigint; creatorFeeRate: BN | bigint },
): CurveState | null {
  if (Number(config.curveType.toString()) !== 0) return null;
  const s = big(pool.virtualB) + big(pool.realB);
  const t = big(pool.virtualA) - big(pool.realA);
  if (s <= 0n || t <= 0n) return null;
  const rate = big(config.tradeFeeRate) + big(platform.feeRate) + big(platform.creatorFeeRate); // 1e-6
  const feeBps = Number(rate / 100n);
  if (feeBps > 9_900) return null;
  const left = big(pool.totalFundRaisingB) - big(pool.realB);
  return { virtualSol: s, virtualTokens: t, feeBps, buyFee: "input", buyLimitLamports: left > 0n ? left : 0n, sellLimitTokens: null };
}

export function launchLabProgress(pool: Pick<LaunchLabPoolFacts, "realB" | "totalFundRaisingB">): string {
  return pct2(big(pool.realB), big(pool.totalFundRaisingB));
}

// ---------------------------------------------------------------------------
// the formula (reference for tests; core/ledger/src/curve.rs is the server copy)
// ---------------------------------------------------------------------------

export function estimateSell(c: Pick<CurveState, "virtualSol" | "virtualTokens" | "feeBps">, amount: bigint): bigint {
  const f = BigInt(c.feeBps ?? 0);
  const gross = (c.virtualSol * amount) / (c.virtualTokens + amount);
  return (gross * (10_000n - f)) / 10_000n;
}

export function estimateBuy(c: Pick<CurveState, "virtualSol" | "virtualTokens" | "feeBps" | "buyFee">, lamports: bigint): bigint {
  const f = BigInt(c.feeBps ?? 0);
  const { virtualSol: s, virtualTokens: t } = c;
  if (c.buyFee === "output") return ((t * lamports) / (s + lamports) * (10_000n - f)) / 10_000n;
  const net = c.buyFee === "added" ? (lamports * 10_000n) / (10_000n + f) : (lamports * (10_000n - f)) / 10_000n;
  return (t * net) / (s + net);
}
