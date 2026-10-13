// v0.17 ActionStatus.parts of a token withdrawal: what each part is doing, for the M4 view.
import type { WithdrawPart } from "@/lib/api/types";

export type PartState = "travel" | "due" | "sent" | "confirmed" | "failed";

/** What a part is doing now. The whole action settling overrides the (one-time) part statuses. */
export function partState(p: Pick<WithdrawPart, "notBefore" | "status">, now: number, settled: "executed" | "failed" | null): PartState {
  if (settled === "executed" || p.status === "confirmed") return "confirmed";
  if (p.status === "failed" || settled === "failed") return "failed";
  if (p.status === "sent") return "sent";
  return now >= p.notBefore ? "due" : "travel";
}

/** "3m 05s", "1h 12m", "40s" until `t`. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
