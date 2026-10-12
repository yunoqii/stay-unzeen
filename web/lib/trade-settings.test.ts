import { describe, expect, it } from "vitest";
import { DEFAULTS, normalizePreset, parseSettings } from "./trade-settings";

describe("quick trade settings", () => {
  it("defaults: Buy 0.1 / 0.5 / 1 ZEC, Sell 25 / 50 / 100%, one-tap off", () => {
    expect(DEFAULTS.buyPresets).toEqual(["0.1", "0.5", "1"]);
    expect(DEFAULTS.sellPresets).toEqual([25, 50, 100]);
    expect(DEFAULTS.oneTap).toBe(false);
  });

  it("normalizes presets", () => {
    expect(normalizePreset("0.50")).toBe("0.5");
    expect(normalizePreset(".25")).toBe("0.25");
    expect(normalizePreset("001")).toBe("1");
    expect(normalizePreset("1,5")).toBe("1.5");
    expect(normalizePreset("0")).toBeNull();
    expect(normalizePreset("-1")).toBeNull();
    expect(normalizePreset("0.000000001")).toBeNull(); // 9 decimals
    expect(normalizePreset("1e3")).toBeNull();
    expect(normalizePreset("200000")).toBeNull();
  });

  it("falls back field by field on malformed storage", () => {
    expect(parseSettings(null)).toEqual(DEFAULTS);
    expect(parseSettings("{oops")).toEqual(DEFAULTS);
    expect(parseSettings(JSON.stringify({ buyPresets: ["1", "2"], oneTap: "yes", slippageBps: 0 }))).toEqual(DEFAULTS);
    expect(parseSettings(JSON.stringify({ buyPresets: ["0.2", "2", "5"], oneTap: true, slippageBps: 300 }))).toMatchObject({
      buyPresets: ["0.2", "2", "5"],
      oneTap: true,
      slippageBps: 300,
    });
  });
});
