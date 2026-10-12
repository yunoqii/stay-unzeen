// Quick-trade settings: Buy presets (ZEC), one-tap mode and max slippage. Local to this browser and
// per network, like the default execution mode (lib/exec.ts). Never sent anywhere: the pool only sees
// the amounts and minOut of the orders the user actually signs.

import { useSyncExternalStore } from "react";
import type { Network } from "@/lib/network";

export interface TradeSettings {
  /** Three Buy presets, decimal ZEC strings. */
  buyPresets: [string, string, string];
  /** Sell presets, percent of the holding (fixed by the product decision). */
  sellPresets: readonly [25, 50, 100];
  /** A preset tap signs the order right away (off by default: tap fills the amount, then confirm). */
  oneTap: boolean;
  /** Max slippage, basis points. */
  slippageBps: number;
}

export const DEFAULT_BUY_PRESETS: [string, string, string] = ["0.1", "0.5", "1"];
export const SELL_PRESETS = [25, 50, 100] as const;
export const SLIPPAGE_CHOICES_BPS = [50, 100, 300, 500] as const;
export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 5_000;

export const DEFAULTS: TradeSettings = {
  buyPresets: DEFAULT_BUY_PRESETS,
  sellPresets: SELL_PRESETS,
  oneTap: false,
  slippageBps: DEFAULT_SLIPPAGE_BPS,
};

/** A ZEC preset: positive, at most 8 decimals, at most 100 000 ZEC. Returns the normalized string or null. */
export function normalizePreset(v: string): string | null {
  const s = v.trim().replace(",", ".");
  if (!/^(\d{1,6})(\.\d{1,8})?$|^\.\d{1,8}$/.test(s)) return null;
  const n = Number(s);
  if (!(n > 0) || n > 100_000) return null;
  const [i = "0", f = ""] = s.split(".");
  const int = i.replace(/^0+(?=\d)/, "") || "0";
  const frac = f.replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

export function isSlippageBps(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_SLIPPAGE_BPS;
}

/** Parse whatever is in storage; anything malformed falls back to the defaults field by field. */
export function parseSettings(raw: string | null): TradeSettings {
  if (!raw) return DEFAULTS;
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return DEFAULTS;
  }
  if (!x || typeof x !== "object") return DEFAULTS;
  const o = x as Partial<Record<keyof TradeSettings, unknown>>;
  const presets =
    Array.isArray(o.buyPresets) && o.buyPresets.length === 3 && o.buyPresets.every((p) => typeof p === "string" && normalizePreset(p) !== null)
      ? (o.buyPresets.map((p) => normalizePreset(p as string)!) as [string, string, string])
      : DEFAULT_BUY_PRESETS;
  return {
    buyPresets: presets,
    sellPresets: SELL_PRESETS,
    oneTap: o.oneTap === true,
    slippageBps: isSlippageBps(o.slippageBps) ? o.slippageBps : DEFAULT_SLIPPAGE_BPS,
  };
}

export const tradeSettingsKey = (n: Network) => `unzeen.trade.${n}`;

const cache: Partial<Record<Network, TradeSettings>> = {};
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function getTradeSettings(n: Network): TradeSettings {
  const hit = cache[n];
  if (hit) return hit;
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(tradeSettingsKey(n)) ?? null;
  } catch {
    /* blocked */
  }
  return (cache[n] = parseSettings(raw));
}

export function updateTradeSettings(n: Network, patch: Partial<Omit<TradeSettings, "sellPresets">>) {
  const next = { ...getTradeSettings(n), ...patch };
  cache[n] = next;
  try {
    storage()?.setItem(tradeSettingsKey(n), JSON.stringify({ buyPresets: next.buyPresets, oneTap: next.oneTap, slippageBps: next.slippageBps }));
  } catch {
    /* private mode: memory only */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith("unzeen.trade.")) {
      for (const k of Object.keys(cache) as Network[]) delete cache[k];
      l();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTradeSettings(n: Network): TradeSettings {
  return useSyncExternalStore(subscribe, () => getTradeSettings(n), () => DEFAULTS);
}
