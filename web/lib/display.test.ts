import { describe, expect, it } from "vitest";
import type { PoolInfo, Rates } from "@/lib/api/types";
import { mockRates, mockRatesFor } from "@/lib/api/mock";
import { formatUsd, makeDisplay, parseRates, ratesFromPool } from "./display";

// Live 1Click values of 16.10.
const RATES: Rates = { usd: { ZEC: "1233", SOL: "106", ETH: "2456" }, pairs: { "ZEC/SOL": "11.59", "ZEC/ETH": "0.502" }, approximate: true, source: "near-1click", ts: 1 };

describe("display rates", () => {
  it("parses the v0.18 answer", () => {
    const r = parseRates(RATES)!;
    expect(r.zecSol).toBe(11.59);
    expect(r.zecUsd).toBe(1233);
    expect(r.source).toBe("rates");
  });

  it("derives ZEC/SOL from USD when the cross is missing, rejects zero and garbage", () => {
    expect(parseRates({ ...RATES, pairs: { ...RATES.pairs, "ZEC/SOL": "0" } })!.zecSol).toBeCloseTo(1233 / 106);
    expect(parseRates({ ...RATES, pairs: { "ZEC/SOL": "x", "ZEC/ETH": "0" }, usd: { ZEC: "0", SOL: "0", ETH: "0" } })).toBeNull();
    expect(parseRates(null)).toBeNull();
  });

  it("falls back to the pool's mid rate, without USD", () => {
    const pool = { rate: { lamportsPerZec: "11590000000", lamportsPerZecBuy: "1", lamportsPerZecSell: "1", spreadBps: 0, source: "fixed", ts: 5 } } as unknown as PoolInfo;
    const r = ratesFromPool(pool)!;
    expect(r.zecSol).toBe(11.59);
    expect(r.zecUsd).toBeNull();
    expect(r.source).toBe("pool");
  });

  it("offline mock rates: the 16.10 values, marked offline, the same within a minute", () => {
    const a = mockRates(1_760_000_000_000);
    expect(a.usd).toEqual({ ZEC: "1233", SOL: "106", ETH: "2456" });
    expect(a.pairs).toEqual({ "ZEC/SOL": "11.59", "ZEC/ETH": "0.502" });
    expect(a.offline).toBe(true);
    expect(a.ts % 60_000).toBe(0);
    expect(parseRates(a)!.source).toBe("offline");
  });

  it("mock mode asks our own API first and only falls back when it is out of reach", async () => {
    const live = { usd: { ZEC: "1240.5", SOL: "107", ETH: "2460" }, pairs: { "ZEC/SOL": "11.6", "ZEC/ETH": "0.5043" }, approximate: true, source: "near-1click", ts: 7 };
    const calls: string[] = [];
    const ok = (async (u: string) => (calls.push(String(u)), new Response(JSON.stringify(live), { status: 200 }))) as unknown as typeof fetch;
    const r = await mockRatesFor("devnet", 0, ok, "http://127.0.0.1:8080");
    expect(calls).toEqual(["http://127.0.0.1:8080/api/rates"]); // our API only, never a third party
    expect(r.usd.ZEC).toBe("1240.5");
    expect(parseRates(r)!.source).toBe("rates");
    const down = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    expect((await mockRatesFor("devnet", 0, down, "http://127.0.0.1:8080")).offline).toBe(true);
    const boom = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    expect((await mockRatesFor("devnet", 0, boom, "http://127.0.0.1:8080")).offline).toBe(true);
    const never = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
    expect((await mockRatesFor("devnet", 0, never, "")).offline).toBe(true); // no API configured: no request at all
  });
});

describe("makeDisplay", () => {
  const r = parseRates(RATES);

  it("ZEC by default: SOL figures converted with ≈, ZEC figures as they are", () => {
    const d = makeDisplay("zec", r, false);
    expect(d.unit).toBe("ZEC");
    expect(d.converted).toBe(true);
    expect(d.sol(1.159)).toBeCloseTo(0.1);
    expect(d.zecUnit).toBe("ZEC");
    expect(d.zec(2)).toBe(2);
    expect(d.usd(2)).toBe(2466);
  });

  it("native: SOL as it is, ZEC valuations converted to SOL", () => {
    const d = makeDisplay("native", r, false);
    expect(d.unit).toBe("SOL");
    expect(d.converted).toBe(false);
    expect(d.sol(0.9)).toBe(0.9);
    expect(d.zecUnit).toBe("SOL");
    expect(d.zecConverted).toBe(true);
    expect(d.zec(2)).toBeCloseTo(23.18);
    expect(d.usdOfSol(1)).toBe(106);
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

describe("display on Robinhood Chain (v0.18)", () => {
  it("converts ETH figures with ZEC/ETH and labels the native coin ETH", () => {
    const r = parseRates(RATES);
    const d = makeDisplay("native", r, false, "ETH");
    expect(d.unit).toBe("ETH");
    const z = makeDisplay("zec", r, false, "ETH");
    expect(z.unit).toBe("ZEC");
    expect(z.sol(0.502)).toBeCloseTo(1, 6);
    expect(z.usdOfSol(1)).toBe(2456);
  });

  it("falls back to the pool's wei-per-ZEC rate", () => {
    const pool = { chain: { id: "hood", network: "hood", mainnet: true, native: { symbol: "ETH", decimals: 18 } }, rate: { lamportsPerZec: "502000000000000000", ts: 1 } } as unknown as PoolInfo;
    expect(ratesFromPool(pool)).toMatchObject({ zecEth: 0.502, zecSol: null });
  });
});
