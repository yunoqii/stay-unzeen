import { describe, expect, it } from "vitest";
import { bareBytes, padExact, PAD_MIN } from "./pad";
import { COVER_MIN_MS, COVER_SPREAD_MS, coverEnabled, nextCoverDelay } from "./cover";

describe("R8 cover traffic", () => {
  it("waits 1-3 minutes between noops", () => {
    expect(nextCoverDelay(() => 0)).toBe(COVER_MIN_MS);
    expect(nextCoverDelay(() => 0.999999)).toBeLessThan(COVER_MIN_MS + COVER_SPREAD_MS);
    expect(COVER_MIN_MS + COVER_SPREAD_MS).toBe(180_000);
  });
  it("runs only when the server reports features.noop", () => {
    expect(coverEnabled(undefined)).toBe(false);
    expect(coverEnabled(true)).toBe(true);
  });
  it("a noop body is the same 1024 bytes as a buy", () => {
    expect(bareBytes({ op: "noop" })).toBeLessThan(PAD_MIN);
    expect(new TextEncoder().encode(JSON.stringify(padExact({ op: "noop" }))).length).toBe(PAD_MIN);
  });
});
