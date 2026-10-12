"use client";

import Link from "next/link";
import { useId } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Eye, Lightning, Timer } from "@phosphor-icons/react";
import { EXEC_COPY, NOW_WARNING, type ExecMode } from "@/lib/exec";
import { cn } from "@/lib/utils";

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Now / Delayed segmented switch for buy and sell, with "Max privacy" nested inside Delayed. Changes
 * the mode of this one action only; the default comes from Settings in /portfolio. Withdrawals do not
 * use it: they are never instant (lib/exec.ts).
 */
export function ExecSwitch({
  value,
  onChange,
  profileDefault,
  className,
}: {
  value: ExecMode;
  onChange: (mode: ExecMode) => void;
  profileDefault: ExecMode;
  className?: string;
}) {
  const id = useId();
  const copy = EXEC_COPY;
  const delayed = value !== "now";
  const overridden = value !== profileDefault;

  return (
    <fieldset className={cn("rounded-xl border border-border p-3", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <legend className="float-left text-xs text-muted-foreground">Execution</legend>
        {overridden ? (
          <button
            type="button"
            onClick={() => onChange(profileDefault)}
            className="rounded text-[11px] text-faint-foreground underline-offset-4 hover:text-muted-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            This order only · Reset
          </button>
        ) : (
          <Link
            href="/portfolio#settings"
            className="rounded text-[11px] text-faint-foreground underline-offset-4 hover:text-muted-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Your default · Change
          </Link>
        )}
      </div>

      <div role="radiogroup" aria-label="Execution mode" className="clear-both mt-2 grid grid-cols-2 gap-1 rounded-full border border-border p-1">
        {(["now", "delayed"] as const).map((m) => {
          const on = m === "now" ? !delayed : delayed;
          const Icon = m === "now" ? Lightning : Timer;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => {
                if (on) return;
                // Back to Delayed keeps the profile's choice between Delayed and Max privacy.
                onChange(m === "now" ? "now" : profileDefault === "max" ? "max" : "delayed");
              }}
              className={cn(
                "relative inline-flex items-center justify-center gap-1.5 rounded-full py-1.5 text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {on && <motion.span layoutId={`${id}-exec`} className="absolute inset-0 rounded-full bg-surface-3" transition={{ type: "spring", bounce: 0, duration: 0.3 }} />}
              <Icon size={13} weight={on ? "duotone" : "light"} className={cn("relative", on && m === "delayed" && "text-zec")} aria-hidden />
              <span className="relative">{copy[m].label}</span>
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-[11px] text-faint-foreground tabular">{copy[value === "max" ? "delayed" : value].hint}</p>

      <AnimatePresence initial={false} mode="popLayout">
        {delayed ? (
          <motion.label
            key="max"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            style={{ overflow: "hidden" }}
            className="block cursor-pointer"
          >
            <span className="mt-2.5 flex items-start gap-3 border-t border-border/60 pt-2.5">
              <input
                type="checkbox"
                role="switch"
                checked={value === "max"}
                onChange={(e) => onChange(e.target.checked ? "max" : "delayed")}
                className="peer sr-only"
              />
              <span
                aria-hidden
                className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full border border-border-strong bg-surface-2 transition-colors peer-checked:bg-zec/30 peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
              >
                <span
                  className={cn(
                    "absolute top-0.5 left-0.5 size-3.5 rounded-full bg-muted-foreground transition-transform duration-200",
                    value === "max" && "translate-x-4 bg-zec",
                  )}
                />
              </span>
              <span className="text-sm">
                {copy.max.label}
                <span className="mt-0.5 block text-xs text-faint-foreground">{copy.max.hint}</span>
              </span>
            </span>
          </motion.label>
        ) : (
          <motion.p
            key="now"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            style={{ overflow: "hidden" }}
            className="text-xs text-pretty text-zec/85"
          >
            <span className="mt-2.5 flex gap-2 border-t border-border/60 pt-2.5">
              <Eye size={14} weight="light" className="mt-px shrink-0 text-zec" aria-hidden />
              <span>{NOW_WARNING}</span>
            </span>
          </motion.p>
        )}
      </AnimatePresence>
    </fieldset>
  );
}
