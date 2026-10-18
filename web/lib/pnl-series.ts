// PnL over time and the CSV export, both computed from the encrypted local history on this device only
// (lib/history). Nothing is uploaded; the CSV is built in memory and saved by the browser.

import type { HistoryEntry } from "@/lib/history/crypto";
import { computePosition, type Fill } from "@/lib/pnl";
import { unitsToNumber } from "@/lib/format";

export interface PnlPoint {
  ts: number;
  /** Cumulative realized PnL across every token, zatoshis. */
  realizedZat: bigint;
}

/** Realized PnL after each sell, cumulated over all tokens, oldest first (weighted-average cost, as lib/pnl). */
export function realizedSeries(entries: readonly HistoryEntry[]): PnlPoint[] {
  const fills = entries
    .filter((e) => e.status === "executed" && e.mint && e.fill)
    .map((e) => ({ mint: e.mint!, fill: e.fill! }))
    .sort((a, b) => a.fill.ts - b.fill.ts);
  const perMint = new Map<string, Fill[]>();
  const realized = new Map<string, bigint>();
  let total = BigInt(0);
  const out: PnlPoint[] = [];
  for (const { mint, fill } of fills) {
    const list = perMint.get(mint) ?? [];
    list.push(fill);
    perMint.set(mint, list);
    if (fill.kind !== "sell") continue;
    const now = computePosition(list).realizedZat;
    total += now - (realized.get(mint) ?? BigInt(0));
    realized.set(mint, now);
    out.push({ ts: fill.ts, realizedZat: total });
  }
  return out;
}

const KIND: Record<HistoryEntry["kind"], string> = { buy: "buy", sell: "sell", create: "launch", withdraw_token: "withdraw tokens" };

const cell = (v: string | number | undefined) => {
  const s = v === undefined ? "" : String(v);
  // CSV injection guard: a cell a spreadsheet would read as a formula gets a leading quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const zec = (z?: string) => (z && /^\d+$/.test(z) ? (Number(z) / 1e8).toFixed(8) : "");

/** Your trades as CSV (UTC times, UI units). Settled and pending ones; expired ones are marked. */
export function historyCsv(entries: readonly HistoryEntry[], nativeSymbol = "SOL", nativeDecimals = 9): string {
  const head = ["time_utc", "action", "token", "mint", "token_amount", `${nativeSymbol.toLowerCase()}_amount`, "zec_spent", "zec_received", "via_order", "status"];
  const rows = [...entries]
    .sort((a, b) => (a.fill?.ts ?? a.submittedAt) - (b.fill?.ts ?? b.submittedAt))
    .map((e) => {
      const f = e.fill;
      const dec = e.decimals ?? 0;
      return [
        new Date(f?.ts ?? e.submittedAt).toISOString(),
        KIND[e.kind],
        e.symbol ? `$${e.symbol}` : "",
        e.mint ?? "",
        f && /^\d+$/.test(f.tokenAmount) && e.decimals !== undefined ? String(unitsToNumber(f.tokenAmount, dec)) : "",
        f?.solAmount ? String(unitsToNumber(f.solAmount, nativeDecimals)) : "",
        zec(f?.zecSpent),
        zec(f?.zecCredited),
        e.via ?? f?.via ?? "",
        e.status,
      ].map(cell);
    });
  return [head.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
}
