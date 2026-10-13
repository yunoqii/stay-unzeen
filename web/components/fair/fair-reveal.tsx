"use client";

import { useEffect, useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { DecryptText } from "@/components/motion/decrypt-text";
import { ProgressRing } from "@/components/motion/progress-ring";
import { SealedMark } from "./sealed-mark";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Preview data only: sealed bids of a fair launch (tlock to a drand round), revealed together. */
const BIDS = ["0.42", "1.10", "0.08", "2.50", "0.75", "0.20", "1.95", "0.33"];
const WINDOW_S = 14;
const GLYPHS = "▓▒░";
const CLEARING = 3.1e-7;

function sealed(seed: number): string {
  let out = "";
  for (let i = 0; i < 7; i++) out += GLYPHS[(seed * 7 + i * 3) % 3];
  return out;
}

type Phase = "open" | "revealed";

/**
 * Fair-launch reveal, preview. While the window is open every bid is a row of shade glyphs and the ring
 * counts down to the drand round. At the round all bids decrypt at once and resolve to one price.
 */
export function FairReveal() {
  const [phase, setPhase] = useState<Phase>("open");
  const [left, setLeft] = useState(WINDOW_S);
  const reduce = useReducedMotion();
  const id = useId();

  useEffect(() => {
    if (phase !== "open") return;
    let l = WINDOW_S;
    const t = setInterval(() => {
      l -= 1;
      setLeft(Math.max(0, l));
      if (l <= 0) setPhase("revealed"); // the drand round arrived
    }, 1000);
    return () => clearInterval(t);
  }, [phase]);

  const reset = () => {
    setLeft(WINDOW_S);
    setPhase("open");
  };
  const total = BIDS.reduce((a, b) => a + Number(b), 0);

  return (
    <section aria-labelledby={`${id}-t`} className="grid gap-px bg-border md:grid-cols-[260px_minmax(0,1fr)]">
      <div className="flex flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <ProgressRing
          value={phase === "open" ? ((WINDOW_S - left) / WINDOW_S) * 100 : 100}
          size={128}
          stroke={2}
          label={phase === "open" ? `Bids sealed, reveal in ${left} seconds` : "Bids revealed"}
        >
          <span className="grid place-items-center">
            <SealedMark revealed={phase === "revealed"} size={44} />
            <span className="tabular mt-1 font-mono text-lg">{phase === "open" ? `${left}s` : "open"}</span>
          </span>
        </ProgressRing>
        <div>
          <h3 id={`${id}-t`} className="text-sm font-medium">
            {phase === "open" ? "Window open · bids sealed" : "Revealed at drand round"}
          </h3>
          <p className="mt-1 text-xs text-pretty text-faint-foreground">
            Bids are time-locked to a future drand round. Nobody, including us, can read them before it.
          </p>
        </div>
        <div className="flex gap-2">
          {phase === "open" ? (
            <button
              type="button"
              onClick={() => setPhase("revealed")}
              className="h-8 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Skip to reveal
            </button>
          ) : (
            <button
              type="button"
              onClick={reset}
              className="h-8 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Seal again
            </button>
          )}
        </div>
      </div>

      <div className="min-w-0 bg-background">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5 text-xs text-faint-foreground">
          <span>Sealed bids</span>
          <span className="font-mono tracking-wider uppercase">preview · sample data</span>
        </div>
        <ol className="divide-y divide-border/60">
          {BIDS.map((b, i) => (
            <li key={i} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
              <span className="text-muted-foreground">
                <span className="text-foreground/90">unzeen</span> bid #{i + 1}
              </span>
              <span className={cn("tabular font-mono", phase === "open" ? "text-faint-foreground" : "text-foreground")}>
                {phase === "open" ? (
                  <motion.span
                    aria-label="sealed"
                    animate={reduce ? undefined : { opacity: [0.45, 0.85, 0.45] }}
                    transition={{ duration: 1.8, repeat: Infinity, delay: i * 0.12 }}
                  >
                    {sealed(i)}
                  </motion.span>
                ) : (
                  <motion.span initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} transition={{ delay: reduce ? 0 : i * 0.06 }}>
                    <DecryptText text={`${b} ZEC`} durationMs={380 + i * 70} />
                  </motion.span>
                )}
              </span>
            </li>
          ))}
        </ol>
        <AnimatePresence initial={false}>
          {phase === "revealed" && (
            <motion.div
              key="price"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.35, delay: reduce ? 0 : 0.6, ease: [0.16, 1, 0.3, 1] }}
              style={{ overflow: "hidden" }}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-zec/30 bg-zec/[0.05] px-4 py-3 text-sm">
                <span>
                  One price for everyone: <span className="tabular font-medium text-zec">{formatPrice(CLEARING)} SOL</span>
                </span>
                <span className="tabular text-xs text-muted-foreground">{total.toFixed(2)} ZEC in one atomic create + buy</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
