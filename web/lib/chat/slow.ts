// R6 (chat.md §5.4): right after your own trade of a token, a message in its chat would land on the
// same or the next batch boundary and could be matched to that trade. So "slow" (published 2-5 min
// later, no public marker) is on by default when this browser saw an own action of this mint in the
// last 10 minutes. Judged only from local data (encrypted history + this tab's actions), never asked.

import { unitsToNumber } from "@/lib/format";

export const SLOW_WINDOW_MS = 10 * 60_000;
const DAY_MS = 24 * 3_600_000;

export interface OwnAction {
  mint?: string;
  submittedAt: number;
}

export function slowByDefault(own: readonly OwnAction[], mint: string, now: number): boolean {
  return own.some((a) => a.mint === mint && a.submittedAt <= now && now - a.submittedAt < SLOW_WINDOW_MS);
}

export interface OwnFill {
  submittedAt: number;
  decimals?: number;
  fill?: { tokenAmount?: string; solAmount?: string; zecSpent?: string; zecCredited?: string };
}

/** UI amounts (ZEC, SOL, tokens) of your own actions of the last 24 h, for the soft self-link warning. */
export function ownAmounts(entries: readonly OwnFill[], now: number): number[] {
  const out: number[] = [];
  for (const e of entries) {
    if (now - e.submittedAt > DAY_MS || !e.fill) continue;
    const f = e.fill;
    if (f.zecSpent) out.push(Number(f.zecSpent) / 1e8);
    if (f.zecCredited) out.push(Number(f.zecCredited) / 1e8);
    // v0.18: token / lamport amounts may exceed 2^53 — convert through the exact decimal string, not Number().
    if (f.solAmount) out.push(unitsToNumber(f.solAmount, 9));
    if (f.tokenAmount && e.decimals !== undefined) out.push(unitsToNumber(f.tokenAmount, e.decimals));
  }
  return out.filter((n) => Number.isFinite(n) && n > 0);
}
