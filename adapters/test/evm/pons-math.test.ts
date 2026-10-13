import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/errors";
import {
  applyBuy,
  buyPassesMin,
  freshCurveState,
  getAmountIn,
  getAmountOut,
  minOutWithSlippage,
  quoteBuy,
  quoteSell,
  readyToGraduate,
  sellableTokens,
  snipeTaxBps,
  spot,
  type CurveState,
} from "../../src/evm/pons/math";

const E = 10n ** 18n;
// Live launch config 0 of PonsV2LaunchFactory (read 2026-10-13).
const CFG = {
  supply: 10n ** 27n,
  curveFeeBps: 100n,
  phantomQuote: 168n * 10n ** 16n, // 1.68 ETH
  graduationThreshold: 42n * 10n ** 17n, // 4.2 ETH
  creatorTaxBps: 0n,
  snipeTaxStartBps: 9900n,
  snipeTaxSeconds: 3n,
  launchedAt: 1_000n,
};

describe("pons curve math", () => {
  it("fresh curve: reserved allocation = supply * phantom / (phantom + threshold)", () => {
    const s = freshCurveState(CFG);
    expect(s.reservedTokens).toBe((CFG.supply * CFG.phantomQuote) / (CFG.phantomQuote + CFG.graduationThreshold));
    expect(sellableTokens(s)).toBe(CFG.supply - s.reservedTokens);
    expect(readyToGraduate(s)).toBe(false);
  });

  it("buy: 1% fee off the input, constant product on the rest", () => {
    const s = freshCurveState(CFG);
    const q = quoteBuy(s, E / 10n);
    const net = E / 10n - E / 1000n; // 0.099 ETH
    expect(q.fee).toBe(E / 1000n);
    expect(q.tax).toBe(0n);
    expect(q.tokensOut).toBe((net * 10_000n * CFG.supply) / (CFG.phantomQuote * 10_000n + net * 10_000n));
    expect(q.spent).toBe(E / 10n);
    expect(q.refund).toBe(0n);
    expect(q.clamped).toBe(false);
  });

  it("creator tax is charged on top of the base fee", () => {
    const s = freshCurveState({ ...CFG, creatorTaxBps: 300n });
    const q = quoteBuy(s, E);
    expect(q.fee).toBe(E / 100n);
    expect(q.tax).toBe((E * 3n) / 100n);
    const sq = quoteSell(applyBuy(s, q), q.tokensOut / 2n);
    expect(sq.tax).toBe((((sq.quoteOut + sq.fee + sq.tax) * 300n) / 10_000n));
  });

  it("snipe tax: 99% at second 0, ~6% at 1 s, ~0.2% at 2 s, 0 from 3 s, never for exempt", () => {
    const s = freshCurveState(CFG);
    expect(snipeTaxBps(s, false, 1_000n)).toBe(9900n);
    expect(snipeTaxBps(s, false, 1_001n)).toBe(9900n >> 4n); // 618
    expect(snipeTaxBps(s, false, 1_002n)).toBe(9900n >> 9n); // 19
    expect(snipeTaxBps(s, false, 1_003n)).toBe(0n);
    expect(snipeTaxBps(s, true, 1_000n)).toBe(0n);
    expect(snipeTaxBps({ ...s, snipeTaxStartBps: 0n }, false, 1_000n)).toBe(0n);
  });

  it("snipe tax is capped so the buyer nets at least 1% and joins the fee bucket", () => {
    const s = freshCurveState(CFG);
    const q = quoteBuy(s, E, 9900n);
    expect(q.snipeTaxBps).toBe(10_000n - 100n - 0n - 100n); // 9800
    expect(q.snipeTax).toBe((E * 9800n) / 10_000n);
    expect(q.fee).toBe(E / 100n + q.snipeTax);
    expect(q.tokensOut < quoteBuy(s, E).tokensOut / 50n).toBe(true);
  });

  it("buy past the allocation is clamped to the sellable tokens and refunded", () => {
    const s = freshCurveState(CFG);
    const q = quoteBuy(s, 10n * E);
    expect(q.clamped).toBe(true);
    expect(q.tokensOut).toBe(sellableTokens(s));
    expect(q.spent + q.refund).toBe(10n * E);
    // ~4.2 ETH net reaches the threshold; gross = net / 0.99, rounded up.
    const net = getAmountIn(sellableTokens(s), CFG.phantomQuote, CFG.supply, 0n);
    expect(q.spent).toBe((net * 10_000n + 9_899n) / 9_900n);
    const after = applyBuy(s, q);
    expect(readyToGraduate(after)).toBe(true);
    expect(() => quoteBuy(after, E)).toThrow(AdapterError);
    expect(() => quoteSell(after, 1n)).toThrowError(/graduated/);
  });

  it("price-bound slippage rule matches the contract (quantity bound when not clamped)", () => {
    const s = freshCurveState(CFG);
    const q = quoteBuy(s, E);
    expect(buyPassesMin(q, E, q.tokensOut)).toBe(true);
    expect(buyPassesMin(q, E, q.tokensOut + 1n)).toBe(false);
    const c = quoteBuy(s, 10n * E);
    // Clamped: min is scaled by spent / received.
    const scaledMin = (c.tokensOut * 10n * E) / c.spent;
    expect(buyPassesMin(c, 10n * E, scaledMin)).toBe(true);
    expect(buyPassesMin(c, 10n * E, scaledMin + 10n ** 9n)).toBe(false);
  });

  it("sell: fee and tax come off the quote output", () => {
    const s = applyBuy(freshCurveState(CFG), quoteBuy(freshCurveState(CFG), E));
    const r = { q: s.phantomQuote + s.trackedQuote - s.quoteFeeBalance - s.creatorTaxBalance, t: s.trackedTokens };
    const tokens = 10n ** 24n;
    const gross = getAmountOut(tokens, r.t, r.q, 0n);
    const sq = quoteSell(s, tokens);
    expect(sq.fee).toBe(gross / 100n);
    expect(sq.quoteOut).toBe(gross - gross / 100n);
  });

  it("dust and zero inputs map to bad_request / slippage like the contract reverts", () => {
    const s = freshCurveState(CFG);
    expect(() => quoteBuy(s, 0n)).toThrowError(/> 0/);
    // 1 wei: fee rounds to 0, but out = 1 * supply / phantom > 0 at launch prices.
    expect(quoteBuy(s, 1n).tokensOut > 0n).toBe(true);
    const pricey: CurveState = { ...s, phantomQuote: 10n ** 30n, trackedTokens: 10n ** 6n, reservedTokens: 1n };
    const e = (() => {
      try {
        quoteBuy(pricey, 1n);
      } catch (x) {
        return x as AdapterError;
      }
      return null;
    })();
    expect(e?.code).toBe("slippage");
  });

  it("minOutWithSlippage and spot price", () => {
    expect(minOutWithSlippage(10_000n, 50n)).toBe(9_950n);
    expect(minOutWithSlippage(1n, 9_999n)).toBe(1n);
    expect(() => minOutWithSlippage(1n, 10_000n)).toThrow(RangeError);
    const sp = spot(freshCurveState(CFG));
    expect(sp.price).toBe("0.00000000168"); // 1.68 ETH / 1e9 tokens
    expect(sp.marketCap).toBe("1.68");
  });
});
