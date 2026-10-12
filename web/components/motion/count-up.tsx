"use client";

import { useEffect, useRef } from "react";
import { animate, useReducedMotion } from "motion/react";

interface Props {
  value: number;
  format: (n: number) => string;
  durationS?: number;
  className?: string;
}

/** Counts from 0 to `value` on mount; no overshoot, numbers are money. */
export function CountUp({ value, format, durationS = 0.6, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce || !Number.isFinite(value)) {
      el.textContent = format(value);
      return;
    }
    const controls = animate(0, value, {
      duration: durationS,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        el.textContent = format(v);
      },
    });
    return () => controls.stop();
  }, [value, format, durationS, reduce]);

  return (
    <span ref={ref} className={className}>
      {format(value)}
    </span>
  );
}
