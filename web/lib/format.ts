import type { Venue } from "./api/types";

export const VENUE_LABEL: Record<Venue, string> = {
  pumpfun: "pump.fun",
  "meteora-dbc": "Meteora",
  jupiter: "Jupiter",
};

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** 1234567 -> "1.2M" */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < 1000) return trimNumber(n, n < 1 ? 4 : 2);
  return compact.format(n);
}

/** Up to `digits` fraction digits, trailing zeros removed. */
export function trimNumber(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(n);
}

export function formatSol(v: string | number): string {
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (Math.abs(n) < 0.0001) return n.toExponential(2);
  return trimNumber(n, n < 1 ? 4 : 2);
}

/** Tiny prices like 0.00000034 -> "0.0₆34" (subscript zero count). */
export function formatPrice(v: string | number): string {
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 0.001) return trimNumber(n, 6);
  const [, frac = ""] = n.toFixed(20).split(".");
  const zeros = frac.match(/^0*/)?.[0].length ?? 0;
  const sig = frac.slice(zeros, zeros + 3).replace(/0+$/, "");
  const sub = String(zeros)
    .split("")
    .map((d) => "₀₁₂₃₄₅₆₇₈₉"[Number(d)])
    .join("");
  return `0.0${sub}${sig}`;
}

export function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function shortAddr(a: string, head = 4, tail = 4): string {
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function explorerTx(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}
