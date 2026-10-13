"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Check } from "@phosphor-icons/react";
import type { WithdrawPart } from "@/lib/api/types";
import { formatCompact, shortAddr, unitsToNumber } from "@/lib/format";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { countdown, partState } from "@/lib/withdraw-parts";

const ROW = 34;
/** Room for the widest chip at the end of a lane. */
const CHIP_ROOM = 104;

/**
 * M4 Split and scatter (docs/design/motion-v2.md), on the real schedule (API v0.17 ActionStatus.parts):
 * each chip is one part with its real (rounded) size, travelling along its lane in real time and reaching
 * its fresh address at the part's own `notBefore`. Then it waits there ("sending") and dissolves into the
 * address once the withdrawal settles. Parts come from one owner-only read right after signing; nothing is
 * polled per action. Transform, opacity and filter only; time is linear because it is a clock, not a gesture.
 * Without parts (older server, read failed) it falls back to the illustration with no sums.
 * Reduced motion: chips are placed at their current progress, no travel.
 */
export function ScatterParts({
  label,
  addrs,
  maxDelayMin,
  parts,
  decimals,
  startedAt,
  settled,
}: {
  label: string;
  addrs: string[];
  maxDelayMin: number;
  parts?: WithdrawPart[] | null;
  decimals?: number;
  startedAt: number;
  settled: "executed" | "failed" | null;
}) {
  const reduce = useReducedMotion();
  const lane = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const now = useNow(1000);
  const n = addrs.length;
  const real = parts && parts.length === n && decimals !== undefined ? parts : null;

  useEffect(() => {
    const el = lane.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const within = maxDelayMin < 60 ? `${maxDelayMin} min` : `${maxDelayMin / 60} h`;
  const travel = Math.max(0, width - CHIP_ROOM);
  const lastAt = real ? Math.max(...real.map((p) => p.notBefore)) : null;
  const states = real && now !== null ? real.map((p) => partState(p, now, settled)) : null;
  const done = states?.filter((s) => s === "confirmed").length ?? 0;

  return (
    <figure className="rounded-2xl border border-border bg-surface-1 p-4">
      <figcaption className="sr-only">
        {real && now !== null
          ? `Sent as ${n} parts, each to its own fresh address. ${done} of ${n} delivered.`
          : `Sent as ${n} parts, each to its own fresh address, each at its own random time within ${within}.`}
      </figcaption>
      <div aria-hidden className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
        <span className="tabular rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm font-medium whitespace-nowrap">{label}</span>
        <div ref={lane} className="relative" style={{ height: n * ROW }}>
          {addrs.map((_, i) => (
            <span
              key={`l${i}`}
              className="absolute inset-x-0 h-px bg-[repeating-linear-gradient(to_right,var(--uz-fog-1)_0_4px,transparent_4px_9px)]"
              style={{ top: i * ROW + ROW / 2 }}
            />
          ))}
          {width > 0 && real && now !== null
            ? real.map((p, i) => {
                const st = states![i];
                const span = Math.max(1, p.notBefore - startedAt);
                const progress = Math.min(1, Math.max(0, (now - startedAt) / span));
                const y = i * ROW + 8;
                const amount = `≈ ${formatCompact(unitsToNumber(p.amount, decimals!))}`;
                const text = st === "travel" ? `${amount} · ${countdown(p.notBefore - now)}` : st === "due" || st === "sent" ? `${amount} · sending` : amount;
                const moving = st === "travel" && !reduce;
                return (
                  <motion.span
                    // A new key per width: the clock restarts from the current position, never from zero.
                    key={`p${i}-${Math.round(travel)}`}
                    className={cn(
                      "tabular absolute left-0 rounded-full border bg-surface-3 px-2 py-0.5 font-mono text-[11px] whitespace-nowrap text-foreground",
                      st === "failed" ? "border-sell/50 text-sell" : "border-zec/35",
                    )}
                    style={{ top: 0 }}
                    initial={{ x: travel * progress, y, opacity: 1, filter: "blur(0px)" }}
                    animate={
                      st === "confirmed"
                        ? { x: travel, y, opacity: 0, filter: reduce ? "blur(0px)" : "blur(6px)" }
                        : st === "travel"
                          ? { x: reduce ? travel * progress : travel, y, opacity: 1 }
                          : st === "failed"
                            ? { x: travel * progress, y, opacity: 1 }
                            : { x: travel, y, opacity: reduce ? 1 : [1, 0.55, 1] }
                    }
                    transition={
                      moving
                        ? { x: { duration: Math.max(0, (p.notBefore - now) / 1000), ease: "linear" } }
                        : st === "due" || st === "sent"
                          ? { x: { duration: reduce ? 0 : 0.4, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 1.6, repeat: reduce ? 0 : Infinity, ease: "easeInOut" } }
                          : { duration: reduce ? 0 : 0.5, ease: [0.16, 1, 0.3, 1] }
                    }
                  >
                    {text}
                  </motion.span>
                );
              })
            : width > 0 && <Illustration n={n} travel={travel} reduce={!!reduce} />}
        </div>
        <span className="flex flex-col gap-[10px]">
          {addrs.map((a, i) => {
            const ok = states?.[i] === "confirmed";
            return (
              <span
                key={`d${i}`}
                className={cn(
                  "inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 font-mono text-[11px] transition-colors duration-300",
                  ok ? "border-zec/50 text-foreground" : "border-dashed border-border-strong text-muted-foreground",
                )}
              >
                {shortAddr(a, 3, 3)}
                {ok && <Check size={10} weight="bold" className="text-zec" />}
              </span>
            );
          })}
        </span>
      </div>
      <p className="mt-3 flex justify-between font-mono text-[10px] text-faint-foreground">
        <span>signed</span>
        <span>
          {real && now !== null && lastAt !== null
            ? settled === "executed"
              ? `${n} of ${n} delivered`
              : lastAt > now
                ? `last part in ${countdown(lastAt - now)}`
                : `${done} of ${n} delivered`
            : `within ${within}`}
        </span>
      </p>
      <p className="mt-2 text-xs text-pretty text-muted-foreground">
        {real
          ? `${n} uneven parts, each to its own fresh address, each at its own random time. These are the pool's real sizes and times, shown only to you: each part is rounded, so together they never add up to your buy.`
          : `${n} uneven parts, each to its own fresh address, each at its own random time within ${within}. The pool picks the sizes and times: the race above only shows the idea.`}
      </p>
    </figure>
  );
}

/** Fallback without parts: the compressed race of the original M4, no sums. */
function Illustration({ n, travel, reduce }: { n: number; travel: number; reduce: boolean }) {
  const leave = Array.from({ length: n }, (_, i) => [0.05, 0.62, 0.3, 0.85, 0.45][i % 5]);
  return (
    <>
      {leave.map((at, i) => {
        const y = i * ROW + 8;
        const mid = (n * ROW) / 2 - 9;
        return (
          <motion.span
            key={`p${i}`}
            className="tabular absolute left-0 rounded-full border border-zec/35 bg-surface-3 px-2 py-0.5 font-mono text-[11px] whitespace-nowrap text-foreground"
            style={{ top: 0 }}
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
    </>
  );
}
