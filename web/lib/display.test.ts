import { describe, expect, it } from "vitest";
import type { PoolInfo, Rates } from "@/lib/api/types";
import { mockRates } from "@/lib/api/mock";
import { formatUsd, makeDisplay, parseRates, ratesFromPool } from "./display";

const RATES: Rates = { zecUsd: "252.00", solUsd: "140.00", ethUsd: "3900.00", zecSol: "1.8", zecEth: "0.064615", approximate: true, ts: 1 };

describe("display rates", () => {
  it("parses the draft v0.18 answer", () => {
    const r = parseRates(RATES)!;
    expect(r.zecSol).toBe(1.8);
    expect(r.zecUsd).toBe(252);
    expect(r.source).toBe("rates");
  });

  it("derives ZEC/SOL from USD when the cross is missing, rejects zero and garbage", () => {
    expect(parseRates({ ...RATES, zecSol: "0" })!.zecSol).toBeCloseTo(1.8);
    expect(parseRates({ ...RATES, zecSol: "x", zecUsd: "0", solUsd: "0" })).toBeNull();
    expect(parseRates(null)).toBeNull();
  });

  it("falls back to the pool's mid rate, without USD", () => {
    const pool = { rate: { lamportsPerZec: "1800000000", lamportsPerZecBuy: "1", lamportsPerZecSell: "1", spreadBps: 0, source: "fixed", ts: 5 } } as unknown as PoolInfo;
    const r = ratesFromPool(pool)!;
    expect(r.zecSol).toBe(1.8);
    expect(r.zecUsd).toBeNull();
    expect(r.source).toBe("pool");
    expect(ratesFromPool({ ...pool, rates: RATES } as PoolInfo)!.source).toBe("rates");
  });

  it("mock rates stay near the pool's mid rate and are the same within a minute", () => {
    const a = mockRates(1_760_000_000_000);
    const b = mockRates(1_760_000_030_000 - (1_760_000_000_000 % 60_000));
    expect(Math.abs(Number(a.zecSol) / 1.8 - 1)).toBeLessThan(0.01);
    expect(Number(a.zecUsd)).toBeCloseTo(Number(a.solUsd) * Number(a.zecSol), 1);
    expect(b.ts % 60_000).toBe(0);
  });
});

describe("makeDisplay", () => {
  const r = parseRates(RATES);

  it("ZEC by default: SOL figures converted with ≈, ZEC figures as they are", () => {
    const d = makeDisplay("zec", r, false);
    expect(d.unit).toBe("ZEC");
    expect(d.converted).toBe(true);
    expect(d.sol(0.9)).toBeCloseTo(0.5);
    expect(d.zecUnit).toBe("ZEC");
    expect(d.zec(2)).toBe(2);
    expect(d.usd(2)).toBe(504);
  });

  it("native: SOL as it is, ZEC valuations converted to SOL", () => {
    const d = makeDisplay("native", r, false);
    expect(d.unit).toBe("SOL");
    expect(d.converted).toBe(false);
    expect(d.sol(0.9)).toBe(0.9);
    expect(d.zecUnit).toBe("SOL");
    expect(d.zecConverted).toBe(true);
    expect(d.zec(2)).toBeCloseTo(3.6);
    expect(d.usdOfSol(1)).toBe(140);
  });

  it("ZEC pick while the first rate loads: placeholder, never SOL labelled ZEC", () => {
    const d = makeDisplay("zec", null, true);
    expect(d.pending).toBe(true);
    expect(d.unit).toBe("ZEC");
    expect(d.sol(1)).toBeNull();
  });

  it("no rate at all: falls back to SOL rather than nothing", () => {
    const d = makeDisplay("zec", null, false);
    expect(d.unit).toBe("SOL");
    expect(d.converted).toBe(false);
    expect(d.sol(1)).toBe(1);
    expect(d.usd(1)).toBeNull();
  });
});

describe("formatUsd", () => {
  it("formats small hints", () => {
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatUsd(1234.5)).toBe("$1,235");
    expect(formatUsd(2_500_000)).toBe("$2.5M");
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(null)).toBe("—");
  });
});
