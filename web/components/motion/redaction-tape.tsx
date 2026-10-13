"use client";

import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export type TapeState = "covered" | "lifted" | "hidden";

const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const EASE_IN = [0.7, 0, 0.84, 0] as const;

/**
 * Motion v2 shared gesture (docs/design/motion-v2.md): a strip of redaction tape that covers what just
 * became private. Covered: scaleX 0 → 1 from `from` (420 ms, or `coverMs`). Lifted: scaleX 1 → 0 towards
 * the far edge (220 ms, ease-in: it leaves fast and does not pull the eye). Decorative only: the status
 * text next to it carries the meaning. Reduced motion: opacity, 150 ms, no scale.
 */
export function RedactionTape({
  state,
  from = "left",
  coverMs = 420,
  instant = false,
  className,
}: {
  state: TapeState;
  from?: "left" | "right";
  coverMs?: number;
  /** Start in `state` without animating (tape already in place on first paint). */
  instant?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const far = from === "left" ? "right" : "left";
  const origin = state === "lifted" ? far : from;
  const on = state === "covered";
  return (
    <motion.span
      aria-hidden
      className={cn("redaction-tape pointer-events-none absolute inset-0 rounded-[3px]", className)}
      style={{ transformOrigin: `${origin} center` }}
      initial={instant ? false : reduce ? { opacity: 0, scaleX: 1 } : { opacity: 1, scaleX: 0 }}
      animate={reduce ? { opacity: on ? 1 : 0, scaleX: 1 } : { opacity: 1, scaleX: on ? 1 : 0 }}
      transition={reduce ? { duration: 0.15 } : on ? { duration: coverMs / 1000, ease: EASE_OUT } : { duration: 0.22, ease: EASE_IN }}
    />
  );
}
