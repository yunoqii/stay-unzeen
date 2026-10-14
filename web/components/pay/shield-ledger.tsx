"use client";

import { useEffect, useRef } from "react";
import { animate, useReducedMotion } from "motion/react";
import { formatZec } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RedactionTape } from "@/components/motion/redaction-tape";
import { CoinZec } from "@/components/icons/coin-zec";

/**
 * M1 Shielding tape (docs/design/motion-v2.md): when the deposit is credited the "Incoming" line is taped
 * over (the money left its sender and is now unlinkable), then the private balance counts up, no overshoot,
 * and its digits fade from yellow to paper. Reduced motion: the tape fades in, the balance shows its final value.
 */
export function ShieldLedger({ incomingZat, balanceZat, credited }: { incomingZat: string | null; balanceZat: string | null; credited: boolean }) {
  return (
    <div className="grid gap-2" aria-live="polite">
      <Line label="Incoming · shielded ZEC">
        <span className="relative inline-block px-0.5">
          {incomingZat ? formatZec(incomingZat) : "—"}
          <span className="ml-1 inline-flex items-baseline gap-1 text-sm font-normal text-muted-foreground">
            <CoinZec size={13} />
            ZEC
          </span>
          {credited && <RedactionTape state="covered" />}
        </span>
      </Line>
      <Line label="Private balance">
        {credited && balanceZat ? <Counted zat={balanceZat} from={incomingZat} /> : <span className="text-faint-foreground">—</span>}
        <span className="ml-1 inline-flex items-baseline gap-1 text-sm font-normal text-muted-foreground">
          <CoinZec size={13} />
          ZEC
        </span>
      </Line>
      <p className="px-1 font-mono text-[11px] text-faint-foreground">
        {credited ? (
          <>
            <span className="text-zec">Credited</span> · shielded, unlinkable
          </>
        ) : (
          "Not on your balance yet"
        )}
      </p>
    </div>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-xl border border-border bg-surface-1 px-3.5 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="tabular text-lg font-medium tracking-tight">{children}</span>
    </div>
  );
}

/** Counts the balance up from what it was before this deposit (600 ms, ease-out quart), then yellow → paper. */
function Counted({ zat, from }: { zat: string; from: string | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const end = Number(zat);
    if (reduce || !Number.isFinite(end)) {
      el.textContent = formatZec(zat);
      return;
    }
    const start = Math.max(0, end - Number(from ?? 0));
    const count = animate(start, end, {
      duration: 0.6,
      delay: 0.42, // after the tape has covered the incoming line
      ease: [0.25, 1, 0.5, 1],
      onUpdate: (v) => {
        el.textContent = formatZec(String(Math.round(v)));
      },
      onComplete: () => {
        el.textContent = formatZec(zat);
      },
    });
    const tint = animate(el, { color: ["var(--uz-zec)", "var(--uz-paper)"] }, { duration: 0.9, delay: 0.42, ease: "linear" });
    return () => {
      count.stop();
      tint.stop();
    };
  }, [zat, from, reduce]);
  return <span ref={ref} className={cn("tabular")}>{formatZec(zat)}</span>;
}
