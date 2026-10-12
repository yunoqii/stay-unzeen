"use client";

import { useId } from "react";
import { motion } from "motion/react";
import { Check } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

export interface PayStep {
  label: string;
  detail?: React.ReactNode;
}

/** Vertical steps; the active marker travels between them (layoutId). */
export function PaySteps({ steps, current, done }: { steps: PayStep[]; current: number; done?: boolean }) {
  const markerId = useId();
  return (
    <ol className="relative space-y-1" aria-label="Payment status">
      {steps.map((s, i) => {
        const state = i < current || (done && i === current) ? "done" : i === current ? "active" : "todo";
        return (
          <li
            key={s.label}
            aria-current={state === "active" ? "step" : undefined}
            className="relative flex gap-3 rounded-xl px-3 py-2.5"
          >
            {state === "active" && (
              <motion.span
                layoutId={markerId}
                aria-hidden
                className="absolute inset-0 rounded-xl bg-surface-3"
                transition={{ type: "spring", bounce: 0, duration: 0.35 }}
              />
            )}
            <span
              aria-hidden
              className={cn(
                "relative mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[10px] transition-colors duration-(--motion-base)",
                state === "done" && "border-zec bg-zec text-primary-foreground",
                state === "active" && "border-zec text-zec",
                state === "todo" && "border-border-strong text-faint-foreground",
              )}
            >
              {state === "done" ? <Check size={11} weight="bold" /> : state === "active" ? <span className="live-dot size-1.5 rounded-full bg-zec" /> : i + 1}
            </span>
            <div className="relative min-w-0">
              <p className={cn("text-sm", state === "todo" ? "text-muted-foreground" : "text-foreground")}>{s.label}</p>
              {s.detail && state !== "todo" && <div className="mt-0.5 text-xs text-pretty text-muted-foreground">{s.detail}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
