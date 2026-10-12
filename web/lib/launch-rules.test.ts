import { describe, expect, it } from "vitest";
import { maxInitialBuyZat, ruleText } from "./launch-rules";

describe("launch rules", () => {
  it("words the rules from the published numbers", () => {
    const r = { lockSecs: 86_400, capBps: 500, maxInitialBuyLamports: "1500000000" };
    expect(ruleText("creator_initial_buy_locked_24h", r)).toBe("Creator's initial buy locked for 24h");
    expect(ruleText("initial_buy_cap_5pct", r)).toBe("Creator capped at 5% of supply");
    expect(ruleText("authorities_revoked", r)).toBe("Mint & freeze authority revoked");
    expect(ruleText("initial_buy_cap_5pct", { ...r, capBps: 250 })).toBe("Creator capped at 2.5% of supply");
    expect(ruleText("creator_initial_buy_locked_24h", { ...r, lockSecs: 43_200 })).toBe("Creator's initial buy locked for 12h");
  });

  it("hides switched-off and unknown rules", () => {
    expect(ruleText("initial_buy_cap_5pct", { lockSecs: 0, capBps: 0, maxInitialBuyLamports: "0" })).toBeNull();
    expect(ruleText("something_new")).toBeNull();
  });

  it("caps the initial buy in ZEC at the buy rate", () => {
    // 1.5 SOL max at 1.791 SOL per ZEC -> floor(1.5 / 1.791 * 1e8) zat
    const pool = { launchRules: { lockSecs: 1, capBps: 1, maxInitialBuyLamports: "1500000000" }, rate: { lamportsPerZecBuy: "1791000000" } as never };
    expect(maxInitialBuyZat(pool)).toBe(BigInt(83752093));
    expect(maxInitialBuyZat({ launchRules: undefined, rate: undefined })).toBeNull();
  });
});
