// The Pulse board (API v0.28): GET /api/pulse or /ws/pulse, the same answer for everyone. A server without it
// gets the board built here from the public token list, with the contract's rules. ETA: the server's
// (Token/PulseToken.eta), else an estimate from how fast the progress moved between this tab's polls.
// Sparklines: prices this tab saw on those same polls (memory only, never a per-token request).

import type { Pulse, PulseToken, TokenListItem } from "@/lib/api/types";

/** Contract defaults (UNZEEN_PULSE_GRADUATING_PCT, column size, windows). */
export const GRADUATING_PCT = 70;
export const COLUMN_MAX = 30;
const NEW_MAX_AGE_MS = 6 * 3600_000;
const GRADUATED_MAX_AGE_MS = 24 * 3600_000;

const pct = (t: { curveProgressPct?: string }) => {
  const n = Number(t.curveProgressPct);
  return t.curveProgressPct !== undefined && Number.isFinite(n) ? n : null;
};

/** A pool token as a Pulse card (no holders or safety in the list). */
export function toPulseToken(t: TokenListItem, now: number): PulseToken {
  return {
    mint: t.mint,
    symbol: t.symbol,
    name: t.name,
    image: t.image,
    venue: t.venue,
    status: t.status,
    decimals: t.decimals,
    quote: t.quote ?? "SOL",
    priceSol: t.priceSol,
    marketCapSol: t.marketCapSol,
    createdAt: t.createdAt,
    ...(t.curveProgressPct !== undefined ? { curveProgressPct: t.curveProgressPct } : {}),
    ...(t.eta ? { eta: t.eta } : {}),
    holders: null,
    unzeenLaunch: t.unzeenLaunch,
    pool: true,
    asOf: now,
  };
}

/** Client-side board from GET /api/tokens (a server before v0.28), same column rules as the server. */
export function boardFromTokens(list: readonly TokenListItem[], now: number, graduatingPct = GRADUATING_PCT): Pulse {
  const curve = list.filter((t) => t.status === "curve");
  const graduating = curve
    .filter((t) => (pct(t) ?? -1) >= graduatingPct)
    .sort((a, b) => (pct(b) ?? 0) - (pct(a) ?? 0) || b.createdAt - a.createdAt)
    .slice(0, COLUMN_MAX);
  const inGrad = new Set(graduating.map((t) => t.mint));
  const fresh = curve
    .filter((t) => !inGrad.has(t.mint) && now - t.createdAt <= NEW_MAX_AGE_MS)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, COLUMN_MAX);
  const graduated = list
    .filter((t) => t.status === "graduated" && now - t.createdAt <= GRADUATED_MAX_AGE_MS)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, COLUMN_MAX);
  const card = (t: TokenListItem) => toPulseToken(t, now);
  return { asOf: now, graduatingPct, etaWindowSecs: 600, new: fresh.map(card), graduating: graduating.map(card), graduated: graduated.map(card) };
}

// ---- samples of this tab's polls (memory only) ----

interface Sample {
  v: number;
  at: number;
}
type Store = Map<string, Sample[]>;
const progress: Store = new Map();
const prices: Store = new Map();
const KEEP_MS = 30 * 60_000;

function push(store: Store, mint: string, v: number, now: number, minGapMs: number, keep: number) {
  if (!Number.isFinite(v)) return;
  const list = (store.get(mint) ?? []).filter((s) => now - s.at <= KEEP_MS);
  const last = list[list.length - 1];
  if (!last || (last.v !== v && now - last.at >= 1000) || now - last.at >= minGapMs) list.push({ v, at: now });
  store.set(mint, list.slice(-keep));
}

/** Remember this poll's curve progress of a token. */
export function recordProgress(mint: string, progressPct: number, now: number, store: Store = progress) {
  push(store, mint, progressPct, now, 60_000, 20);
}

/** Remember this poll's price of a token (sparkline). */
export function recordPrice(mint: string, priceSol: number, now: number, store: Store = prices) {
  if (priceSol > 0) push(store, mint, priceSol, now, 30_000, 40);
}

/** Prices this tab saw, oldest first (empty until two polls). */
export function sparkOf(mint: string, store: Store = prices): number[] {
  return (store.get(mint) ?? []).map((s) => s.v);
}

/**
 * Seconds to 100 % at the pace seen, as the server computes it (rate over the window, >= 2 samples over >= 120 s,
 * positive pace, <= 7 days), or null.
 */
export function estimateEta(mint: string, store: Store = progress): number | null {
  const list = store.get(mint);
  if (!list || list.length < 2) return null;
  const a = list[0];
  const b = list[list.length - 1];
  const dt = (b.at - a.at) / 1000;
  const dp = b.v - a.v;
  if (dt < 120 || dp <= 0 || b.v >= 100) return null;
  const eta = Math.ceil((((100 - b.v) / dp) * dt) / 10) * 10;
  return eta > 7 * 86_400 ? null : eta;
}

/** The ETA a card shows: the server's when present, else the local estimate. */
export function etaOf(t: { mint: string; status: string; eta?: { secs: number } }, store?: Store): { secs: number; local: boolean } | null {
  if (t.status !== "curve") return null;
  if (t.eta && t.eta.secs >= 0) return { secs: t.eta.secs, local: false };
  const e = estimateEta(t.mint, store);
  return e === null ? null : { secs: e, local: true };
}

export function formatEta(secs: number): string {
  if (secs < 60) return "< 1 min";
  if (secs < 3600) return `${Math.round(secs / 60)} min`;
  if (secs < 86_400) {
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  return `${Math.round(secs / 86_400)} d`;
}

/** Every token on the board, once (watchlist lookups). */
export function boardTokens(b: Pulse | null): Map<string, PulseToken> {
  const m = new Map<string, PulseToken>();
  if (!b) return m;
  for (const t of [...b.graduated, ...b.new, ...b.graduating]) m.set(t.mint, t);
  return m;
}
