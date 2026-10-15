// Creator rules of Unzeen launches (docs/API.md v0.5, PoolInfo.launchRules). The ledger enforces them;
// the UI only states them, with the numbers the pool publishes.

import type { PoolInfo, UnzeenRule } from "@/lib/api/types";

type Rules = NonNullable<PoolInfo["launchRules"]>;
const ZAT_PER_ZEC = BigInt(100_000_000);

/** Defaults of core/ when the pool does not publish launchRules yet. */
export const DEFAULT_LAUNCH_RULES: Rules = { lockSecs: 86_400, capBps: 500, maxInitialBuyLamports: "0" };

export const RULES_SCOPE = "Rules apply to the launching key.";

function duration(secs: number): string {
  if (secs % 86_400 === 0 && secs >= 86_400) return `${secs / 86_400 === 1 ? 24 : (secs / 86_400) * 24}h`;
  if (secs % 3_600 === 0) return `${secs / 3_600}h`;
  return `${Math.ceil(secs / 60)} min`;
}

const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** UI line for a rule id, or null for ids this build does not know (never shown raw). */
export function ruleText(rule: UnzeenRule, r: Rules | undefined = undefined): string | null {
  const rules = r ?? DEFAULT_LAUNCH_RULES;
  switch (rule) {
    case "creator_initial_buy_locked_24h":
      return rules.lockSecs > 0 ? `Creator's initial buy locked for ${duration(rules.lockSecs)}` : null;
    case "initial_buy_cap_5pct":
      return rules.capBps > 0 ? `Creator capped at ${pct(rules.capBps)} of supply` : null;
    case "authorities_revoked":
      return "Mint & freeze authority revoked";
    default:
      return null;
  }
}

/** Cap of the first buy of `create` on `venue` (v0.6 per-venue cap, falling back to the pump.fun one). */
export function maxInitialBuyLamports(pool: Pick<PoolInfo, "launchRules"> | null | undefined, venue?: string): string | undefined {
  const r = pool?.launchRules;
  return (venue && r?.maxInitialBuyLamportsByVenue?.[venue]) || r?.maxInitialBuyLamports;
}

/**
 * v0.17: cap of the first buy of a ZEC-pair `create` on `venue`, in ZEC SPL units (= zatoshis: 1:1 parity,
 * no rate). Null when the pool does not publish it (devnet `{}`, older servers): the server still checks it.
 */
export function maxInitialBuyZecUnits(pool: Pick<PoolInfo, "launchRules"> | null | undefined, venue?: string): bigint | null {
  const v = venue ? pool?.launchRules?.maxInitialBuyZecUnitsByVenue?.[venue] : undefined;
  return v && /^\d{1,30}$/.test(v) && v !== "0" ? BigInt(v) : null;
}

/**
 * v0.24: smallest initialBuyZec (zatoshis). SOL / ETH pairs: one D10 rounding step, as the pool publishes it
 * (launchRules.minInitialBuyZat); older servers and ZEC pairs: minActionZat.
 */
export function minInitialBuyZat(pool: Pick<PoolInfo, "launchRules" | "minActionZat"> | null | undefined, quote: string = "SOL"): bigint | null {
  const v = pool?.launchRules?.minInitialBuyZat;
  if (quote !== "ZEC" && v && /^\d{1,20}$/.test(v)) return BigInt(v);
  return pool?.minActionZat && /^\d{1,20}$/.test(pool.minActionZat) ? BigInt(pool.minActionZat) : null;
}

/**
 * Largest initialBuyZec (zatoshis) that stays under the venue's cap; null if unknown. SOL pairs: the
 * lamport cap at the pool's buy rate. ZEC pairs (v0.17): maxInitialBuyZecUnitsByVenue as is.
 */
export function maxInitialBuyZat(pool: Pick<PoolInfo, "launchRules" | "rate" | "quotes"> | null | undefined, venue?: string, quote: string = "SOL"): bigint | null {
  if (quote === "ZEC") {
    // The cap is on the ZEC SPL the curve receives: zat x the 1:1 parity less its spread (core apply_spread).
    const cap = maxInitialBuyZecUnits(pool, venue);
    if (cap === null) return null;
    const bps = Math.min(10_000, Math.max(0, pool?.quotes?.find((q) => q.quote === "ZEC")?.spreadBps ?? 0));
    const unitsPerZec = (ZAT_PER_ZEC * BigInt(10_000 - Math.floor(bps))) / BigInt(10_000);
    return unitsPerZec === BigInt(0) ? null : (cap * ZAT_PER_ZEC) / unitsPerZec;
  }
  // v0.24: the pool publishes the exact inclusive range per venue ("0" = no first buy possible there).
  const published = venue ? pool?.launchRules?.maxInitialBuyZatByVenue?.[venue] : undefined;
  if (published !== undefined && /^\d{1,20}$/.test(published)) return BigInt(published);
  const max = maxInitialBuyLamports(pool, venue);
  const rate = pool?.rate?.lamportsPerZecBuy;
  if (!max || !/^\d+$/.test(max) || max === "0" || !rate || !/^\d+$/.test(rate) || rate === "0") return null;
  return (BigInt(max) * ZAT_PER_ZEC) / BigInt(rate);
}
