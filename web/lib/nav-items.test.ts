import { describe, expect, it } from "vitest";
import { isActive, NAV } from "@/components/layout/nav-items";

describe("isActive", () => {
  it("Feed lives at /feed and is lit there only, not on a token page or the landing", () => {
    expect(NAV[0].href).toBe("/feed");
    expect(isActive("/feed", "/feed")).toBe(true);
    expect(isActive("/", "/feed")).toBe(false);
    expect(isActive("/token/DfcMUcLAEDGpHgUm3R4qyAJZKJKoobtF6RCjGMYhbcnM", "/feed")).toBe(false);
    expect(isActive("/tokens", "/tokens")).toBe(true);
    expect(isActive("/token/x", "/tokens")).toBe(false);
    expect(isActive("/docs/api", "/docs")).toBe(true);
    expect(isActive("/feedback", "/feed")).toBe(false);
  });
});
