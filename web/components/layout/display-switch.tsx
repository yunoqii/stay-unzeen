"use client";

import { useId } from "react";
import { motion } from "motion/react";
import { NATIVE_COIN, type DisplayPref } from "@/lib/display";
import { setDisplayPref, useDisplayPref } from "@/lib/display-store";
import { cn } from "@/lib/utils";

const PREFS: readonly DisplayPref[] = ["zec", "native"];
const LABEL: Record<DisplayPref, string> = { zec: "ZEC", native: NATIVE_COIN };

/** ZEC (default) <-> the chain's native coin. Saved in this browser only. */
export function DisplaySwitch({ className, size = "sm", "aria-labelledby": labelledBy }: { className?: string; size?: "xs" | "sm"; "aria-labelledby"?: string }) {
  const pref = useDisplayPref();
  const pillId = useId();
  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : "Show prices in"}
      aria-labelledby={labelledBy}
      className={cn("relative inline-flex items-center rounded-full border border-border p-0.5", size === "xs" ? "h-6 text-[11px]" : "h-8 text-xs", className)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const next = PREFS[(PREFS.indexOf(pref) + 1) % PREFS.length];
        setDisplayPref(next);
        (e.currentTarget.querySelector(`[data-pref="${next}"]`) as HTMLElement | null)?.focus();
      }}
    >
      {PREFS.map((p) => {
        const on = p === pref;
        return (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-pref={p}
            onClick={() => setDisplayPref(p)}
            className={cn(
              "hit relative h-full rounded-full font-mono transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              size === "xs" ? "px-2" : "px-3",
              on ? (p === "zec" ? "text-zec" : "text-foreground") : "text-muted-foreground hover:text-foreground",
            )}
          >
            {on && (
              <motion.span
                layoutId={pillId}
                className={cn("absolute inset-0 rounded-full", p === "zec" ? "bg-zec/12" : "bg-surface-3")}
                transition={{ type: "spring", bounce: 0, duration: 0.3 }}
              />
            )}
            <span className="relative">{LABEL[p]}</span>
          </button>
        );
      })}
    </div>
  );
}
