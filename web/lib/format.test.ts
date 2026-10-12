import { describe, expect, it } from "vitest";
import { formatUnits, formatZec, lamportsToSol, parseUnits, unitsToNumber, zatToZec } from "./format";

describe("base units", () => {
  it("formats exactly", () => {
    expect(formatUnits("1234567890", 6)).toBe("1234.56789");
    expect(formatUnits("1", 9)).toBe("0.000000001");
    expect(formatUnits("1000000", 6)).toBe("1");
    expect(formatUnits("0", 6)).toBe("0");
    expect(formatUnits("123456789012345678901234", 9)).toBe("123456789012345.678901234");
    expect(formatUnits("42", 0)).toBe("42");
  });

  it("converts lamports and zatoshis", () => {
    expect(lamportsToSol("400000000")).toBe(0.4);
    expect(zatToZec("5000000")).toBe(0.05);
    expect(unitsToNumber("1200000000000", 6)).toBe(1_200_000);
  });

  it("parses UI amounts into base units", () => {
    expect(parseUnits("1.5", 8)).toBe("150000000");
    expect(parseUnits("0.00000001", 8)).toBe("1");
    expect(parseUnits(".5", 9)).toBe("500000000");
    expect(parseUnits("0", 6)).toBe("0");
    expect(() => parseUnits("0.000000001", 8)).toThrow();
    expect(() => parseUnits("1e3", 8)).toThrow();
  });
});

describe("formatZec", () => {
  it("is exact and grouped", () => {
    expect(formatZec("123456789012")).toBe("1,234.56789012");
    expect(formatZec("10000000")).toBe("0.1");
    expect(formatZec("0")).toBe("0");
    expect(formatZec("100000000000000")).toBe("1,000,000");
  });
});
