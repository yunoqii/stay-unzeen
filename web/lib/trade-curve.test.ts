// API v0.25 B2: the pump.fun curve impact, ported from core/ledger/src/curve.rs (same cases as its tests).
import { describe, expect, it } from "vitest";
import { curveBuyOut, curveReserves, curveSellOut, isqrt, PUMPFUN_CURVE, quoteSell } from "./trade";

// The AMM cases compare with core's fee-less math; the fee is checked on its own below.
const DEVNET = { ...PUMPFUN_CURVE.devnet, feeBps: 0 };
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

  it("live run 15.10: with the 1 % venue fee the default 1 % slippage covers the real sale", () => {
    const rate = { lamportsPerZec: "11557500000", source: "fixed" as const, ts: 0 };
    const q = quoteSell(BigInt("38100000000000"), rate, "0.000000000344", 6, 100, PUMPFUN_CURVE.devnet)!;
    expect(q.minZecOut <= BigInt(107_854)).toBe(true); // what the pool actually credited
    expect(q.zecOut > BigInt(105_000)).toBe(true); // and not absurdly low
  });
});
