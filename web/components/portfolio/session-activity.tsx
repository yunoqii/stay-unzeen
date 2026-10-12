"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CaretDown } from "@phosphor-icons/react";
import { describe, type TrackedAction } from "@/lib/activity";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/use-now";
import { ActionStatusCard } from "@/components/trade/action-status";

const LABEL: Record<TrackedAction["status"]["status"], string> = {
  queued: "Queued",
  sent: "Sent",
  executed: "Done",
  failed: "Failed",
};

/** Orders sent from this tab. Memory only: gone on reload, nothing stored on the device. */
export function SessionActivity({ actions }: { actions: TrackedAction[] }) {
  const now = useNow(5000);
  const [open, setOpen] = useState<string | null>(null);
  if (actions.length === 0) return null;

  return (
    <section aria-labelledby="activity-title" className="rounded-2xl border border-border bg-card/60 p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="activity-title" className="font-medium">
          This session
        </h2>
        <p className="text-xs text-faint-foreground">Kept in this tab only</p>
      </div>
      <ul className="mt-3 divide-y divide-border/60">
        {actions.slice(0, 8).map((a) => {
          const expanded = open === a.id;
          return (
            <li key={a.id} className="py-1">
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : a.id)}
                aria-expanded={expanded}
                className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-feed-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    (a.status.status === "queued" || a.status.status === "sent") && "live-dot bg-zec",
                    a.status.status === "executed" && "bg-muted-foreground",
                    a.status.status === "failed" && "bg-sell",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{describe(a)}</span>
                <span className="text-xs text-muted-foreground">{LABEL[a.status.status]}</span>
                <span className="tabular w-8 text-right font-mono text-xs text-faint-foreground">{now === null ? "" : timeAgo(a.submittedAt, now)}</span>
                <CaretDown size={12} weight="light" className={cn("text-faint-foreground transition-transform duration-200", expanded && "rotate-180")} />
              </button>
              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.div
                    key="d"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                    style={{ overflow: "hidden" }}
                  >
                    <ActionStatusCard action={a} className="mt-1 mb-2" />
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
