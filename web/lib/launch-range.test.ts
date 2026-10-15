// API v0.24: the first buy of create runs in the pool's published inclusive range.
import { describe, expect, it } from "vitest";
import type { PoolInfo } from "@/lib/api/types";
import { checkInitialBuy } from "./launch";
import { maxInitialBuyZat, minInitialBuyZat } from "./launch-rules";

const base = {
  minActionZat: "100000",
  rate: { lamportsPerZec: "1150000000", lamportsPerZecBuy: "1140000000", lamportsPerZecSell: "1160000000", spreadBps: 50, source: "fixed", ts: 0 },
  launchRules: {
    lockSecs: 300,
    capBps: 500,
    maxInitialBuyLamports: "14000000",
    maxInitialBuyLamportsByVenue: { pumpfun: "14000000", "meteora-dbc": "13000000" },
    minInitialBuyZat: "87720",
    maxInitialBuyZatByVenue: { pumpfun: "1315789", "meteora-dbc": "1228070", "raydium-launchlab": "0" },
  },
} as unknown as PoolInfo;

describe("v0.24 first-buy range", () => {
  it("reads the published range, not a client-side estimate", () => {
    expect(minInitialBuyZat(base)).toBe(BigInt(87_720));
    expect(maxInitialBuyZat(base, "pumpfun")).toBe(BigInt(1_315_789));
    expect(maxInitialBuyZat(base, "meteora-dbc")).toBe(BigInt(1_228_070));
  });

  it("is inclusive at both ends; below one step is below_minimum, not minActionZat", () => {
    expect(checkInitialBuy("0.0008772", base, "pumpfun")).toEqual({ ok: true, zat: BigInt(87_720) });
    expect(checkInitialBuy("0.00087719", base, "pumpfun").ok).toBe(false);
    expect(checkInitialBuy("0.01315789", base, "pumpfun")).toEqual({ ok: true, zat: BigInt(1_315_789) });
    expect(checkInitialBuy("0.0131579", base, "pumpfun").ok).toBe(false);
    // Below the old minActionZat (0.001) but at least one step: accepted now.
    expect(checkInitialBuy("0.0009", base, "pumpfun").ok).toBe(true);
  });

  it('"0" on a venue: no first buy there, a launch without one still passes', () => {
    expect(maxInitialBuyZat(base, "raydium-launchlab")).toBe(BigInt(0));
    const r = checkInitialBuy("0.001", base, "raydium-launchlab");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/No first buy/);
    expect(checkInitialBuy("", base, "raydium-launchlab")).toEqual({ ok: true, zat: null });
  });

  it("older servers without the fields: minActionZat and the lamport cap at the buy rate", () => {
    const old = { ...base, launchRules: { ...base.launchRules!, minInitialBuyZat: undefined, maxInitialBuyZatByVenue: undefined } } as PoolInfo;
    expect(minInitialBuyZat(old)).toBe(BigInt(100_000));
    expect(maxInitialBuyZat(old, "pumpfun")).toBe((BigInt(14_000_000) * BigInt(100_000_000)) / BigInt(1_140_000_000));
  });
});
