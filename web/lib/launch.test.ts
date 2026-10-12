import { describe, expect, it } from "vitest";
import { checkInitialBuy, IMAGE_MAX_BYTES, normalizeSymbol, validateMeta } from "./launch";
import { maxInitialBuyZat } from "./launch-rules";

const pool = {
  minActionZat: "100000",
  launchRules: { lockSecs: 86_400, capBps: 500, maxInitialBuyLamports: "1500000000" },
  rate: { lamportsPerZec: "1800000000", lamportsPerZecBuy: "1791000000", lamportsPerZecSell: "1809000000", spreadBps: 50, source: "fixed" as const, ts: 0 },
};

describe("initial buy limit", () => {
  it("is maxInitialBuyLamports at the buy rate, rounded down", () => {
    // 1.5 SOL / 1.791 SOL per ZEC = 0.837520... ZEC
    expect(maxInitialBuyZat(pool)).toBe(BigInt(83_752_093));
  });

  it("accepts up to the limit, refuses above it", () => {
    expect(checkInitialBuy("", pool)).toEqual({ ok: true, zat: null });
    expect(checkInitialBuy("0.5", pool)).toEqual({ ok: true, zat: BigInt(50_000_000) });
    expect(checkInitialBuy("0.83752093", pool)).toEqual({ ok: true, zat: BigInt(83_752_093) });
    expect(checkInitialBuy("0.83752094", pool).ok).toBe(false);
    expect(checkInitialBuy("1", pool).ok).toBe(false);
  });

  it("enforces the minimum and the format", () => {
    expect(checkInitialBuy("0.0001", pool).ok).toBe(false);
    expect(checkInitialBuy("abc", pool).ok).toBe(false);
    expect(checkInitialBuy("0.123456789", pool).ok).toBe(false);
  });

  it("refuses a first buy while the pool publishes no limit", () => {
    expect(checkInitialBuy("0.1", { ...pool, launchRules: { ...pool.launchRules, maxInitialBuyLamports: "0" } }).ok).toBe(false);
    expect(checkInitialBuy("0.1", { ...pool, rate: undefined }).ok).toBe(false);
    expect(checkInitialBuy("", { ...pool, rate: undefined }).ok).toBe(true);
  });
});

describe("launch meta", () => {
  it("validates name, ticker and image", () => {
    expect(validateMeta({ name: "Shade", symbol: "SHADE", image: null })).toEqual({});
    expect(validateMeta({ name: " ", symbol: "", image: null })).toHaveProperty("name");
    expect(validateMeta({ name: "x".repeat(33), symbol: "A", image: null })).toHaveProperty("name");
    expect(validateMeta({ name: "x", symbol: "TOOLONGTICK", image: null })).toHaveProperty("symbol");
    expect(validateMeta({ name: "x", symbol: "A", image: "data:image/gif;base64,AAAA" })).toHaveProperty("image");
    expect(validateMeta({ name: "x", symbol: "A", image: "data:image/png;base64,iVBORw0KGgo=" })).toEqual({});
    expect(validateMeta({ name: "x", symbol: "A", image: "data:image/png;base64," + "A".repeat(IMAGE_MAX_BYTES) })).toHaveProperty("image");
    expect(normalizeSymbol("$pe-pe2025xyz")).toBe("PEPE2025XY");
  });
});

describe("initial buy limit per venue (v0.6)", () => {
  const byVenue = { ...pool, launchRules: { ...pool.launchRules, maxInitialBuyLamportsByVenue: { pumpfun: "1500000000", "meteora-dbc": "1496110113" } } };
  it("uses the venue's own cap, falling back to the pump.fun one", () => {
    expect(maxInitialBuyZat(byVenue, "meteora-dbc")).toBe((BigInt(1496110113) * BigInt(1e8)) / BigInt(1791000000));
    expect(maxInitialBuyZat(byVenue, "pumpfun")).toBe(BigInt(83_752_093));
    expect(maxInitialBuyZat(pool, "meteora-dbc")).toBe(BigInt(83_752_093));
    expect(checkInitialBuy("0.83752093", byVenue, "meteora-dbc").ok).toBe(false);
    expect(checkInitialBuy("0.83752093", byVenue, "pumpfun").ok).toBe(true);
  });
});
