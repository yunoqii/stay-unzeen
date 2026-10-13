import { formatUnits } from "viem";
import { AdapterError } from "../../errors";

/**
 * Off-chain mirror of PonsV2BondingCurve.buy / sell pricing (verified source,
 * PonsV2BondingCurve.sol + PonsV2BondingCurveMath.sol, solc 0.8.35). Integer
 * arithmetic identical to the contract, so a quote equals the executed amount
 * when the state did not move (test/evm/pons-fork.test.ts checks equality).
 */

export const BPS = 10_000n;

export interface CurveState {
  phantomQuote: bigint;
  trackedQuote: bigint;
  quoteFeeBalance: bigint;
  creatorTaxBalance: bigint;
  trackedTokens: bigint;
  reservedTokens: bigint;
  launchSupply: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  graduated: boolean;
  launchedAt: bigint;
  snipeTaxStartBps: bigint;
  snipeTaxSeconds: bigint;
}

export function reserves(s: CurveState): { quote: bigint; token: bigint } {
  return { quote: s.phantomQuote + s.trackedQuote - s.quoteFeeBalance - s.creatorTaxBalance, token: s.trackedTokens };
}

export function sellableTokens(s: CurveState): bigint {
  return s.trackedTokens > s.reservedTokens ? s.trackedTokens - s.reservedTokens : 0n;
}

export function readyToGraduate(s: CurveState): boolean {
  return !s.graduated && sellableTokens(s) === 0n;
}

/** `currentSnipeTaxBps(recipient)` at block time `now` (unix s). */
export function snipeTaxBps(s: CurveState, exempt: boolean, now: bigint): bigint {
  if (exempt) return 0n;
  if (s.snipeTaxStartBps === 0n) return 0n;
  const elapsed = now - s.launchedAt;
  if (elapsed >= s.snipeTaxSeconds) return 0n;
  return s.snipeTaxStartBps >> ((elapsed * 14n) / s.snipeTaxSeconds);
}

/** PonsV2BondingCurveMath.getAmountOut (reverting variant). */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint): bigint {
  if (amountIn === 0n) throw new AdapterError("bad_request", "amount too small (InsufficientInputAmount)");
  if (reserveIn === 0n || reserveOut === 0n) throw new AdapterError("graduated", "curve has no liquidity");
  const withFee = amountIn * (BPS - feeBps);
  const out = (withFee * reserveOut) / (reserveIn * BPS + withFee);
  if (out === 0n) throw new AdapterError("slippage", "amount too small to buy one base unit (InsufficientOutputAmount)");
  return out;
}

/** PonsV2BondingCurveMath.getAmountIn. */
export function getAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint): bigint {
  if (amountOut === 0n) throw new AdapterError("bad_request", "zero output");
  if (reserveIn === 0n || reserveOut <= amountOut) throw new AdapterError("graduated", "insufficient liquidity");
  if (feeBps >= BPS) throw new AdapterError("graduated", "insufficient liquidity");
  return (amountOut * reserveIn * BPS) / ((reserveOut - amountOut) * (BPS - feeBps)) + 1n;
}

function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  const p = a * b;
  return p / d + (p % d === 0n ? 0n : 1n);
}

export interface BuyQuote {
  /** Tokens received (base units). */
  tokensOut: bigint;
  /** Quote actually spent (wei, fees included); < quoteIn on a clamped final fill. */
  spent: bigint;
  /** Refunded to the caller (quoteIn - spent). */
  refund: bigint;
  /** Base fee + snipe tax (as the CurveBuy event reports `fee`). */
  fee: bigint;
  /** Creator tax. */
  tax: bigint;
  snipeTax: bigint;
  snipeTaxBps: bigint;
  /** True when the buy hit the graduation allocation and was clamped. */
  clamped: boolean;
}

