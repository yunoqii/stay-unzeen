"use client";

import { useId, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Lightning, LockSimple } from "@phosphor-icons/react";
import type { LaunchModesProps } from "@/components/launch/launch-app";
import "@/lib/fair/api"; // registers the error codes of this feature
import { cn } from "@/lib/utils";
import { FairCreateForm } from "./fair-create-form";
import { OpenLaunches } from "./open-launches";

const EASE = [0.16, 1, 0.3, 1] as const;

type Mode = "instant" | "sealed";

const MODES: { id: Mode; icon: typeof Lightning; title: string; sub: string }[] = [
  { id: "instant", icon: Lightning, title: "Instant", sub: "Live now. Your first buy rides in the launch transaction." },
  { id: "sealed", icon: LockSimple, title: "Fair launch (sealed bids)", sub: "A short window of time-locked bids, then one buy at one price." },
];

/** Instant | Fair launch switch on /launch, plus the list of sealed-bid launches taking bids now. */
export default function LaunchModes({ pool, meta, onMeta, instant }: LaunchModesProps) {
  const id = useId();
  const [mode, setMode] = useState<Mode>("instant");
  return (
    <div>
      <div role="radiogroup" aria-label="Launch mode" className="grid gap-2 sm:grid-cols-2">
        {MODES.map(({ id: m, icon: Icon, title, sub }) => {
          const on = mode === m;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setMode(m)}
              className={cn(
                "group relative overflow-hidden rounded-2xl border p-4 text-left transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                on ? "border-zec/50" : "border-border hover:border-border-strong",
              )}
            >
              {on && <motion.span layoutId={`${id}-mode`} aria-hidden className="absolute inset-0 bg-zec/[0.05]" transition={{ type: "spring", bounce: 0, duration: 0.3 }} />}
              <span className="relative flex items-center gap-2 text-sm font-medium">
                <Icon size={16} weight={on ? "duotone" : "light"} className={cn("transition-colors", on ? "text-zec" : "text-muted-foreground")} aria-hidden />
                {title}
              </span>
              <span className="relative mt-1 block text-xs text-pretty text-muted-foreground">{sub}</span>
            </button>
          );
        })}
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={mode}
          initial={{ opacity: 0, filter: "blur(8px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, filter: "blur(8px)" }}
          transition={{ duration: 0.22, ease: EASE }}
          className="mt-8"
        >
          {mode === "instant" ? instant : <FairCreateForm pool={pool} meta={meta} onMeta={onMeta} />}
        </motion.div>
      </AnimatePresence>

      <OpenLaunches className="mt-14" />
    </div>
  );
}
