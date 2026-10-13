// Quote math for actions from the balance, in integers (bigint) so what we sign is exact.
// Prices come as decimal strings (SOL per whole token); amounts as base-unit integer strings.
// Estimates use the current token price (no curve impact): slippage covers the rest.

import { base58 } from "@scure/base";
import type { SolRateUsed } from "@/lib/api/types";

const TEN = BigInt(10);
const ZERO = BigInt(0);
const ZAT_PER_ZEC = BigInt(100_000_000);
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

/** Quote base units (quote with `quoteDecimals`) for `amount` token base units at `price` (quote per whole token). Floor. */
export function tokensToQuoteUnits(amount: bigint, price: string, decimals: number, quoteDecimals: number): bigint {
  const p = parseDecimal(price);
  if (!p) return ZERO;
  return (amount * p.num * TEN ** BigInt(quoteDecimals)) / (TEN ** BigInt(p.scale) * TEN ** BigInt(decimals));
}

/** Token base units bought with `units` of the quote at `price`. Floor; 0 when the price is unknown. */
export function quoteUnitsToTokens(units: bigint, price: string, decimals: number, quoteDecimals: number): bigint {
  const p = parseDecimal(price);
  if (!p || p.num === ZERO) return ZERO;
  return (units * TEN ** BigInt(p.scale) * TEN ** BigInt(decimals)) / (p.num * TEN ** BigInt(quoteDecimals));
}

/** Lamports for `amount` base units at `priceSol` (SOL per whole token). Floor. */
export function tokensToLamports(amount: bigint, priceSol: string, decimals: number): bigint {
  return tokensToQuoteUnits(amount, priceSol, decimals, 9);
}

