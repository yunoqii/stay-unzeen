import { describe, expect, it } from "vitest";
import { isActive } from "@/components/layout/nav-items";

describe("isActive", () => {
  it("Feed is lit on the feed only, not on a token page", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/token/DfcMUcLAEDGpHgUm3R4qyAJZKJKoobtF6RCjGMYhbcnM", "/")).toBe(false);
    expect(isActive("/tokens", "/tokens")).toBe(true);
    expect(isActive("/token/x", "/tokens")).toBe(false);
  });
});