export function quoteBuy(s: CurveState, quoteIn: bigint, snipeBps = 0n): BuyQuote {
  if (s.graduated) throw new AdapterError("graduated", "curve graduated");
  if (quoteIn <= 0n) throw new AdapterError("bad_request", "quoteIn must be > 0");
  const r = reserves(s);
  let sb = snipeBps;
  if (sb !== 0n) {
    const max = BPS - s.feeBps - s.creatorTaxBps - 100n;
    if (sb > max) sb = max;
  }
  const received = quoteIn;
  let spent = received;
  let fee = (spent * s.feeBps) / BPS;
  let tax = (spent * s.creatorTaxBps) / BPS;
  let snipe = (spent * sb) / BPS;
  let tokensOut = getAmountOut(spent - fee - tax - snipe, r.quote, r.token, 0n);
  const sellable = r.token > s.reservedTokens ? r.token - s.reservedTokens : 0n;
  if (sellable === 0n) throw new AdapterError("graduated", "curve sold out (ready to graduate)");
  let clamped = false;
  if (tokensOut > sellable) {
    clamped = true;
    tokensOut = sellable;
    const net = getAmountIn(sellable, r.quote, r.token, 0n);
    const grossed = mulDivCeil(net, BPS, BPS - s.feeBps - s.creatorTaxBps - sb);
    spent = grossed < received ? grossed : received;
    fee = (spent * s.feeBps) / BPS;
    tax = (spent * s.creatorTaxBps) / BPS;
    snipe = (spent * sb) / BPS;
  }
  return { tokensOut, spent, refund: received - spent, fee: fee + snipe, tax, snipeTax: snipe, snipeTaxBps: sb, clamped };
}

/** The curve's own slippage rule (price bound, = quantity bound when not clamped). */
export function buyPassesMin(q: BuyQuote, quoteIn: bigint, minTokensOut: bigint): boolean {
  return !(q.spent * minTokensOut > quoteIn * q.tokensOut);
}

export interface SellQuote {
  quoteOut: bigint;
  fee: bigint;
  tax: bigint;
}

export function quoteSell(s: CurveState, tokensIn: bigint): SellQuote {
  if (s.graduated || readyToGraduate(s)) throw new AdapterError("graduated", "curve graduated");
  if (tokensIn <= 0n) throw new AdapterError("bad_request", "tokensIn must be > 0");
  const r = reserves(s);
  const gross = getAmountOut(tokensIn, r.token, r.quote, 0n);
  const fee = (gross * s.feeBps) / BPS;
  const tax = (gross * s.creatorTaxBps) / BPS;
  return { quoteOut: gross - fee - tax, fee, tax };
}

/** State after a buy (for chained quotes / tests). */
export function applyBuy(s: CurveState, q: BuyQuote): CurveState {
  return {
    ...s,
    trackedQuote: s.trackedQuote + q.spent,
    trackedTokens: s.trackedTokens - q.tokensOut,
    quoteFeeBalance: s.quoteFeeBalance + q.fee,
    creatorTaxBalance: s.creatorTaxBalance + q.tax,
  };
}

/**
 * State of a brand-new curve right after `launchToken` (no trades yet), from the
 * launch config: lets `create` price the first buy exactly, offline.
 */
export function freshCurveState(cfg: {
  supply: bigint;
  curveFeeBps: bigint;
  phantomQuote: bigint;
  graduationThreshold: bigint;
  creatorTaxBps: bigint;
  snipeTaxStartBps: bigint;
  snipeTaxSeconds: bigint;
  launchedAt?: bigint;
}): CurveState {
  // Math.mulDiv(supply, phantom, phantom + threshold), rounding down.
  const reserved = (cfg.supply * cfg.phantomQuote) / (cfg.phantomQuote + cfg.graduationThreshold);
  return {
    phantomQuote: cfg.phantomQuote,
    trackedQuote: 0n,
    quoteFeeBalance: 0n,
    creatorTaxBalance: 0n,
    trackedTokens: cfg.supply,
    reservedTokens: reserved,
    launchSupply: cfg.supply,
    feeBps: cfg.curveFeeBps,
    creatorTaxBps: cfg.creatorTaxBps,
    graduated: false,
    launchedAt: cfg.launchedAt ?? 0n,
    snipeTaxStartBps: cfg.snipeTaxStartBps,
    snipeTaxSeconds: cfg.snipeTaxSeconds,
  };
}

/** expected x (1 - bps/10000), floor; never below 1 for a positive expectation. */
export function minOutWithSlippage(expected: bigint, slippageBps: bigint): bigint {
  if (slippageBps < 0n || slippageBps >= BPS) throw new RangeError("slippageBps must be 0..9999");
  const v = (expected * (BPS - slippageBps)) / BPS;
  return expected > 0n && v === 0n ? 1n : v;
}

/** Spot price (ETH per whole token, both 18 decimals) and market cap (ETH), decimal strings. */
export function spot(s: CurveState, decimals = 18): { price: string; marketCap: string } {
  const r = reserves(s);
  if (r.token === 0n) return { price: "0", marketCap: "0" };
  const scale = 10n ** BigInt(decimals);
  const priceScaled = (r.quote * scale) / r.token; // wei per whole token, 18-dec fixed point
  const capWei = (r.quote * s.launchSupply) / r.token;
  return { price: formatUnits(priceScaled, 18), marketCap: formatUnits(capWei, 18) };
}
