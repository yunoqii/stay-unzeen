import { describe, expect, it } from "vitest";
import { isPriceStale, PRICE_SLACK_S } from "./trade";

describe("v0.23 isPriceStale (hood: block buy / sell before a sure 503 stale_price)", () => {
  const now = 1_791_763_200_000;
  it("no priceTs = no price = stale", () => {
    expect(isPriceStale(undefined, 300, now)).toBe(true);
    expect(isPriceStale(Number.NaN, 300, now)).toBe(true);
  });
  it("older than priceMaxAgeSecs − 20 s is stale (rounding and clock skew margin)", () => {
    expect(isPriceStale(now - (300 - PRICE_SLACK_S) * 1000, 300, now)).toBe(false);
    expect(isPriceStale(now - (300 - PRICE_SLACK_S) * 1000 - 1, 300, now)).toBe(true);
    expect(isPriceStale(now - 10_000, 300, now)).toBe(false);
  });
  it("without the pool field the server default (300 s) applies", () => {
    expect(isPriceStale(now - 279_000, undefined, now)).toBe(false);
    expect(isPriceStale(now - 281_000, undefined, now)).toBe(true);
    expect(isPriceStale(now - 100_000, 120, now)).toBe(false);
    expect(isPriceStale(now - 101_000, 120, now)).toBe(true);
  });
});
