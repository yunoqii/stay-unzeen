// Pure updates of the local history from the regular portfolio poll (Portfolio.actions).

import type { ActionKind, ActionStatus } from "@/lib/api/types";
import type { Fill } from "@/lib/pnl";
import type { HistoryEntry } from "./crypto";

/** The server erases amounts and fill 24-48 h after an action closes (docs/API.md D1). */
export const EXPIRE_MS = 48 * 3_600_000;
/** Settled entries kept per key and network; pending ones are always kept. */
export const MAX_SETTLED = 500;

export const HISTORY_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>(["buy", "sell", "create", "withdraw_token"]);

type Polled = ActionStatus & { id: string };

/**
 * Settle pending entries with what the poll returned. Executed + fill -> executed (fill kept, at
 * `executedAt`, or at `now` if the server did not send it); failed -> dropped (nothing moved); gone from the list or executed without fill after
 * EXPIRE_MS -> expired. Returns the same array when nothing changed.
 */
export function applyStatuses(entries: HistoryEntry[], polled: readonly Polled[] | undefined, now: number): HistoryEntry[] {
  const byId = new Map((polled ?? []).map((a) => [a.id, a]));
  let changed = false;
  const out: HistoryEntry[] = [];
  for (const e of entries) {
    if (e.status !== "pending") {
      out.push(e);
      continue;
    }
    const hit = byId.get(e.id);
    if (hit?.status === "failed") {
      changed = true;
      continue;
    }
    if (hit?.status === "executed" && hit.fill) {
      const f = hit.fill;
      // executedAt (v0.5) is rounded to the minute by the server; older servers: when we saw it.
      const fill: Fill = { kind: e.kind, ts: typeof hit.executedAt === "number" ? hit.executedAt : now, tokenAmount: f.tokenAmount };
      if (f.solAmount !== undefined) fill.solAmount = f.solAmount;
      if (f.quoteAmount !== undefined) fill.quoteAmount = f.quoteAmount;
      if (f.zecSpent !== undefined) fill.zecSpent = f.zecSpent;
      if (f.zecCredited !== undefined) fill.zecCredited = f.zecCredited;
      if (e.via) fill.via = e.via;
      // solanaTx is deliberately not copied: it would tie this device to an on-chain tx (T4).
      out.push({ ...e, mint: e.mint ?? f.mint, status: "executed", fill });
      changed = true;
      continue;
    }
    if (now - e.submittedAt > EXPIRE_MS) {
      out.push({ ...e, status: "expired" });
      changed = true;
      continue;
    }
    out.push(e);
  }
  return changed ? trim(out) : entries;
}

/** Add a just-accepted action (idempotent by id). */
export function addPending(entries: HistoryEntry[], entry: Omit<HistoryEntry, "status" | "fill">): HistoryEntry[] {
  if (entries.some((e) => e.id === entry.id)) return entries;
  return trim([...entries, { ...entry, status: "pending" }]);
}

function trim(entries: HistoryEntry[]): HistoryEntry[] {
  const settled = entries.filter((e) => e.status !== "pending");
  if (settled.length <= MAX_SETTLED) return entries;
  const drop = new Set(
    [...settled]
      .sort((a, b) => (a.fill?.ts ?? a.submittedAt) - (b.fill?.ts ?? b.submittedAt))
      .slice(0, settled.length - MAX_SETTLED)
      .map((e) => e.id),
  );
  return entries.filter((e) => !drop.has(e.id));
}

/** Executed fills of one mint, for lib/pnl.ts. */
export function fillsOf(entries: readonly HistoryEntry[], mint: string): Fill[] {
  return entries.filter((e) => e.status === "executed" && e.mint === mint && e.fill).map((e) => e.fill!);
}

/** Actions of this mint the server dropped before we saw them settle. */
export function expiredCount(entries: readonly HistoryEntry[], mint: string): number {
  return entries.filter((e) => e.status === "expired" && (e.mint === mint || (e.kind === "create" && !e.mint))).length;
}
