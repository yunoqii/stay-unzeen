// API v0.26: the curve impact estimate, the formula of docs/API.md and core/ledger/src/curve.rs (same cases as its tests).
import { describe, expect, it } from "vitest";
import { curveBuyOut, curveMarketCap, curveOf, curveReserves, curveSellOut, effectiveFeeBps, isqrt, parseFeeTiers, quoteSell, tierBps, type CurveParams } from "./trade";

/** pump.fun devnet Global 15.10, fee off for the AMM cases (as core's DEVNET); the fee is checked on its own. */
const DEVNET: CurveParams = { virtualSol: BigInt(300_000_000), virtualTokens: BigInt("1073000000000000"), feeBps: 0 };
const POOL = { venues: [{ venue: "pumpfun", curve: { virtualSol: "300000000", virtualTokens: "1073000000000000", feeBps: 125 } }, { venue: "meteora-dbc" }] };
const K = DEVNET.virtualSol * DEVNET.virtualTokens;
const absDiff = (a: bigint, b: bigint) => (a > b ? a - b : b - a);
/** SOL per whole token (6 decimals) as a decimal string with 18 fraction digits: S/T · 10^6 / 10^9. */
function priceSol(s: bigint, t: bigint): string {
  const e18 = (s * BigInt(10) ** BigInt(15)) / t; // ×1e18 / 1e3
  const str = e18.toString().padStart(19, "0");
  return `${str.slice(0, -18)}.${str.slice(-18)}`;
}

