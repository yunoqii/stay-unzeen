"use client";

import Link from "next/link";
import { ArrowRight, FlowArrow } from "@phosphor-icons/react";
import type { Scenario } from "@/lib/api/types";
import { useScenarioStore } from "@/lib/scenarios/store";
import { isLiveScenario, StatusPill } from "@/components/scenarios/my-scenarios";

/**
 * Running scenarios at a glance (from the same Portfolio poll), and the way in to build one.
 * Names come from this device's encrypted store; the server never has them.
 */
export function ScenariosCard({ scenarios, more = 0 }: { scenarios: Scenario[] | null | undefined; more?: number }) {
  const store = useScenarioStore();
  const live = (scenarios ?? []).filter(isLiveScenario);
  return (
    <section aria-labelledby="scn-title" className="rounded-2xl border border-border bg-card/60 p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="scn-title" className="flex items-center gap-2 font-medium">
          <FlowArrow size={16} weight="duotone" className="text-zec" aria-hidden />
          Scenarios
        </h2>
        <Link href="/scenarios" className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {live.length ? "Open" : "Automate"}
          <ArrowRight size={12} weight="light" aria-hidden />
        </Link>
      </div>
      {live.length === 0 ? (
        <p className="mt-2 text-sm text-pretty text-muted-foreground">Sign a plan once — top up, buy, take profit, leave in shielded ZEC — and the pool runs it. Nothing leaves this device while it does.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border/60">
          {live.map((s) => {
            const done = s.steps.filter((x) => x.status === "done" || x.status === "skipped").length;
            return (
              <li key={s.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{store.file.signed[s.id]?.name ?? `Scenario ${s.id.slice(0, 6)}`}</span>
                <span className="tabular font-mono text-[11px] text-faint-foreground">
                  {done}/{s.steps.length}
                </span>
                <StatusPill status={s.status} />
              </li>
            );
          })}
        </ul>
      )}
      {more > 0 && <p className="mt-1 text-xs text-muted-foreground">+{more} more</p>}
    </section>
  );
}
