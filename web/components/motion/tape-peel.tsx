"use client";

import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * Tape peel / stick (docs/design/tape-peel.md, brand v4). The tape holds on to its torn right end like a
 * hinge (origin 92% 50%): the free end with the curled corner lifts, foreshortens (scaleX .86) and casts a
 * shadow; then it slaps back. transform, opacity and filter only, never layout. No spring: a bounce reads
 * as a toy. Reduced motion: no rotation, no shadow, the tape fades out and in over 150 ms.
 */
export const PEEL_TRANSITION = { duration: 0.42, ease: [0.2, 0.8, 0.2, 1] } as const;
export const STICK_TRANSITION = { duration: 0.3, ease: [0.5, 0, 0.9, 0.3] } as const;
/** Auto-play (first load): how long the tape stays off before it sticks back. */
export const PEEL_HOLD_MS = 900;

const SHADOW_ON = "drop-shadow(0px 14px 10px rgba(0, 0, 0, 0.6))";
const SHADOW_OFF = "drop-shadow(0px 0px 0px rgba(0, 0, 0, 0))";

export function PeelTape({
  peeled,
  rest = 0,
  className,
  style,
  children,
}: {
  peeled: boolean;
  /** Resting angle of the strip, degrees (the brand geometry may already carry its own angle inside). */
  rest?: number;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.span
      aria-hidden
      data-peeled={peeled ? "true" : "false"}
      className={cn("pointer-events-none absolute block", className)}
      style={{ originX: 0.92, originY: 0.5, rotate: rest, ...style }}
      initial={false}
      animate={
        reduce
          ? { opacity: peeled ? 0 : 1 }
          : peeled
            ? { rotate: rest + 26, x: "6%", y: "-48%", scaleX: 0.86, filter: SHADOW_ON }
            : { rotate: rest, x: "0%", y: "0%", scaleX: 1, filter: SHADOW_OFF }
      }
      transition={reduce ? { duration: 0.15, ease: "linear" } : peeled ? PEEL_TRANSITION : STICK_TRANSITION}
    >
      {children}
    </motion.span>
  );
}
