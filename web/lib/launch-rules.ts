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

/** Largest initialBuyZec (zatoshis) that stays under maxInitialBuyLamports at the pool's buy rate; null if unknown. */
export function maxInitialBuyZat(pool: Pick<PoolInfo, "launchRules" | "rate"> | null | undefined): bigint | null {
  const max = pool?.launchRules?.maxInitialBuyLamports;
  const rate = pool?.rate?.lamportsPerZecBuy;
  if (!max || !/^\d+$/.test(max) || max === "0" || !rate || !/^\d+$/.test(rate) || rate === "0") return null;
  return (BigInt(max) * ZAT_PER_ZEC) / BigInt(rate);
}
