// Found on the live devnet run (15.10): the first trade after a reload was signed without a price limit, and
// a small sale went to the pool only to come back 422 below_minimum.
import { describe, expect, it } from "vitest";
import { quoteRate, quoteSell, saleBelowMinimum } from "./trade";

const pool = { rate: { lamportsPerZecBuy: "11400000000", lamportsPerZecSell: "11600000000", source: "fixed" as const, ts: 1 } };

describe("quoteRate", () => {
  it("prefers the rate of this tab's last order", () => {
    const last = { lamportsPerZec: "1", source: "near-1click" as const, ts: 2 };
    expect(quoteRate(last, pool, "buy")).toBe(last);
  });
  it("falls back to PoolInfo.rate, per side, so minOut is never 0 after a reload", () => {
    expect(quoteRate(null, pool, "buy")).toEqual({ lamportsPerZec: "11400000000", source: "fixed", ts: 1 });
    expect(quoteRate(null, pool, "sell")?.lamportsPerZec).toBe("11600000000");
    const q = quoteSell(BigInt("19389709366641"), quoteRate(null, pool, "sell"), "0.000000000344", 6, 100);
    expect(q && q.minZecOut > BigInt(0)).toBe(true);
  });
  it("no rate published: null (the panel says so), never a made-up one", () => {
    expect(quoteRate(null, {}, "buy")).toBeNull();
    expect(quoteRate(null, { rate: { ...pool.rate, lamportsPerZecBuy: "0" } }, "buy")).toBeNull();
  });
});

describe("saleBelowMinimum", () => {
  it("matches the pool's check: value at the current price under minActionZat", () => {
    expect(saleBelowMinimum(BigInt(59_000), BigInt(100_000))).toBe(true);
    expect(saleBelowMinimum(BigInt(100_000), BigInt(100_000))).toBe(false);
    expect(saleBelowMinimum(null, BigInt(100_000))).toBe(false);
    expect(saleBelowMinimum(BigInt(1), null)).toBe(false);
  });
});
