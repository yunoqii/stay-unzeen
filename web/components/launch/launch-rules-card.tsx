"use client";

import { ShieldCheck } from "@phosphor-icons/react";
import { formatSol, formatZec, lamportsToSol } from "@/lib/format";
import { maxInitialBuyZat, ruleText, RULES_SCOPE } from "@/lib/launch-rules";
import { usePool } from "@/hooks/use-pool";

/**
 * What the ledger enforces on a launch made here, with the pool's own numbers (PoolInfo.launchRules).
 * The launch form will cap its "initial buy" input at maxInitialBuyZat; the backend answers
 * creator_cap above it anyway.
 */
export function LaunchRulesCard({ extra = [], firstBuyLabel = "Your first buy" }: { extra?: string[]; firstBuyLabel?: string } = {}) {
  const { pool } = usePool();
  const r = pool?.launchRules;
  const maxZat = maxInitialBuyZat(pool);
  const rules = (["creator_initial_buy_locked_24h", "initial_buy_cap_5pct", "authorities_revoked"] as const)
    .map((id) => ruleText(id, r))
    .filter((t): t is string => t !== null)
    .concat(extra);
  return (
    <section aria-labelledby="launch-rules-t" className="grid gap-px bg-border sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="bg-background p-5">
        <h2 id="launch-rules-t" className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck size={15} weight="duotone" className="text-zec" aria-hidden />
          Rules enforced on your launch
        </h2>
        <ul className="mt-3 space-y-1.5 text-sm">
          {rules.map((t) => (
            <li key={t} className="text-muted-foreground">
              {t}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-faint-foreground">{RULES_SCOPE} Buyers see them as a badge on the token page.</p>
      </div>
      <div className="bg-background p-5">
        <p className="text-sm font-medium">{firstBuyLabel}</p>
        <p className="tabular mt-3 text-2xl tracking-tight">
          {maxZat === null || !r ? "—" : `up to ${formatZec(maxZat.toString())} ZEC`}
        </p>
        <p className="tabular mt-1 text-xs text-faint-foreground">
          {r && r.maxInitialBuyLamports !== "0"
            ? `${formatSol(lamportsToSol(r.maxInitialBuyLamports))} SOL on the curve at today's rate. Larger launch buys are refused.`
            : "The pool publishes the limit with its rules."}
        </p>
      </div>
    </section>
  );
}
