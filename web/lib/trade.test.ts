import { describe, expect, it } from "vitest";
import {
  amountsMatch,
  isSolanaAddress,
  lamportsToTokens,
  parseDecimal,
  quoteBuy,
  quoteSell,
  tokensToLamports,
  withdrawTokenFee,
  withSlippage,
} from "./trade";

const rate = (lamportsPerZec: string) => ({ lamportsPerZec, source: "fixed" as const, ts: 0 });

describe("trade math", () => {
  it("parses plain and e-notation decimals exactly", () => {
    expect(parseDecimal("0.00000034")).toEqual({ num: BigInt(34), scale: 8 });
    expect(parseDecimal("3.400e-7")).toEqual({ num: BigInt(3400), scale: 10 });
    expect(parseDecimal("12")).toEqual({ num: BigInt(12), scale: 0 });
    expect(parseDecimal("1e3")).toEqual({ num: BigInt(1000), scale: 0 });
    expect(parseDecimal("abc")).toBeNull();
  });

  it("converts tokens <-> lamports at a price", () => {
    // 1e-6 SOL per whole token, 6 decimals: 1e12 base units = 1e6 tokens = 1 SOL (same as core estimate test)
    expect(tokensToLamports(BigInt("1000000000000"), "0.000001", 6)).toBe(BigInt(1_000_000_000));
    expect(lamportsToTokens(BigInt(1_000_000_000), "0.000001", 6)).toBe(BigInt("1000000000000"));
    expect(lamportsToTokens(BigInt(1), "0", 6)).toBe(BigInt(0));
  });

  it("quotes a buy with slippage", () => {
    // 0.1 ZEC at 2 SOL/ZEC = 0.2 SOL; at 1e-6 SOL/token -> 200k tokens (6 dp)
    const q = quoteBuy(BigInt(10_000_000), rate("2000000000"), "0.000001", 6, 100)!;
    // D10: 0.2 SOL trimmed by the mid 0.5 % -> 0.199 SOL after the 0.001 step; the limit stays on the full 0.2 SOL.
    expect(q.lamports).toBe(BigInt(199_000_000));
    expect(q.tokensOut).toBe(BigInt("199000000000"));
    expect(q.minOut).toBe(BigInt("198000000000"));
    expect(quoteBuy(BigInt(1), null, "1", 6, 100)).toBeNull();
  });

  it("quotes a sell with slippage", () => {
    const q = quoteSell(BigInt("200000000000"), rate("2000000000"), "0.000001", 6, 50)!;
    expect(q.zecOut).toBe(BigInt(10_000_000));
    expect(q.minZecOut).toBe(withSlippage(BigInt(10_000_000), 50));
  });

  it("prices withdraw_token gas per part", () => {
    expect(withdrawTokenFee(1, null)).toEqual({ lamports: BigInt(4_100_000), zat: null });
    // 4.1e6 lamports at 2 SOL/ZEC = 0.00205 ZEC = 205000 zat
    expect(withdrawTokenFee(1, rate("2000000000")).zat).toBe(BigInt(205_000));
    expect(withdrawTokenFee(3, rate("3000000000")).zat).toBe(BigInt(410_000));
  });

  it("validates Solana addresses", () => {
    expect(isSolanaAddress("So11111111111111111111111111111111111111112")).toBe(true);
    expect(isSolanaAddress("11111111111111111111111111111111")).toBe(true);
    expect(isSolanaAddress("So11111111111111111111111111111111111111110")).toBe(false); // 0 not in base58
    expect(isSolanaAddress("abc")).toBe(false);
    expect(isSolanaAddress("t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU")).toBe(false);
  });

  it("flags amounts that match a recent buy", () => {
    expect(amountsMatch(BigInt(1000), BigInt(1000))).toBe(true);
    expect(amountsMatch(BigInt(1000), BigInt(985))).toBe(true);
    expect(amountsMatch(BigInt(1000), BigInt(900))).toBe(false);
    expect(amountsMatch(BigInt(0), BigInt(0))).toBe(false);
  });
});

describe("v0.17 copy rules", () => {
  it("A6: a sell mirrors one buy, their sum, or the whole position (core: |x − a| · 100 ≤ x)", async () => {
    const { sellMirrorsBuy } = await import("./trade");
    const buys = [BigInt(1_000_000), BigInt(2_000_000)];
    expect(sellMirrorsBuy(BigInt(1_010_000), buys, null)).toBe("buy");
    expect(sellMirrorsBuy(BigInt(1_011_000), buys, null)).toBeNull();
    expect(sellMirrorsBuy(BigInt(2_990_000), buys, null)).toBe("buy"); // the sum
    expect(sellMirrorsBuy(BigInt(5_000_000), [], BigInt(5_000_000))).toBe("position"); // sell 100 %
    expect(sellMirrorsBuy(BigInt(0), buys, BigInt(0))).toBeNull();
  });

  it("A2: only mainnet payouts above 1 ZEC are reviewed", async () => {
    const { payoutReviewed } = await import("./trade");
    expect(payoutReviewed("mainnet", BigInt(100_000_001))).toBe(true);
    expect(payoutReviewed("mainnet", "100000000")).toBe(false);
    expect(payoutReviewed("devnet", BigInt(500_000_000))).toBe(false);
  });

  it("A4: a Bags 503 reads as 'no curve yet', other venues keep the generic text", async () => {
    const { isBagsNotReady } = await import("./launch");
    expect(isBagsNotReady({ code: "venue_unavailable", status: 503 }, "bags")).toBe(true);
    expect(isBagsNotReady({ code: "venue_unavailable", status: 503 }, "pumpfun")).toBe(false);
  });
});
