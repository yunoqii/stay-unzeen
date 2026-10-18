import { describe, expect, it } from "vitest";
import type { PoolInfo } from "@/lib/api/types";
import { buildQuickBuy } from "./quick-buy";

const pool = {
  minActionZat: "100000",
  rate: { lamportsPerZec: "11590000000", lamportsPerZecBuy: "11532000000", lamportsPerZecSell: "11648000000", spreadBps: 50, source: "fixed", ts: 1 },
  venues: [{ venue: "pumpfun", trade: true, create: true, quotes: ["SOL"], atomicFirstBuy: true, creatorFees: true, mainnetOnly: false, curve: { virtualSol: "300000000", virtualTokens: "1073000000000000", feeBps: 125 } }],
} as unknown as PoolInfo;
const token = { mint: "M", venue: "pumpfun" as const, status: "curve" as const, decimals: 6, priceSol: "0.000000000344", quote: "SOL" as const };

describe("buildQuickBuy (cards)", () => {
  it("builds a buy with a real price limit, on the curve", () => {
    const r = buildQuickBuy({ token, preset: "0.1", pool, last: null, slippageBps: 100, balanceZat: BigInt(50_000_000) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action).toMatchObject({ op: "buy", venue: "pumpfun", mint: "M", zecIn: "10000000" });
      expect(BigInt(r.action.minOut) > BigInt(0)).toBe(true);
      expect(BigInt(r.action.minOut) < r.quote.tokensOut).toBe(true);
    }
  });
  it("refuses what the panel refuses", () => {
    expect(buildQuickBuy({ token, preset: "0.0005", pool, last: null, slippageBps: 100, balanceZat: null })).toMatchObject({ ok: false });
    expect(buildQuickBuy({ token, preset: "1", pool, last: null, slippageBps: 100, balanceZat: BigInt(1000) })).toMatchObject({ ok: false, reason: "More than your ZEC balance." });
    expect(buildQuickBuy({ token: { ...token, priceSol: "0" }, preset: "0.1", pool, last: null, slippageBps: 100, balanceZat: null })).toMatchObject({ ok: false });
    expect(buildQuickBuy({ token: { ...token, quote: "ZEC" as never }, preset: "0.1", pool, last: null, slippageBps: 100, balanceZat: null })).toMatchObject({ ok: false });
  });
  it("graduated tokens route through Jupiter at spot", () => {
    const r = buildQuickBuy({ token: { ...token, status: "graduated" }, preset: "0.1", pool, last: null, slippageBps: 100, balanceZat: null });
    expect(r.ok && r.action.venue).toBe("jupiter");
  });
});
