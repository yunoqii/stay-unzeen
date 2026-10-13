// Display helpers for Verify: exact bigint amounts, grouped, trimmed to a few decimals for tables.

import type { AssetId } from "@/lib/api/types";
import { formatUnits, shortAddr } from "@/lib/format";

/** Base units -> "12,345.678" (at most `maxFrac` decimals, truncated, never rounded up). */
export function fmtAmount(v: bigint, decimals: number, maxFrac = 3): string {
  const s = formatUnits(v.toString(), decimals);
  const [int, frac = ""] = s.split(".");
  const f = frac.slice(0, maxFrac).replace(/0+$/, "");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmedAway = frac.length > maxFrac && /[1-9]/.test(frac.slice(maxFrac));
  // A tiny non-zero value must not read as zero.
  if (v > BigInt(0) && grouped === "0" && !f && trimmedAway) return `<0.${"0".repeat(Math.max(0, maxFrac - 1))}1`;
  return grouped + (f ? "." + f : "");
}

/** Ticker of an asset: "ZEC", "SOL" (creator fees owed), the token symbol when known, else a short mint. */
export function assetLabel(asset: AssetId, symbols: Map<string, string>): string {
  if (asset === "ZEC") return "ZEC";
  if (asset === "SOL") return "SOL";
  const s = symbols.get(asset);
  return s ? `$${s}` : shortAddr(asset, 4, 4);
}

const utc = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hourCycle: "h23" });

/** "12 Oct 2026, 00:00 UTC" */
export const fmtUtc = (ms: number) => `${utc.format(ms)} UTC`;

export const fmtPct = (bps: number) => `${(bps / 100).toFixed(bps >= 99_999 ? 0 : 1)}${bps >= 99_999 ? "+" : ""}%`;
