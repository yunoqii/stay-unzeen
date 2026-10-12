import { describe, expect, it } from "vitest";
import { checkBid, creatorMaxTier, holdTierFor } from "./tiers";

const MAINNET = ["5000000", "10000000", "25000000", "50000000", "100000000", "250000000", "500000000", "1000000000"];
const b = (n: number) => BigInt(n);

describe("hold tiers", () => {
  it("picks the smallest tier covering the amount", () => {
    expect(holdTierFor(b(5_000_000), MAINNET)).toBe(b(5_000_000));
    expect(holdTierFor(b(30_000_000), MAINNET)).toBe(b(50_000_000));
    expect(holdTierFor(b(1_000_000_001), MAINNET)).toBeNull();
  });

  it("creator cap: smallest tier covering creatorMaxLamports at the buy rate", () => {
    // 1.5 SOL at 1.791 SOL/ZEC = 0.8375 ZEC -> tier 1 ZEC
    expect(creatorMaxTier(MAINNET, "1500000000", "1791000000")).toBe(b(100_000_000));
    expect(creatorMaxTier(MAINNET, null, "1791000000")).toBeNull();
    expect(creatorMaxTier(MAINNET, "999000000000", "1791000000")).toBe(b(1_000_000_000));
  });

  it("checkBid mirrors the server", () => {
    const base = { tiers: MAINNET, minActionZat: "100000", balanceZat: b(200_000_000), creatorCapZat: null, holdZat: null };
    expect(checkBid({ ...base, amountZat: null })).toEqual({ ok: false, reason: "empty" });
    expect(checkBid({ ...base, amountZat: b(1) })).toEqual({ ok: false, reason: "below_minimum" });
    expect(checkBid({ ...base, amountZat: b(30_000_000) })).toEqual({ ok: true, holdZat: b(50_000_000) });
    expect(checkBid({ ...base, amountZat: b(30_000_000), holdZat: b(100_000_000) })).toEqual({ ok: true, holdZat: b(100_000_000) });
    expect(checkBid({ ...base, amountZat: b(30_000_000), holdZat: b(25_000_000) }).ok).toBe(false);
    expect(checkBid({ ...base, amountZat: b(30_000_000), holdZat: b(123) }).ok).toBe(false);
    expect(checkBid({ ...base, amountZat: b(300_000_000) })).toEqual({ ok: false, reason: "insufficient_balance" });
    expect(checkBid({ ...base, amountZat: b(2_000_000_000) })).toEqual({ ok: false, reason: "above_max" });
    expect(checkBid({ ...base, amountZat: b(60_000_000), creatorCapZat: b(50_000_000) })).toEqual({ ok: false, reason: "creator_cap" });
  });
});
