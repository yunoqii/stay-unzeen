import { describe, expect, it } from "vitest";
import type { TokenListItem } from "@/lib/api/types";
import { boardFromTokens, estimateEta, etaOf, formatEta, recordPrice, recordProgress, sparkOf } from "./board";

const now = 1_792_000_000_000;
const tok = (mint: string, o: Partial<TokenListItem>): TokenListItem =>
  ({ mint, symbol: mint, name: mint, venue: "pumpfun", status: "curve", decimals: 6, priceSol: "0.0000000003", marketCapSol: "30", createdAt: now - 60_000, quote: "SOL", unzeenLaunch: false, volume24hSol: "0", unzeenTrades24h: 0, ...o }) as TokenListItem;

describe("Pulse board (contract rules, fallback)", () => {
  it("columns: new < 70 % and <= 6 h; graduating >= 70 % by progress; graduated <= 24 h; one mint, one column", () => {
    const b = boardFromTokens(
      [
        tok("A", { curveProgressPct: "12.00" }),
        tok("B", { curveProgressPct: "88.00" }),
        tok("C", { curveProgressPct: "71.00" }),
        tok("D", { curveProgressPct: "5.00", createdAt: now - 7 * 3600_000 }),
        tok("E", { status: "graduated", createdAt: now - 3600_000 }),
        tok("F", { status: "graduated", createdAt: now - 25 * 3600_000 }),
      ],
      now,
    );
    expect(b.new.map((t) => t.mint)).toEqual(["A"]);
    expect(b.graduating.map((t) => t.mint)).toEqual(["B", "C"]);
    expect(b.graduated.map((t) => t.mint)).toEqual(["E"]);
    expect(b.graduatingPct).toBe(70);
    expect(b.new[0]).toMatchObject({ pool: true, holders: null });
  });

  it("ETA: the server's first; else the local pace (>= 2 samples over >= 120 s, rounded up to 10 s)", () => {
    expect(etaOf({ mint: "X", status: "curve", eta: { secs: 240 } })).toEqual({ secs: 240, local: false });
    const store = new Map();
    recordProgress("Y", 50, now, store);
    expect(estimateEta("Y", store)).toBeNull();
    recordProgress("Y", 52, now + 60_000, store);
    expect(estimateEta("Y", store)).toBeNull(); // < 120 s
    recordProgress("Y", 54, now + 120_000, store);
    expect(estimateEta("Y", store)).toBe(Math.ceil(((46 / 4) * 120) / 10) * 10);
    expect(etaOf({ mint: "Y", status: "curve" }, store)).toMatchObject({ local: true });
    expect(etaOf({ mint: "Y", status: "graduated" }, store)).toBeNull();
    const flat = new Map();
    recordProgress("Z", 40, now, flat);
    recordProgress("Z", 39, now + 200_000, flat);
    expect(estimateEta("Z", flat)).toBeNull(); // falling pace
    expect(formatEta(30)).toBe("< 1 min");
    expect(formatEta(240)).toBe("4 min");
    expect(formatEta(5400)).toBe("1 h 30 min");
  });

  it("sparkline samples stay in memory, oldest first", () => {
    const s = new Map();
    recordPrice("P", 1, now, s);
    recordPrice("P", 2, now + 15_000, s);
    recordPrice("P", 0, now + 30_000, s); // no price: ignored
    expect(sparkOf("P", s)).toEqual([1, 2]);
  });
});
