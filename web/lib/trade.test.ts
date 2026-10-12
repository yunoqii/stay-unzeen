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
    expect(q.lamports).toBe(BigInt(200_000_000));
    expect(q.tokensOut).toBe(BigInt("200000000000"));
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
