"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { MotionConfig } from "motion/react";
import { Pause, Play } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/**
 * Landing motion switch. "Pause animations" stops every loop on the page: Motion falls back to its
 * reduced-motion mode, CSS loops freeze (data-paused on the wrapper), scripted scenes jump to their last
 * frame. The OS setting (prefers-reduced-motion) does the same without a click. The choice is a per-browser
 * convenience in localStorage and never leaves the device.
 */
const KEY = "uz-landing-paused";

interface MotionPref {
  /** true: show still frames, run no loops. */
  still: boolean;
  paused: boolean;
  toggle: () => void;
}

const Ctx = createContext<MotionPref>({ still: false, paused: false, toggle: () => {} });

function subscribeReduce(cb: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const getReduce = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function LandingMotion({ children }: { children: React.ReactNode }) {
  const reduce = useSyncExternalStore(subscribeReduce, getReduce, () => false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let saved = false;
    try {
      saved = localStorage.getItem(KEY) === "1";
    } catch {
      /* storage blocked: start playing */
    }
    if (saved) {
      const t = setTimeout(() => setPaused(true), 0);
      return () => clearTimeout(t);
    }
  }, []);

  const toggle = useCallback(() => {
    setPaused((p) => {
      try {
        localStorage.setItem(KEY, p ? "0" : "1");
      } catch {
        /* not saved; the toggle still works for this visit */
      }
      return !p;
    });
  }, []);

  const value = useMemo(() => ({ still: paused || reduce, paused, toggle }), [paused, reduce, toggle]);
  return (
    <Ctx.Provider value={value}>
      <MotionConfig reducedMotion={paused ? "always" : "user"}>
        <div data-paused={value.still ? "" : undefined} className="landing relative isolate overflow-x-clip">
          {children}
        </div>
      </MotionConfig>
    </Ctx.Provider>
  );
}

export const useLandingMotion = () => useContext(Ctx);

export function PauseToggle({ className }: { className?: string }) {
  const { paused, toggle } = useLandingMotion();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={paused}
      className={cn(
        "hit inline-flex h-9 items-center gap-2 rounded-full px-3 text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className,
      )}
    >
      {paused ? <Play size={14} weight="fill" aria-hidden /> : <Pause size={14} weight="fill" aria-hidden />}
      <span className="max-lg:sr-only">{paused ? "Play animations" : "Pause animations"}</span>
    </button>
  );
}

/**
 * Runs a looping scene clock while `active` and not still. Returns the step index (0..steps-1).
 * When still, it rests on `restStep` (default: the last step, the fully explained frame).
 */
export function useSceneClock({ steps, stepMs, active, loop = true, restStep }: { steps: number; stepMs: number | readonly number[]; active: boolean; loop?: boolean; restStep?: number }) {
  const { still } = useLandingMotion();
  const [step, setStep] = useState(0);
  const durations = typeof stepMs === "number" ? null : stepMs;
  const flat = typeof stepMs === "number" ? stepMs : 0;

  useEffect(() => {
    if (!active || still) return;
    const ms = durations ? (durations[step] ?? 1000) : flat;
    if (!loop && step >= steps - 1) return;
    const t = setTimeout(() => setStep((s) => (s + 1 >= steps ? 0 : s + 1)), ms);
    return () => clearTimeout(t);
  }, [active, still, step, steps, durations, flat, loop]);

  // Reset to the first frame each time the scene becomes active again.
  useEffect(() => {
    if (!active) {
      const t = setTimeout(() => setStep(0), 0);
      return () => clearTimeout(t);
    }
  }, [active]);

  return still ? (restStep ?? steps - 1) : step;
}
