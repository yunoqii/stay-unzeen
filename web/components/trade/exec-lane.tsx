"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ExecMode } from "@/lib/exec";

// Timing of the selected execution mode as one lane: your order (yellow) travels from "signed" to
// "on-chain". Now goes straight through; Delayed waits at the batch gate and leaves together with
// other orders; Max privacy waits longer for a bigger batch. Idea taken from an easing-curve
// comparison demo (same move, different curves), rebuilt on Motion; no Anime.js.

const PLAN: Record<ExecMode, { times: number[]; x: string[]; duration: number; crowd: number }> = {
  now: { x: ["0%", "92%", "92%"], times: [0, 0.3, 1], duration: 2.2, crowd: 0 },
  delayed: { x: ["0%", "46%", "46%", "92%", "92%"], times: [0, 0.18, 0.62, 0.8, 1], duration: 3.2, crowd: 2 },
  max: { x: ["0%", "46%", "46%", "92%", "92%"], times: [0, 0.12, 0.78, 0.9, 1], duration: 4.6, crowd: 5 },
};

export function ExecLane({ mode }: { mode: ExecMode }) {
  const reduce = useReducedMotion();
  const p = PLAN[mode];
  const loop = { duration: p.duration, times: p.times, ease: "easeInOut" as const, repeat: Infinity, repeatDelay: 0.4 };
  return (
    <div aria-hidden className="mt-2.5">
      <div className="relative h-4 overflow-hidden">
        <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        {mode !== "now" && <span className="hatch-zec absolute top-0 bottom-0 left-[46%] w-2.5 opacity-80" />}
        {/* other orders that join the same batch (never shown for Now) */}
        {Array.from({ length: p.crowd }).map((_, i) => (
          <motion.span
            key={`${mode}-${i}`}
            className="absolute inset-0"
            initial={false}
            animate={reduce ? { x: "46%" } : { x: p.x.map((v, k) => (k === 0 ? `${12 + i * 5}%` : v)) }}
            transition={reduce ? { duration: 0 } : { ...loop, times: p.times }}
          >
            <span className="absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-muted-foreground/60" style={{ marginLeft: -3 - i * 3 }} />
          </motion.span>
        ))}
        <motion.span
          key={mode}
          className="absolute inset-0"
          initial={false}
          animate={reduce ? { x: mode === "now" ? "92%" : "46%" } : { x: p.x }}
          transition={reduce ? { duration: 0 } : loop}
        >
          <span className="absolute top-1/2 size-2 -translate-y-1/2 rounded-full bg-zec shadow-[0_0_8px_rgb(244_183_40/0.6)]" />
        </motion.span>
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-[10px] text-faint-foreground">
        <span>signed</span>
        {mode !== "now" && <span className="-ml-6">batch</span>}
        <span>on-chain</span>
      </div>
    </div>
  );
}
