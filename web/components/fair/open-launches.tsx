"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight } from "@phosphor-icons/react";
import { errorText } from "@/lib/api/client";
import type { FairLaunch } from "@/lib/api/types";
import { getLaunches, LAUNCH_POLL_MS } from "@/lib/fair/api";
import { useNetwork } from "@/lib/network";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/use-now";
import { ProgressRing } from "@/components/motion/progress-ring";
import { countdown, StatusPill } from "./parts";

const LIVE = new Set(["open", "closed", "revealing", "executing"]);

/** Public list of sealed-bid launches in progress. Same request and rhythm for every viewer. */
export function OpenLaunches({ className }: { className?: string }) {
  const network = useNetwork();
  const now = useNow(1000);
  const [state, setState] = useState<{ network: string; list: FairLaunch[] | null; error: string | null }>({ network, list: null, error: null });

  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const run = () => {
      getLaunches({ limit: 20 })
        .then((list) => alive && setState({ network, list: list.filter((l) => LIVE.has(l.status)), error: null }))
        .catch((e: unknown) => alive && setState((s) => ({ network, list: s.network === network ? s.list : null, error: errorText(e) })))
        .finally(() => {
          if (alive) t = setTimeout(run, LAUNCH_POLL_MS);
        });
    };
    run();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [network]);

  const list = state.network === network ? state.list : null;

  return (
    <section aria-labelledby="open-launches-t" className={className}>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="open-launches-t" className="text-sm font-medium">
          Sealed-bid launches in progress
        </h2>
        <span className="text-xs text-faint-foreground">bid counts stay hidden until each round</span>
      </div>
      {list === null ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{state.error ?? "Loading…"}</p>
      ) : list.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">No windows open right now. Open one above.</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-2xl border border-border">
          <AnimatePresence initial={false}>
            {list.map((l) => {
              const open = l.status === "open" && now !== null && now < l.closeAt;
              const left = now === null ? null : open ? l.closeAt - now : l.drand.roundTime - now;
              const pct = now === null ? 0 : Math.max(0, Math.min(100, ((now - l.publishedAt) / (l.closeAt - l.publishedAt)) * 100));
              return (
                <motion.li key={l.id} layout initial={{ opacity: 0, filter: "blur(8px)" }} animate={{ opacity: 1, filter: "blur(0px)" }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                  <Link
                    href={`/launch/${l.id}`}
                    className="group flex items-center gap-4 px-4 py-3 transition-colors duration-150 hover:bg-surface-1 focus-visible:bg-surface-1 focus-visible:outline-none"
                  >
                    <ProgressRing value={pct} size={36} stroke={2} label={open ? `Window ${Math.round(pct)}% elapsed` : "Window closed"} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        <span className="font-medium">${l.meta.symbol}</span> <span className="text-muted-foreground">{l.meta.name}</span>
                      </span>
                      <span className="tabular block text-xs text-faint-foreground">
                        {left === null ? "…" : open ? `closes in ${countdown(left)}` : left > 0 ? `round in ${countdown(left)}` : "round reached"} · pump.fun
                      </span>
                    </span>
                    <StatusPill status={l.status} className="hidden sm:inline-flex" />
                    <ArrowRight size={14} weight="light" className={cn("shrink-0 text-faint-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground")} aria-hidden />
                  </Link>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}
