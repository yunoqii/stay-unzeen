"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { shortAddr } from "@/lib/format";

/**
 * M4 Split and scatter (docs/design/motion-v2.md): a Smart withdraw splits the amount into parts, each to
 * its own fresh address, each at its own random time. The pool picks the part sizes and times and does not
 * return them, so the chips carry no sums ("part 1 of 3") and the race is an illustration, compressed to a
 * few seconds and played once: the caption says what is real. Positions and blur only (transform, opacity,
 * filter); time is linear, not a gesture. Reduced motion: chips rest at their addresses, no travel.
 */
export function ScatterParts({ label, addrs, maxDelayMin }: { label: string; addrs: string[]; maxDelayMin: number }) {
  const reduce = useReducedMotion();
  const lane = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const n = addrs.length;

  useEffect(() => {
    const el = lane.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Uneven, stable "leave times" for the illustration: 0..1 of the lane, never in part order.
  const leave = addrs.map((_, i) => [0.05, 0.62, 0.3, 0.85, 0.45][i % 5]);
  const travel = Math.max(0, width - 72);
  const within = maxDelayMin < 60 ? `${maxDelayMin} min` : `${maxDelayMin / 60} h`;

  return (
    <figure className="rounded-2xl border border-border bg-surface-1 p-4">
      <figcaption className="sr-only">
        Sent as {n} parts, each to its own fresh address, each at its own random time within {within}.
      </figcaption>
      <div aria-hidden className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
        <span className="tabular rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm font-medium whitespace-nowrap">{label}</span>
        <div ref={lane} className="relative" style={{ height: n * 34 }}>
          {addrs.map((_, i) => {
            const y = i * 34 + 17;
            return <span key={`l${i}`} className="absolute inset-x-0 h-px bg-[repeating-linear-gradient(to_right,var(--uz-fog-1)_0_4px,transparent_4px_9px)]" style={{ top: y }} />;
          })}
          {width > 0 &&
            addrs.map((_, i) => {
              const y = i * 34 + 8;
              const mid = (n * 34) / 2 - 9;
              const at = leave[i];
              return (
                <motion.span
                  key={`p${i}`}
                  className="tabular absolute left-0 rounded-full border border-zec/35 bg-surface-3 px-2 py-0.5 font-mono text-[11px] whitespace-nowrap text-foreground"
                  initial={reduce ? { x: travel, y, opacity: 0.9 } : { x: 0, y: mid, opacity: 0, filter: "blur(0px)" }}
                  animate={
                    reduce
                      ? { x: travel, y, opacity: 0.9 }
                      : {
                          x: [0, 0, travel * at, travel * 0.88, travel],
                          y: [mid, y, y, y, y],
                          opacity: [0, 1, 1, 1, 0],
                          filter: ["blur(0px)", "blur(0px)", "blur(0px)", "blur(0px)", "blur(6px)"],
                        }
                  }
                  transition={reduce ? { duration: 0 } : { duration: 3.2 + i * 0.35, delay: i * 0.12, times: [0, 0.1, 0.1 + at * 0.55, 0.9, 1], ease: "linear" }}
                >
                  part {i + 1} of {n}
                </motion.span>
              );
            })}
        </div>
        <span className="flex flex-col gap-[10px]">
          {addrs.map((a, i) => (
            <span key={`d${i}`} className="rounded-lg border border-dashed border-border-strong px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              {shortAddr(a, 3, 3)}
            </span>
          ))}
        </span>
      </div>
      <p className="mt-3 flex justify-between font-mono text-[10px] text-faint-foreground">
        <span>now</span>
        <span>within {within}</span>
      </p>
      <p className="mt-2 text-xs text-pretty text-muted-foreground">
        {n} uneven parts, each to its own fresh address, each at its own random time within {within}. The pool picks the sizes and times and keeps them to itself: the race
        above only shows the idea.
      </p>
    </figure>
  );
}
