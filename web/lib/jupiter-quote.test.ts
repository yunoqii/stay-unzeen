import { describe, expect, it } from "vitest";
import { quoteAgeMin, readQuote } from "./jupiter-quote";

const q = { inAmount: "123400000", outAmount: "2468000000", priceImpactPct: "0.4200", route: ["PumpSwap"], maxAmount: "25000000000", asOf: 1_000_000 };

describe("readQuote (v0.28 grid /api/quote)", () => {
  it("inAmount is our amount: the output as is, with the grid's top and age", () => {
    expect(readQuote(q, BigInt(123_400_000))).toEqual({ kind: "ok", amount: BigInt(123_400_000), out: BigInt(2_468_000_000), impactPct: 0.42, route: ["PumpSwap"], asOf: 1_000_000, maxAmount: BigInt(25_000_000_000) });
  });
  it("an answer for another amount (older server) is scaled", () => {
    expect(readQuote({ ...q, inAmount: "130000000", outAmount: "2600000000" }, BigInt(123_400_000))!.out).toBe(BigInt(2_468_000_000));
  });
  it("rejects unusable answers", () => {
    expect(readQuote({ ...q, inAmount: "0" }, BigInt(1))).toBeNull();
    expect(readQuote({ ...q, outAmount: "x" }, BigInt(1))).toBeNull();
    expect(readQuote(q, BigInt(0))).toBeNull();
  });
  it("age in whole minutes, never negative", () => {
    expect(quoteAgeMin(1_000_000, 1_000_000 + 7 * 60_000 + 59_000)).toBe(7);
    expect(quoteAgeMin(2_000_000, 1_000_000)).toBe(0);
  });
});
