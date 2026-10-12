import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { formatUnits, maxInWithSlippage, minOutWithSlippage, parseUnits, spotPriceSol, toBN, toBig } from "../src/math";

describe("slippage", () => {
  it("min out rounds down", () => {
    expect(minOutWithSlippage(1_000_000n, 100)).toBe(990_000n);
    expect(minOutWithSlippage(999n, 50)).toBe(994n); // 994.005 -> 994
    expect(minOutWithSlippage(123n, 0)).toBe(123n);
    expect(minOutWithSlippage(123n, 10_000)).toBe(0n);
  });
  it("max in rounds up", () => {
    expect(maxInWithSlippage(1_000_000n, 100)).toBe(1_010_000n);
    expect(maxInWithSlippage(999n, 50)).toBe(1004n); // 1003.995 -> 1004
  });
  it("rejects bad bps", () => {
    expect(() => minOutWithSlippage(1n, -1)).toThrow(RangeError);
    expect(() => minOutWithSlippage(1n, 10_001)).toThrow(RangeError);
    expect(() => minOutWithSlippage(1n, 1.5)).toThrow(RangeError);
  });
});

describe("units", () => {
  it("formats", () => {
    expect(formatUnits(1_500_000_000n, 9)).toBe("1.5");
    expect(formatUnits(1n, 9)).toBe("0.000000001");
    expect(formatUnits(0n, 6)).toBe("0");
    expect(formatUnits(42n, 0)).toBe("42");
    expect(formatUnits(-2_500_000n, 6)).toBe("-2.5");
  });
  it("parses and round-trips", () => {
    expect(parseUnits("1.5", 9)).toBe(1_500_000_000n);
    expect(parseUnits("0.000001", 6)).toBe(1n);
    expect(parseUnits("7", 6)).toBe(7_000_000n);
    expect(() => parseUnits("0.0000001", 6)).toThrow(RangeError);
    expect(() => parseUnits("-1", 6)).toThrow(RangeError);
    for (const v of [0n, 1n, 123_456_789n, 10n ** 18n]) expect(parseUnits(formatUnits(v, 9), 9)).toBe(v);
  });
  it("BN <-> bigint beyond 2^53", () => {
    const big = 2n ** 64n - 1n;
    expect(toBig(toBN(big))).toBe(big);
    expect(toBN(5n).eq(new BN(5))).toBe(true);
    expect(() => toBN(-1n)).toThrow(RangeError);
  });
});

describe("spot price", () => {
  it("pump.fun initial curve: 30 SOL / 1.073B tokens", () => {
    // 30 SOL virtual / 1_073_000_000 tokens (6 dp) = 2.7958993e-8 SOL per token
    const p = spotPriceSol(30_000_000_000n, 1_073_000_000_000_000n, 6);
    expect(Number(p)).toBeCloseTo(30 / 1_073_000_000, 15);
  });
  it("zero token reserves", () => {
    expect(spotPriceSol(1n, 0n, 6)).toBe("0");
  });
});
