import { describe, expect, it } from "vitest";
import { scaleQuote } from "./jupiter-quote";

describe("scaleQuote (v0.28 /api/quote)", () => {
  it("scales Jupiter's answer for the rounded-up amount down to ours", () => {
    // Asked 0.1234 SOL -> server asked Jupiter for 0.12 SOL rounded UP = 0.13 SOL.
    expect(scaleQuote({ inAmount: "130000000", outAmount: "2600000000" }, BigInt(123_400_000))).toBe(BigInt(2_468_000_000));
  });
  it("rejects unusable answers", () => {
    expect(scaleQuote({ inAmount: "0", outAmount: "1" }, BigInt(1))).toBeNull();
    expect(scaleQuote({ inAmount: "10", outAmount: "x" }, BigInt(1))).toBeNull();
    expect(scaleQuote({ inAmount: "10", outAmount: "5" }, BigInt(0))).toBeNull();
  });
});