describe("pump.fun curve impact (devnet 0.3 SOL / 1.073e15)", () => {
  it("isqrt is the floor square root", () => {
    for (const n of [0, 1, 2, 3, 4, 15, 16, 17].map(BigInt).concat([BigInt(10) ** BigInt(30)])) {
      const r = isqrt(n);
      expect(r * r <= n).toBe(true);
      expect((r + BigInt(1)) * (r + BigInt(1)) > n).toBe(true);
    }
  });

  it("reserves recovered from the spot price match the true ones; buy and sell match the exact AMM", () => {
    for (const spent of [0, 13_000_000, 583_000_000].map(BigInt)) {
      const s = DEVNET.virtualSol + spent;
      const t = K / s;
      const r = curveReserves(DEVNET, priceSol(s, t), 6)!;
      expect(absDiff(r.s, s) * BigInt(1_000_000) <= s).toBe(true);
      expect(absDiff(r.t, t) * BigInt(1_000_000) <= t).toBe(true);
      const a = BigInt("640000000000000") < t / BigInt(2) ? BigInt("640000000000000") : t / BigInt(2);
      const exact = (s * a) / (t + a);
      const est = curveSellOut(DEVNET, priceSol(s, t), 6, a)!;
      expect(absDiff(est, exact) * BigInt(10_000) <= exact).toBe(true);
      expect(est < (a * s) / t).toBe(true); // impact lowers the sell
      const x = BigInt(570_000_000);
      const exactBuy = (t * x) / (s + x);
      const estBuy = curveBuyOut(DEVNET, priceSol(s, t), 6, x)!;
      expect(absDiff(estBuy, exactBuy) * BigInt(10_000) <= exactBuy).toBe(true);
    }
  });

  it("run 15.10: a round trip sells at what the buy paid, not at the spot", () => {
    const s0 = BigInt(350_000_000);
    const t0 = K / s0;
    const x = BigInt(570_000_000);
    const bought = curveBuyOut(DEVNET, priceSol(s0, t0), 6, x)!;
    const s1 = s0 + x;
    const t1 = K / s1;
    const est = curveSellOut(DEVNET, priceSol(s1, t1), 6, bought)!;
    expect(absDiff(est, x) * BigInt(1_000) <= x).toBe(true);
    expect((bought * s1) / t1 > BigInt(2) * est).toBe(true);
  });

  it("the sell quote with the curve is lower than the spot one; bad input falls back to spot", () => {
    const rate = { lamportsPerZec: "11557500000", source: "fixed" as const, ts: 0 };
    const p = "0.000000000344";
    const spot = quoteSell(BigInt("38100000000000"), rate, p, 6, 100)!;
    const curve = quoteSell(BigInt("38100000000000"), rate, p, 6, 100, DEVNET)!;
    expect(curve.zecOut < spot.zecOut).toBe(true);
    expect(curveReserves(DEVNET, "0", 6)).toBeNull();
    expect(quoteSell(BigInt(1000), rate, "0", 6, 100, DEVNET)!.zecOut).toBe(BigInt(0));
  });

  it("fee as core (fee_lowers_both_sides): sell × (1 − fee), buy through net = x / (1 + fee)", () => {
    const s0 = DEVNET.virtualSol + BigInt(13_000_000);
    const t0 = K / s0;
    const p = priceSol(s0, t0);
    const fee = { ...DEVNET, feeBps: 125 };
    const a = BigInt("10000000000000");
    expect(curveSellOut(fee, p, 6, a)).toBe((curveSellOut(DEVNET, p, 6, a)! * BigInt(9_875)) / BigInt(10_000));
    const x = BigInt(50_000_000);
    const net = (x * BigInt(10_000)) / BigInt(10_125);
    expect(curveBuyOut(fee, p, 6, x)).toBe(curveBuyOut(DEVNET, p, 6, net));
    expect(curveBuyOut(fee, p, 6, x)! < curveBuyOut(DEVNET, p, 6, x)!).toBe(true);
  });

  it("parameters only from PoolInfo.venues[].curve; no row or a bad one: spot", () => {
    expect(curveOf(POOL, "pumpfun")).toEqual({ virtualSol: BigInt(300_000_000), virtualTokens: BigInt("1073000000000000"), feeBps: 125 });
    expect(curveOf(POOL, "meteora-dbc")).toBeNull();
    expect(curveOf({}, "pumpfun")).toBeNull();
    expect(curveOf({ venues: [{ venue: "pumpfun", curve: { virtualSol: "0", virtualTokens: "1", feeBps: 125 } }] }, "pumpfun")).toBeNull();
    expect(curveOf({ venues: [{ venue: "pumpfun", curve: { virtualSol: "1", virtualTokens: "1", feeBps: 10_000 } }] }, "pumpfun")).toBeNull();
  });

  it("live run 15.10: with the published 1.25 % fee the default 1 % slippage covers the real sale", () => {
    const rate = { lamportsPerZec: "11557500000", source: "fixed" as const, ts: 0 };
    const q = quoteSell(BigInt("38100000000000"), rate, "0.000000000344", 6, 100, curveOf(POOL, "pumpfun"))!;
    expect(q.minZecOut <= BigInt(107_854)).toBe(true); // what the pool actually credited
    expect(q.zecOut > BigInt(105_000)).toBe(true);
  });

  it("v0.27 fee tiers, as core fee_tiers_parse_and_select", () => {
    const t = parseFeeTiers([{ marketCapLamports: "0", bps: 125 }, { marketCapLamports: "420000000000", bps: 105 }])!;
    expect(tierBps(t, BigInt(0))).toBe(125);
    expect(tierBps(t, BigInt("419999999999"))).toBe(125);
    expect(tierBps(t, BigInt("420000000000"))).toBe(105);
    const below = [{ marketCapLamports: BigInt(10), bps: 90 }, { marketCapLamports: BigInt(20), bps: 80 }];
    expect(tierBps(below, BigInt(5))).toBe(90); // below the first threshold: first tier
    expect(parseFeeTiers([])).toBeNull();
    expect(parseFeeTiers([{ marketCapLamports: "5", bps: 1 }, { marketCapLamports: "5", bps: 2 }])).toBeNull();
    expect(parseFeeTiers([{ marketCapLamports: "0", bps: 9000 }])).toBeNull();
    // Market cap of the fresh devnet curve: 0.3 SOL × 1e15 / 1.073e15 ≈ 0.2796 SOL.
    const fresh = { ...DEVNET, tokenTotalSupply: BigInt("1000000000000000"), feeTiers: t };
    const p = priceSol(DEVNET.virtualSol, DEVNET.virtualTokens);
    expect(absDiff(curveMarketCap(fresh, p, 6)!, BigInt(279_589_934)) < BigInt(1_000)).toBe(true);
    expect(effectiveFeeBps(fresh, curveReserves(fresh, p, 6)!)).toBe(125);
    expect(effectiveFeeBps({ ...DEVNET }, curveReserves(DEVNET, p, 6)!)).toBe(0); // no tiers: feeBps
  });

  it("the tier, not feeBps, sets the fee once the market cap passes a threshold", () => {
    const c = curveOf({ venues: [{ venue: "pumpfun", curve: { virtualSol: "300000000", virtualTokens: "1073000000000000", feeBps: 125, tokenTotalSupply: "1000000000000000", feeSource: "chain", feeTiers: [{ marketCapLamports: "0", bps: 125 }, { marketCapLamports: "1000000000", bps: 50 }] } }] }, "pumpfun")!;
    const s = BigInt(800_000_000);
    const t = K / s;
    const p = priceSol(s, t); // market cap ≈ 0.8·1e15/(K/0.8) ≈ 1.99 SOL > 1 SOL
    const a = BigInt("10000000000000");
    expect(curveSellOut(c, p, 6, a)).toBe((curveSellOut(DEVNET, p, 6, a)! * BigInt(9_950)) / BigInt(10_000));
  });

  it("as core matches_devnet_trades: buy net and sell after 125 bps reproduce the chain", () => {
    const net = (BigInt(11_000_000) * BigInt(10_000)) / BigInt(10_125);
    expect(absDiff(net, BigInt(10_864_197)) <= BigInt(1)).toBe(true);
    const out = (BigInt(560_356_234) * BigInt(10_000 - 125)) / BigInt(10_000);
    expect(absDiff(out, BigInt(553_351_780)) <= BigInt(2)).toBe(true);
  });
});
