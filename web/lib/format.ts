import type { Venue } from "./api/types";
import { nativeOf } from "@/lib/network";

export const VENUE_LABEL: Record<Venue, string> = {
  pumpfun: "pump.fun",
  "meteora-dbc": "Meteora",
  jupiter: "Jupiter",
  "raydium-launchlab": "LaunchLab",
  bags: "Bags",
  pons: "Pons",
};

/**
 * Integer string in base units -> exact decimal string in UI units (no float rounding).
 * "1234567890", 6 -> "1234.56789"
 */
export function formatUnits(amount: string, decimals: number): string {
  if (!/^-?\d+$/.test(amount)) return "0";
  const neg = amount.startsWith("-");
  const digits = (neg ? amount.slice(1) : amount).replace(/^0+(?=\d)/, "");
  if (decimals === 0) return (neg ? "-" : "") + digits;
  const padded = digits.padStart(decimals + 1, "0");
  const int = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

/** Base units -> number, for display and charts only. Never use the result for amounts sent to the API. */
export function unitsToNumber(amount: string, decimals: number): number {
  return Number(formatUnits(amount, decimals));
}

export const SOL_DECIMALS = 9;
export const ZEC_DECIMALS = 8;

/** Native base units (lamports, or wei on Robinhood Chain — v0.18) -> number of the chain's coin. Display only. */
export const lamportsToSol = (lamports: string) => unitsToNumber(lamports, nativeOf().decimals);
export const zatToZec = (zat: string) => unitsToNumber(zat, ZEC_DECIMALS);

/**
 * UI decimal string -> integer base units string. Throws on bad input or too many decimals.
 * "1.5", 8 -> "150000000"
 */
export function parseUnits(value: string, decimals: number): string {
  const v = value.trim();
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(v)) throw new Error("Not a number");
  const [int = "", frac = ""] = v.split(".");
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimals`);
  const out = (int + frac.padEnd(decimals, "0")).replace(/^0+(?=\d)/, "");
  return out === "" ? "0" : out;
}

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
  // Tiny amounts (gas in ETH, dust): 0.0₄9 instead of 9.00e-5.
  if (Math.abs(n) < 0.0001) return (n < 0 ? "-" : "") + formatPrice(Math.abs(n));
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

/** Zatoshis -> exact ZEC with thousands separators: "123456789012" -> "1,234.56789012". */
export function formatZec(zat: string): string {
  const s = formatUnits(zat, ZEC_DECIMALS);
  const [int, frac] = s.split(".");
  const neg = int.startsWith("-");
  const grouped = (neg ? int.slice(1) : int).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (frac ? "." + frac : "");
}

const DAY_MS = 86_400_000;
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Day label for a timestamp rounded to the UTC day: "Today", "Yesterday", "Oct 12". */
export function formatDay(ts: number, now: number): string {
  const d = Math.floor(now / DAY_MS) - Math.floor(ts / DAY_MS);
  if (d <= 0) return "Today";
  if (d === 1) return "Yesterday";
  return dayFmt.format(ts);
}

/**
 * Stats amounts (volumes after the ZEC conversion): never a "0" that isn't zero. Under 0.01 reads "<0.01",
 * under 10 keeps up to 3 significant digits, larger ones one decimal, very large ones compact.
 */
export function formatStatAmount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (n < 0.01) return "<0.01";
  if (n < 10) return n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
  if (n >= 10_000) return formatCompact(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}
