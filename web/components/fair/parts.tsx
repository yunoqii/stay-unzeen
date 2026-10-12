"use client";

import { motion, useReducedMotion } from "motion/react";
import { LockSimple, LockSimpleOpen } from "@phosphor-icons/react";
import type { FairLaunch, FairLaunchStatus } from "@/lib/api/types";
import { roundAt } from "@/lib/fair/drand";
import { cn } from "@/lib/utils";
import { ProgressRing } from "@/components/motion/progress-ring";

export const GLYPHS = "▓▒░";

/** Countdown text: 1:05:09, 4:07, 0:09. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function windowLabel(secs: number): string {
  if (secs < 3600) return `${Math.round(secs / 60)} min`;
  return `${Math.round(secs / 3600)} h`;
}

export const STATUS_LABEL: Record<FairLaunchStatus | "scheduled", string> = {
  scheduled: "Scheduled",
  open: "Bids open",
  closed: "Window closed",
  revealing: "Opening bids",
  executing: "Launching",
  launched: "Launched",
  failed: "Released",
  cancelled: "Cancelled",
};

export function StatusPill({ status, className }: { status: FairLaunchStatus | "scheduled"; className?: string }) {
  const live = status === "open" || status === "closed" || status === "revealing" || status === "executing";
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11px] whitespace-nowrap",
        status === "launched" ? "border-zec/40 text-zec" : live ? "border-border-strong text-foreground" : "border-border text-muted-foreground",
        className,
      )}
    >
      {live && (
        <span aria-hidden className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-zec/60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-1.5 rounded-full bg-zec" />
        </span>
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}

/** A row of shade glyphs standing in for a sealed number. Breathes slowly; still under reduced motion. */
export function SealedGlyphs({ length = 7, seed = 0, className }: { length?: number; seed?: number; className?: string }) {
  const reduce = useReducedMotion();
  let s = "";
  for (let i = 0; i < length; i++) s += GLYPHS[(seed * 7 + i * 3 + ((i * i) % 5)) % 3];
  return (
    <motion.span
      aria-label="sealed"
      className={cn("font-mono tracking-tight text-faint-foreground", className)}
      animate={reduce ? undefined : { opacity: [0.45, 0.9, 0.45] }}
      transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
    >
      {s}
    </motion.span>
  );
}

const pct = (from: number, to: number, now: number) => (to <= from ? 100 : Math.max(0, Math.min(100, ((now - from) / (to - from)) * 100)));

/**
 * Two concentric rings: the outer one fills over the bid window, the inner one from close to the drand
 * round. The centre counts down the phase that is running now. Time is local (round time from the API),
 * nothing asks drand.
 */
export function SealedRings({ launch, now }: { launch: Pick<FairLaunch, "publishedAt" | "closeAt" | "drand" | "status">; now: number }) {
  const { publishedAt, closeAt, drand, status } = launch;
  const open = status === "open" && now < closeAt;
  const waiting = !open && (status === "open" || status === "closed") && now < drand.roundTime;
  const done = status === "launched";
  const ended = status === "failed" || status === "cancelled";
  const outer = ended && status === "cancelled" ? pct(publishedAt, closeAt, Math.min(now, closeAt)) : pct(publishedAt, closeAt, now);
  const inner = open ? 0 : pct(closeAt, drand.roundTime, now);
  const center = open ? countdown(closeAt - now) : waiting ? countdown(drand.roundTime - now) : done ? "live" : ended ? "—" : "0:00";
  const label = open
    ? `Bid window closes in ${center}`
    : waiting
      ? `drand round ${drand.round} in ${center}`
      : done
        ? "Launched"
        : ended
          ? STATUS_LABEL[status]
          : `drand round ${drand.round} reached`;
  return (
    <div className="relative grid size-[184px] place-items-center">
      <ProgressRing value={outer} size={184} stroke={2} label={label} className="absolute inset-0" />
      <span aria-hidden className="absolute top-[17px] left-[17px] opacity-70">
        <ProgressRing value={inner} size={150} stroke={1.5} label="Time to the drand round" />
      </span>
      <span className="relative grid place-items-center text-center" aria-hidden>
        {open || waiting ? <LockSimple size={16} weight="light" className="text-muted-foreground" /> : <LockSimpleOpen size={16} weight="light" className={done ? "text-zec" : "text-muted-foreground"} />}
        <span className="tabular mt-1 font-mono text-3xl tracking-tight">{center}</span>
        <span className="mt-0.5 text-[11px] text-faint-foreground">{open ? "until close" : waiting ? "until the round" : done ? "one price" : ended ? STATUS_LABEL[status].toLowerCase() : "round reached"}</span>
      </span>
    </div>
  );
}

/** "drand round #R · now #r" ticking locally every 3 s. */
export function RoundTicker({ round, now }: { round: number; now: number }) {
  const current = roundAt(now);
  return (
    <p className="tabular font-mono text-xs text-faint-foreground">
      drand round <span className="text-muted-foreground">#{round.toLocaleString("en-US")}</span>
      <span className="mx-1.5">·</span>
      now <span className={cn(current >= round ? "text-zec" : "text-muted-foreground")}>#{current.toLocaleString("en-US")}</span>
    </p>
  );
}
