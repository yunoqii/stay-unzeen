import { describe, expect, it } from "vitest";
import { formatStatAmount } from "./format";

describe("formatStatAmount (Stats volumes after the ZEC conversion)", () => {
  it("never shows 0 for a non-zero volume", () => {
    expect(formatStatAmount(0)).toBe("0");
    expect(formatStatAmount(0.0087)).toBe("<0.01");
    expect(formatStatAmount(0.0874)).toBe("0.0874");
    expect(formatStatAmount(1.23456)).toBe("1.23");
  });
  it("keeps the old look for larger numbers", () => {
    expect(formatStatAmount(123.45)).toBe("123.5");
    expect(formatStatAmount(25_000)).toMatch(/^25(\.0)?K$/);
  });
});
