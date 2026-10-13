// Display currency (owner decision 13.10): prices, market caps, volumes, trade sizes and PnL read in ZEC by
// default, the market's own currency. One switch flips them to the chain's native coin (SOL on Solana).
// Converted figures carry "≈" and use the public display rate (API v0.18, GET /api/rates), never the rate
// of an action: that one always comes from the action's own quote.
//
// Pure helpers here; React stores in lib/display-store.ts.

import type { PoolInfo, Rates } from "@/lib/api/types";
import { trimNumber } from "@/lib/format";

/** What the user picked. "native" = the coin of the chain the token lives on. */
export type DisplayPref = "zec" | "native";
export const DEFAULT_DISPLAY: DisplayPref = "zec";

/** Native coin of the chain. Only Solana today; other chains come behind a flag with their own coin. */
export type NativeCoin = "SOL";
export const NATIVE_COIN: NativeCoin = "SOL";

export type DisplayUnit = "ZEC" | NativeCoin;

/** Parsed display rates. USD figures may be unknown when only the pool's ZEC/SOL rate is available. */
export interface DisplayRates {
  /** SOL per 1 ZEC. */
  zecSol: number | null;
  zecUsd: number | null;
  solUsd: number | null;
  ethUsd: number | null;
  /** ETH per 1 ZEC. */
  zecEth: number | null;
  /** Unix ms of the server's refresh. */
  ts: number;
  /** "rates": the public display endpoint; "pool": fallback from PoolInfo.rate (mid), no USD. */
  source: "rates" | "pool";
}

const pos = (v: string | number | undefined | null): number | null => {
  const n = typeof v === "number" ? v : v === undefined || v === null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** API answer (v0.18 Rates) -> numbers. Garbage or zero fields become null (never a division by zero downstream). */
export function parseRates(r: Rates | null | undefined): DisplayRates | null {
  if (!r || typeof r !== "object") return null;
  const zecUsd = pos(r.usd?.ZEC);
  const solUsd = pos(r.usd?.SOL);
  const ethUsd = pos(r.usd?.ETH);
  const out: DisplayRates = {
    zecSol: pos(r.pairs?.["ZEC/SOL"]) ?? (zecUsd && solUsd ? zecUsd / solUsd : null),
    zecUsd,
    solUsd,
    ethUsd,
    zecEth: pos(r.pairs?.["ZEC/ETH"]) ?? (zecUsd && ethUsd ? zecUsd / ethUsd : null),
    ts: Number.isFinite(r.ts) ? r.ts : 0,
    source: "rates",
  };
  return out.zecSol || out.zecUsd ? out : null;
}

/** Fallback while GET /api/rates is unavailable (503 before the first data): the pool's mid ZEC/SOL rate, no USD. */
export function ratesFromPool(pool: PoolInfo | null | undefined): DisplayRates | null {
  if (!pool) return null;
  const lamports = pos(pool.rate?.lamportsPerZec);
  if (!lamports) return null;
  return { zecSol: lamports / 1e9, zecUsd: null, solUsd: null, ethUsd: null, zecEth: null, ts: pool.rate?.ts ?? 0, source: "pool" };
}

/**
 * How amounts are shown right now.
 * - `unit`: the unit of SOL-priced figures (price, market cap, volume, trade size of SOL pairs).
 * - `zecUnit`: the unit of ZEC figures that are a valuation (position value, PnL). Balances stay ZEC always.
 * - `pending`: the pick needs a rate that has not arrived yet: show a placeholder, not the wrong unit.
 */
export interface Display {
  pref: DisplayPref;
  unit: DisplayUnit;
  /** SOL figures are converted (≈). */
  converted: boolean;
  zecUnit: DisplayUnit;
  /** ZEC valuations are converted (≈). */
  zecConverted: boolean;
  pending: boolean;
  rates: DisplayRates | null;
  /** A SOL amount in `unit`, null while pending. */
  sol(n: number): number | null;
  /** A ZEC valuation in `zecUnit`, null while pending. */
  zec(n: number): number | null;
  /** USD of a ZEC amount, null without a USD rate. */
  usd(zecAmount: number): number | null;
  /** USD of a SOL amount, null without a USD rate. */
  usdOfSol(solAmount: number): number | null;
}

export function makeDisplay(pref: DisplayPref, rates: DisplayRates | null, loading: boolean): Display {
  const zecSol = rates?.zecSol ?? null;
  // ZEC pick: SOL figures need ZEC/SOL. Without one (and nothing coming), fall back to SOL rather than nothing.
  const wantZec = pref === "zec";
  const canConvert = zecSol !== null;
  const pending = !canConvert && loading;
  const unit: DisplayUnit = wantZec && (canConvert || pending) ? "ZEC" : NATIVE_COIN;
  const converted = wantZec && canConvert;
  const zecUnit: DisplayUnit = !wantZec && canConvert ? NATIVE_COIN : "ZEC";
  const zecConverted = !wantZec && canConvert;
  return {
    pref,
    unit,
    converted,
    zecUnit,
    zecConverted,
    pending: wantZec && pending,
    rates,
    sol: (n) => (!Number.isFinite(n) ? null : converted ? n / zecSol! : wantZec && pending ? null : n),
    zec: (n) => (!Number.isFinite(n) ? null : zecConverted ? n * zecSol! : n),
    usd: (z) => (rates?.zecUsd && Number.isFinite(z) ? z * rates.zecUsd : null),
    usdOfSol: (n) => (!Number.isFinite(n) ? null : rates?.solUsd ? n * rates.solUsd : rates?.zecUsd && zecSol ? (n / zecSol) * rates.zecUsd : null),
  };
}

/** "≈ " when converted, else "". */
export const approx = (converted: boolean) => (converted ? "≈ " : "");

/** Dollars for the small "≈ $X" hints: cents under $1k, whole dollars above, compact from $1M. */
export function formatUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
  if (a >= 1000) return "$" + trimNumber(n, 0);
  if (a > 0 && a < 0.01) return "<$0.01";
  return "$" + new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

/** Rate figures for the strip: "$252.41", "1.8021". */
export function formatRate(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}