/** Base units bought with `lamports` at `priceSol`. Floor; 0 when the price is unknown. */
export function lamportsToTokens(lamports: bigint, priceSol: string, decimals: number): bigint {
  return quoteUnitsToTokens(lamports, priceSol, decimals, 9);
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

export function quoteBuy(zecIn: bigint, rate: SolRateUsed | null, priceSol: string, decimals: number, slippageBps: number): BuyQuote | null {
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

export function quoteSell(amount: bigint, rate: SolRateUsed | null, priceSol: string, decimals: number, slippageBps: number): SellQuote | null {
  if (!rate) return null;
  const lamports = tokensToLamports(amount, priceSol, decimals);
  const zecOut = lamportsToZat(lamports, BigInt(rate.lamportsPerZec));
  return { lamports, zecOut, minZecOut: withSlippage(zecOut, slippageBps) };
}

// ---- ZEC SPL pairs (API v0.13): 1:1 parity with ZEC, no SOL rate ----
// buy spends zecIn × (1 − s) of ZEC SPL; sell credits ZEC SPL × 1/(1 + s) zatoshis; s = PoolInfo.quotes[ZEC].spreadBps.

/** Zatoshis -> quote base units at parity (ZEC SPL has 8 decimals like ZEC; scaled anyway). */
const zatToQuoteUnits = (zat: bigint, quoteDecimals: number) =>
  quoteDecimals >= 8 ? zat * TEN ** BigInt(quoteDecimals - 8) : zat / TEN ** BigInt(8 - quoteDecimals);
const quoteUnitsToZat = (units: bigint, quoteDecimals: number) =>
  quoteDecimals >= 8 ? units / TEN ** BigInt(quoteDecimals - 8) : units * TEN ** BigInt(8 - quoteDecimals);

export interface ZecPairBuyQuote {
  /** ZEC SPL base units the trade spends. */
  quoteUnits: bigint;
  tokensOut: bigint;
  minOut: bigint;
}

export function quoteBuyZecPair(zecIn: bigint, spreadBps: number, priceQuote: string | undefined, decimals: number, quoteDecimals: number, slippageBps: number): ZecPairBuyQuote | null {
  if (!priceQuote || !(Number(priceQuote) > 0)) return null;
  const quoteUnits = zatToQuoteUnits((zecIn * (BPS - BigInt(spreadBps))) / BPS, quoteDecimals);
  const tokensOut = quoteUnitsToTokens(quoteUnits, priceQuote, decimals, quoteDecimals);
  return { quoteUnits, tokensOut, minOut: withSlippage(tokensOut, slippageBps) };
}

export interface ZecPairSellQuote {
  quoteUnits: bigint;
  zecOut: bigint;
  minZecOut: bigint;
}

export function quoteSellZecPair(amount: bigint, spreadBps: number, priceQuote: string | undefined, decimals: number, quoteDecimals: number, slippageBps: number): ZecPairSellQuote | null {
  if (!priceQuote || !(Number(priceQuote) > 0)) return null;
  const quoteUnits = tokensToQuoteUnits(amount, priceQuote, decimals, quoteDecimals);
  const zecOut = (quoteUnitsToZat(quoteUnits, quoteDecimals) * BPS) / (BPS + BigInt(spreadBps));
  return { quoteUnits, zecOut, minZecOut: withSlippage(zecOut, slippageBps) };
}

/** What `amount` tokens are worth in zatoshis on a ZEC pair (sell side of the parity). Display only. */
export function zecPairValueZat(amount: bigint, spreadBps: number, priceQuote: string | undefined, decimals: number, quoteDecimals = 8): bigint | null {
  return quoteSellZecPair(amount, spreadBps, priceQuote, decimals, quoteDecimals, 0)?.zecOut ?? null;
}

// ---- pool fees (defaults of core/api config; the API does not publish them yet) ----

/** WITHDRAW_ZEC_FEE_ZAT default. */
export const WITHDRAW_ZEC_FEE_ZAT = BigInt(15_000);

/**
 * v0.17 (A2): on mainnet a ZEC payout above 1 ZEC (core UNZEEN_MAX_PAYOUT_ZAT default) waits for the
 * operator's approval. The action stays `queued` meanwhile; other payouts are not held up.
 */
export const PAYOUT_REVIEW_ABOVE_ZAT = BigInt(100_000_000);
export const PAYOUT_REVIEW_TEXT = "Large payouts are reviewed by the operator";
export function payoutReviewed(network: string, amountZat: bigint | string | null): boolean {
  if (network !== "mainnet" || amountZat === null) return false;
  const v = typeof amountZat === "bigint" ? amountZat : /^\d+$/.test(amountZat) ? BigInt(amountZat) : null;
  return v !== null && v > PAYOUT_REVIEW_ABOVE_ZAT;
}
/** WITHDRAW_TOKEN_GAS_LAMPORTS: SOL dropped to every recipient for its own fees. */
export const WITHDRAW_TOKEN_GAS_LAMPORTS = BigInt(2_000_000);
/** WITHDRAW_TOKEN_COST_LAMPORTS: ATA rent + tx fee per part. */
export const WITHDRAW_TOKEN_COST_LAMPORTS = BigInt(2_100_000);

export function withdrawTokenFee(parts: number, rate: SolRateUsed | null): { lamports: bigint; zat: bigint | null } {
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

/** v0.17 A6: the pool looks at your buys of the last 48 h. */
export const MIRROR_WINDOW_MS = 48 * 3_600_000;

/**
 * API v0.17 (A6): would the pool shave and round this sell so it does not mirror a buy? True when the
 * amount is within ±1 % of one buy (last 48 h), of their sum, or of the whole position (available + held:
 * "sell 100 %"). The UI then shows "≈"; the remainder stays on the balance.
 */
export function sellMirrorsBuy(amount: bigint, buys: readonly bigint[], position: bigint | null): "buy" | "position" | null {
  if (amount <= ZERO) return null;
  // core matches_public_buy: |x − amount| · 100 ≤ x, x = a buy, their sum or the position.
  const near = (x: bigint) => x > ZERO && (x > amount ? x - amount : amount - x) * BigInt(100) <= x;
  if (position !== null && near(position)) return "position";
  if (buys.some(near)) return "buy";
  const sum = buys.reduce((n, b) => n + (b > ZERO ? b : ZERO), ZERO);
  return buys.length > 1 && near(sum) ? "buy" : null;
}

/** Two amounts "look the same" to an observer: within `tolerance` (default 2 %). */
export function amountsMatch(a: bigint, b: bigint, tolerance = 0.02): boolean {
  if (a <= ZERO || b <= ZERO) return false;
  const diff = a > b ? a - b : b - a;
  const max = a > b ? a : b;
  return diff * BigInt(10_000) <= max * BigInt(Math.round(tolerance * 10_000));
}
