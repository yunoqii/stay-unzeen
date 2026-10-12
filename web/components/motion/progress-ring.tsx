"use client";

import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * Circular progress (bonding curve, countdowns). Rewritten on Motion from the idea of an SVG
 * progress-ring demo (that one used Anime.js; no Anime.js here). Fills once to the value; numbers
 * never overshoot (trading UI).
 */
export function ProgressRing({
  value,
  size = 64,
  stroke = 2,
  className,
  children,
  label,
}: {
  /** 0..100 */
  value: number;
  size?: number;
  stroke?: number;
  className?: string;
  children?: React.ReactNode;
  /** Accessible name, e.g. "Bonding curve 38%". */
  label: string;
}) {
  const reduce = useReducedMotion();
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0)) / 100;
  const r = (size - stroke) / 2;
  return (
    <span role="img" aria-label={label} className={cn("relative inline-grid shrink-0 place-items-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--uz-white-a4)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--uz-zec)"
          strokeWidth={stroke}
          strokeLinecap="round"
          initial={{ pathLength: reduce ? v : 0 }}
          animate={{ pathLength: v }}
          transition={{ duration: 0.9, ease: [0.65, 0, 0.35, 1] }}
        />
      </svg>
      {children && <span className="relative">{children}</span>}
    </span>
  );
}
