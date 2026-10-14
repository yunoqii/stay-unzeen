// API v0.21 Portfolio: fixed 16 KiB, capped lists with "+N more", holdings pages of 20 by mint.

import { describe, expect, it } from "vitest";
import type { Portfolio } from "./types";
import { capPortfolio, PORTFOLIO_BYTES } from "./mock";

const mint = (i: number) => `M${String(i).padStart(3, "0")}`;
const full = (): Portfolio => ({
  zecBalance: "1",
  zecHeld: "0",
  frozen: false,
  holdings: Array.from({ length: 45 }, (_, i) => ({ mint: mint(44 - i), amount: "1000000000000000000000000000", held: "0" })),
  claimable: [],
  deposits: Array.from({ length: 9 }, (_, i) => ({ id: String(i), amountZat: "1", status: "credited", ts: 9 - i })),
  actions: Array.from({ length: 12 }, (_, i) => ({ id: String(i), status: i === 2 ? "queued" : "executed" })),
  orders: [],
});
const bytes = (p: Portfolio) => new TextEncoder().encode(JSON.stringify(p)).length;

describe("Portfolio v0.21", () => {
  it("holdings: 20 per page by mint, the rest counted in more.holdings", () => {
    const p0 = capPortfolio(full(), 0);
    expect(p0.holdings.map((h) => h.mint)).toEqual(Array.from({ length: 20 }, (_, i) => mint(i)));
    expect(p0.more?.holdings).toBe(25);
    const p2 = capPortfolio(full(), 2);
    expect(p2.holdings).toHaveLength(5);
    expect(p2.more?.holdings).toBe(0);
    expect(p2.holdingsPage).toBe(2);
  });

  it("caps the lists, queued actions first, and says how many are left out", () => {
    const p = capPortfolio(full(), 0);
    expect(p.deposits).toHaveLength(5);
    expect(p.more?.deposits).toBe(4);
    expect(p.actions).toHaveLength(8);
    expect(p.actions![0].status).toBe("queued");
    expect(p.more?.actions).toBe(4);
  });

  it("is exactly 16 KiB whatever the content", () => {
    expect(bytes(capPortfolio(full(), 0))).toBe(PORTFOLIO_BYTES);
    expect(bytes(capPortfolio({ ...full(), holdings: [], deposits: [], actions: [] }, 0))).toBe(PORTFOLIO_BYTES);
  });
});
