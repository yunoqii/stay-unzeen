"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { RedactionTape } from "./redaction-tape";

const SHADE = "░▒▓";
/** What sits in the slot before it collapses: the feed carries no vault address, so a shade of its length. */
const RAW = "▓▒░▓▒░▓▒░";

/** One collapse at a time across the page; rows that arrive meanwhile just appear (no queue builds up). */
let owner: string | null = null;
let ownerUntil = 0;
function claim(id: string, ms: number): boolean {
  const now = performance.now();
  if (owner === id) return true;
  if (owner !== null && now < ownerUntil) return false;
  owner = id;
  ownerUntil = now + ms;
  return true;
}

type Phase = "wait" | "shade" | "taped" | "lifting" | "done";

/**
 * M2 Identity collapse (docs/design/motion-v2.md): the "who" slot of a fresh feed row is a shade
 * (░▒▓), redaction tape sweeps over it (180 ms), underneath it becomes "unzeen", the tape lifts to the
 * right (220 ms). ≈ 900 ms, one row at a time. Only the pool's public side is ever shown here: never
 * anything tied to a user. Reduced motion: "unzeen" at once.
 */
export function CollapseIdentity({
  id,
  play,
  delayMs = 260,
  exclusive = true,
  text = "unzeen",
  className,
}: {
  /** Stable id (the event id): the lock survives StrictMode double effects. */
  id: string;
  play: boolean;
  delayMs?: number;
  /** false: plays even while another row collapses (the hero's opening cascade). */
  exclusive?: boolean;
  text?: string;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<Phase>(play ? "wait" : "done");
  const raw = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!play || reduce || (exclusive && !claim(id, delayMs + 900))) {
      const t = setTimeout(() => setPhase("done"), 0);
      return () => clearTimeout(t);
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    let raf = 0;
    timers.push(
      setTimeout(() => {
        setPhase("shade");
        // 220 ms: the shade flickers left to right (DOM writes, no React renders).
        const t0 = performance.now();
        const step = (t: number) => {
          const p = Math.min(1, (t - t0) / 220);
          const k = Math.floor(p * RAW.length);
          let s = "";
          for (let j = 0; j < RAW.length; j++) s += j < k ? SHADE[(j + Math.floor(t / 40)) % 3] : RAW[j];
          if (raw.current) raw.current.textContent = s;
          if (p < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
      }, delayMs),
    );
    timers.push(setTimeout(() => setPhase("taped"), delayMs + 220));
    timers.push(setTimeout(() => setPhase("lifting"), delayMs + 220 + 180));
    timers.push(setTimeout(() => setPhase("done"), delayMs + 220 + 180 + 240));
    return () => {
      timers.forEach(clearTimeout);
      cancelAnimationFrame(raf);
    };
  }, [id, play, reduce, delayMs, exclusive]);

  const shaded = phase === "wait" || phase === "shade" || phase === "taped";
  return (
    <span aria-label={text} className={cn("relative inline-block", className)}>
      {shaded ? (
        <span ref={raw} aria-hidden className="font-mono text-[0.85em] tracking-tight text-faint-foreground">
          {RAW}
        </span>
      ) : (
        <span aria-hidden>{text}</span>
      )}
      {(phase === "taped" || phase === "lifting") && <RedactionTape state={phase === "taped" ? "covered" : "lifted"} coverMs={180} className="-inset-x-0.5 inset-y-[0.12em]" />}
    </span>
  );
}
