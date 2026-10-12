// Quote math for actions from the balance, in integers (bigint) so what we sign is exact.
// Prices come as decimal strings (SOL per whole token); amounts as base-unit integer strings.
// Estimates use the current token price (no curve impact): slippage covers the rest.

import { base58 } from "@scure/base";
import type { RateUsed } from "@/lib/api/types";

const TEN = BigInt(10);
const ZERO = BigInt(0);
const ZAT_PER_ZEC = BigInt(100_000_000);
const LAMPORTS_PER_SOL = BigInt(1_000_000_000);
const BPS = BigInt(10_000);

/** Decimal string (plain or e-notation) -> exact fraction num / 10^scale. */
export function parseDecimal(s: string): { num: bigint; scale: number } | null {
  const m = s.trim().match(/^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!m || (m[1] === "" && !m[2])) return null;
  const int = m[1] || "0";
  const frac = m[2] ?? "";
  const exp = Number(m[3] ?? 0);
  let num = BigInt(int + frac);
  let scale = frac.length - exp;
  if (scale < 0) {
    num *= TEN ** BigInt(-scale);
    scale = 0;
  }
  return { num, scale };
}

/** Lamports for `amount` base units at `priceSol` (SOL per whole token). Floor. */
export function tokensToLamports(amount: bigint, priceSol: string, decimals: number): bigint {
  const p = parseDecimal(priceSol);
  if (!p) return ZERO;
  return (amount * p.num * LAMPORTS_PER_SOL) / (TEN ** BigInt(p.scale) * TEN ** BigInt(decimals));
}

/** Base units bought with `lamports` at `priceSol`. Floor; 0 when the price is unknown. */
export function lamportsToTokens(lamports: bigint, priceSol: string, decimals: number): bigint {
  const p = parseDecimal(priceSol);
  if (!p || p.num === ZERO) return ZERO;
  return (lamports * TEN ** BigInt(p.scale) * TEN ** BigInt(decimals)) / (p.num * LAMPORTS_PER_SOL);
}

export const zatToLamports = (zat: bigint, lamportsPerZec: bigint) => (zat * lamportsPerZec) / ZAT_PER_ZEC;
export const lamportsToZat = (lamports: bigint, lamportsPerZec: bigint) =>
  lamportsPerZec === ZERO ? ZERO : (lamports * ZAT_PER_ZEC) / lamportsPerZec;
export const lamportsToZatCeil = (lamports: bigint, lamportsPerZec: bigint) =>
  lamportsPerZec === ZERO ? ZERO : (lamports * ZAT_PER_ZEC + lamportsPerZec - BigInt(1)) / lamportsPerZec;

/** Apply slippage: floor(v * (1 - bps/10000)). */
export const withSlippage = (v: bigint, bps: number) => (v * (BPS - BigInt(bps))) / BPS;

export interface BuyQuote {
  lamports: bigint;
  tokensOut: bigint;
  /** What we sign: 0 when there is no rate to quote with (no price limit). */
  minOut: bigint;
}

export function quoteBuy(zecIn: bigint, rate: RateUsed | null, priceSol: string, decimals: number, slippageBps: number): BuyQuote | null {
  if (!rate) return null;
  const lamports = zatToLamports(zecIn, BigInt(rate.lamportsPerZec));
  const tokensOut = lamportsToTokens(lamports, priceSol, decimals);
  return { lamports, tokensOut, minOut: withSlippage(tokensOut, slippageBps) };
}

export interface SellQuote {
  lamports: bigint;
  zecOut: bigint;
  minZecOut: bigint;
}

export function quoteSell(amount: bigint, rate: RateUsed | null, priceSol: string, decimals: number, slippageBps: number): SellQuote | null {
  if (!rate) return null;
  const lamports = tokensToLamports(amount, priceSol, decimals);
  const zecOut = lamportsToZat(lamports, BigInt(rate.lamportsPerZec));
  return { lamports, zecOut, minZecOut: withSlippage(zecOut, slippageBps) };
}

// ---- pool fees (defaults of core/api config; the API does not publish them yet) ----

/** WITHDRAW_ZEC_FEE_ZAT default. */
export const WITHDRAW_ZEC_FEE_ZAT = BigInt(15_000);
/** WITHDRAW_TOKEN_GAS_LAMPORTS: SOL dropped to every recipient for its own fees. */
export const WITHDRAW_TOKEN_GAS_LAMPORTS = BigInt(2_000_000);
/** WITHDRAW_TOKEN_COST_LAMPORTS: ATA rent + tx fee per part. */
export const WITHDRAW_TOKEN_COST_LAMPORTS = BigInt(2_100_000);

export function withdrawTokenFee(parts: number, rate: RateUsed | null): { lamports: bigint; zat: bigint | null } {
  const lamports = BigInt(parts) * (WITHDRAW_TOKEN_GAS_LAMPORTS + WITHDRAW_TOKEN_COST_LAMPORTS);
  return { lamports, zat: rate ? lamportsToZatCeil(lamports, BigInt(rate.lamportsPerZec)) : null };
}

// ---- Solana addresses ----

/** base58 of exactly 32 bytes, canonical (re-encodes to the same string). */
export function isSolanaAddress(s: string): boolean {
  const a = s.trim();
  if (a.length < 32 || a.length > 44) return false;
  try {
    const b = base58.decode(a);
    return b.length === 32 && base58.encode(b) === a;
  } catch {
    return false;
  }
}

/** Two amounts "look the same" to an observer: within `tolerance` (default 2 %). */
export function amountsMatch(a: bigint, b: bigint, tolerance = 0.02): boolean {
  if (a <= ZERO || b <= ZERO) return false;
  const diff = a > b ? a - b : b - a;
  const max = a > b ? a : b;
  return diff * BigInt(10_000) <= max * BigInt(Math.round(tolerance * 10_000));
}
