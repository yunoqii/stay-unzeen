import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "@/lib/history/crypto";
import { historyCsv, realizedSeries } from "./pnl-series";

const e = (id: string, kind: HistoryEntry["kind"], mint: string, ts: number, f: Partial<NonNullable<HistoryEntry["fill"]>>): HistoryEntry =>
  ({ id, kind, mint, symbol: mint, decimals: 6, submittedAt: ts - 1000, status: "executed", fill: { kind, ts, tokenAmount: "0", ...f } }) as HistoryEntry;

const H: HistoryEntry[] = [
  e("1", "buy", "A", 1_000, { tokenAmount: "1000000", zecSpent: "100000", solAmount: "1000000" }),
  e("2", "buy", "B", 2_000, { tokenAmount: "2000000", zecSpent: "200000" }),
  e("3", "sell", "A", 3_000, { tokenAmount: "500000", zecCredited: "80000" }), // +30 000
  e("4", "sell", "B", 4_000, { tokenAmount: "2000000", zecCredited: "150000" }), // −50 000
  e("5", "sell", "A", 5_000, { tokenAmount: "500000", zecCredited: "40000" }), // −10 000
];

describe("realizedSeries", () => {
  it("cumulates realized PnL over every token, one point per sell", () => {
    expect(realizedSeries(H).map((p) => [p.ts, Number(p.realizedZat)])).toEqual([
      [3_000, 30_000],
      [4_000, -20_000],
      [5_000, -30_000],
    ]);
  });
  it("ignores pending and expired entries", () => {
    expect(realizedSeries([{ ...H[2], status: "pending" } as HistoryEntry])).toEqual([]);
  });
});

describe("historyCsv", () => {
  it("one header, one row per entry, UTC times and UI units", () => {
    const csv = historyCsv(H.slice(0, 1));
    const [head, row] = csv.trim().split("\n");
    expect(head).toBe("time_utc,action,token,mint,token_amount,sol_amount,zec_spent,zec_received,via_order,status");
    expect(row).toBe("1970-01-01T00:00:01.000Z,buy,$A,A,1,0.001,0.00100000,,,executed");
  });
  it("quotes commas and defuses spreadsheet formulas", () => {
    const csv = historyCsv([{ ...H[0], symbol: '=HYPERLINK("x")' } as HistoryEntry]);
    expect(csv).toContain('"$=HYPERLINK(""x"")"'); // quotes escaped; starts with "$", so not a formula
    const evil = historyCsv([{ ...H[0], mint: "=cmd|' /C calc'!A0" } as HistoryEntry]);
    expect(evil).toContain("'=cmd|' /C calc'!A0");
  });
});
