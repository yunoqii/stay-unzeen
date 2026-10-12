"use client";

import { useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

// Merkle-sum tree, preview: 8 balances (hatched = someone else's, only their sums are ever shown),
// yours in yellow. "Trace my leaf" walks the proof path leaf -> root; each step is one hash + sum check.

const W = 320;
const LEVEL_Y = [150, 105, 60, 18];
const MINE = 5;

const xOf = (level: number, i: number) => {
  const n = 8 >> level;
  const step = W / n;
  return step * i + step / 2;
};

interface Edge {
  level: number; // child level
  i: number; // child index
}
const EDGES: Edge[] = [0, 1, 2].flatMap((level) => Array.from({ length: 8 >> level }, (_, i) => ({ level, i })));
const PATH = [0, 1, 2].map((level) => MINE >> level); // child index on the path, per level

export function MerkleTrace() {
  const [traced, setTraced] = useState(false);
  const [run, setRun] = useState(0);
  const reduce = useReducedMotion();
  const id = useId();
  const step = reduce ? 0 : 0.45;

  return (
    <section aria-labelledby={`${id}-t`} className="grid gap-px bg-border md:grid-cols-[minmax(0,1fr)_280px]">
      <div className="bg-background p-4 sm:p-6">
        <svg viewBox={`0 0 ${W} 170`} className="mx-auto w-full max-w-lg" role="img" aria-label={traced ? "Your leaf is in the tree and the root total matches the reserves" : "Merkle-sum tree of all balances"}>
          <defs>
            <pattern id={`${id}-h`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="5" stroke="rgb(255 255 255 / 0.22)" strokeWidth="1.2" />
            </pattern>
          </defs>
          {EDGES.map(({ level, i }) => {
            const x1 = xOf(level, i);
            const y1 = LEVEL_Y[level];
            const x2 = xOf(level + 1, i >> 1);
            const y2 = LEVEL_Y[level + 1];
            const onPath = PATH[level] === i;
            return (
              <g key={`${level}-${i}`}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--uz-white-a5)" strokeWidth="1" />
                {onPath && (
                  <motion.line
                    key={`p-${run}`}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke="var(--uz-zec)"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={traced ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
                    transition={{ duration: step || 0.01, delay: traced ? level * step : 0, ease: [0.65, 0, 0.35, 1] }}
                  />
                )}
              </g>
            );
          })}
          {/* inner nodes and root */}
          {[1, 2, 3].map((level) =>
            Array.from({ length: 8 >> level }, (_, i) => {
              const lit = traced && (level === 3 || PATH[level] === i);
              return (
                <motion.circle
                  key={`n-${level}-${i}-${run}`}
                  cx={xOf(level, i)}
                  cy={LEVEL_Y[level]}
                  r={level === 3 ? 7 : 4.5}
                  className={lit ? "fill-zec" : "fill-[var(--uz-ink-3)]"}
                  stroke={lit ? "var(--uz-zec)" : "var(--uz-white-a6)"}
                  strokeWidth="1"
                  initial={false}
                  animate={{ scale: lit ? [1, 1.35, 1] : 1 }}
                  transition={{ duration: 0.4, delay: lit ? (level - 1) * step + step : 0 }}
                  style={{ transformBox: "fill-box", transformOrigin: "center" }}
                />
              );
            }),
          )}
          {/* leaves: balances; only yours is readable to you */}
          {Array.from({ length: 8 }, (_, i) => (
            <rect
              key={`leaf-${i}`}
              x={xOf(0, i) - 13}
              y={LEVEL_Y[0] - 7}
              width="26"
              height="14"
              rx="3"
              fill={i === MINE ? "var(--uz-zec)" : `url(#${id}-h)`}
              stroke={i === MINE ? "var(--uz-zec)" : "var(--uz-white-a6)"}
              strokeWidth="1"
            />
          ))}
          <text x={xOf(0, MINE)} y={LEVEL_Y[0] + 19} textAnchor="middle" className="fill-zec font-mono text-[8px]">
            you
          </text>
          <text x={xOf(3, 0) + 12} y={LEVEL_Y[3] + 3} className="fill-[var(--uz-fog-3)] font-mono text-[8px]">
            Σ root
          </text>
        </svg>
      </div>
      <div className="flex flex-col justify-between gap-4 bg-background p-5">
        <div>
          <h3 id={`${id}-t`} className="text-sm font-medium">
            Your leaf, your proof
          </h3>
          <p className="mt-1 text-xs text-pretty text-faint-foreground">
            Hatched leaves are other balances: you only ever see their sums. Each step up hashes your node with its sibling and
            adds the totals, until the root matches the pool&apos;s public reserves.
          </p>
        </div>
        <AnimatePresence initial={false}>
          {traced && (
            <motion.p
              key="ok"
              initial={{ opacity: 0, y: 6, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, delay: reduce ? 0 : 3 * step + 0.2 }}
              className="flex items-start gap-2 text-sm"
            >
              <Check size={14} weight="bold" className="mt-0.5 shrink-0 text-zec" aria-hidden />
              Your balance is in the tree, and the root total is covered by the reserves.
            </motion.p>
          )}
        </AnimatePresence>
        <button
          type="button"
          onClick={() => {
            if (traced) setTraced(false);
            else {
              setRun((r) => r + 1);
              setTraced(true);
            }
          }}
          className={cn(
            "h-9 rounded-full border px-4 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            traced ? "border-border text-muted-foreground hover:text-foreground" : "border-zec/50 text-foreground hover:bg-zec/10",
          )}
        >
          {traced ? "Reset" : "Trace my leaf"}
        </button>
        <p className="font-mono text-[10px] tracking-wider text-faint-foreground uppercase">preview · sample tree</p>
      </div>
    </section>
  );
}
