// Live devnet run (15.10): a plan that waits for a deposit was refused 422 insufficient_balance and the page said
// "Not enough ZEC on your balance", which reads wrong for such a plan. The start minimum is now stated up front.
import { describe, expect, it } from "vitest";
import { startBalanceShort } from "./describe";

describe("startBalanceShort", () => {
  it("under minActionZat: explains that even a deposit-first plan needs it", () => {
    expect(startBalanceShort("92447", "100000")).toMatch(/at least 0\.001 ZEC available.*even one that waits for a deposit/);
  });
  it("at or above the minimum, or unknown: nothing to say", () => {
    expect(startBalanceShort("100000", "100000")).toBeNull();
    expect(startBalanceShort(null, "100000")).toBeNull();
    expect(startBalanceShort("5", undefined)).toBeNull();
  });
});
