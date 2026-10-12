"use client";

import { useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { EyeSlash, HandPointing } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

// Decoys shown (blurred) while the phrase is hidden, so the real words are not in the DOM at all.
const DECOYS = ["shadow", "silent", "hidden", "orbit", "velvet", "ember", "cipher", "lunar", "quiet", "drift", "vapor", "night"];

const HOLD_MS = 1100;

interface Props {
  words: string[];
  /** Fires the first time the words are revealed. */
  onReveal?: () => void;
}

/** 12 words, blurred until the user presses and holds. Re-hides when the tab is hidden. */
export function PhraseGrid({ words, onReveal }: Props) {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const hide = () => document.visibilityState === "hidden" && setRevealed(false);
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);

  const reveal = () => {
    setRevealed(true);
    onReveal?.();
  };

  return (
    <div className="relative">
      <ol
        aria-label={revealed ? "Recovery phrase" : "Recovery phrase, hidden"}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      >
        {words.map((w, i) => (
          <li
            key={i}
            className="flex items-baseline gap-2.5 rounded-lg border border-border bg-phrase-cell px-3 py-2.5"
          >
            <span className="tabular w-5 shrink-0 text-right font-mono text-[11px] text-faint-foreground">{i + 1}</span>
            <motion.span
              key={revealed ? "real" : "decoy"}
              initial={revealed ? { filter: "blur(8px)", opacity: 0.4 } : false}
              animate={{ filter: revealed ? "blur(0px)" : "blur(7px)", opacity: revealed ? 1 : 0.55 }}
              transition={{ duration: 0.3, delay: revealed ? i * 0.015 : 0, ease: [0.16, 1, 0.3, 1] }}
              aria-hidden={!revealed}
              className={cn("font-mono text-[15px] tracking-tight", !revealed && "select-none")}
            >
              {revealed ? w : DECOYS[i % DECOYS.length]}
            </motion.span>
          </li>
        ))}
      </ol>

      <div className="mt-4 flex justify-center">
        {revealed ? (
          <button
            type="button"
            onClick={() => setRevealed(false)}
            className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <EyeSlash size={16} weight="light" />
            Hide words
          </button>
        ) : (
          <HoldToReveal onComplete={reveal} />
        )}
      </div>
    </div>
  );
}

/** Press and hold (pointer, or Space / Enter) to fill; release early and it drains. */
function HoldToReveal({ onComplete }: { onComplete: () => void }) {
  const progress = useMotionValue(0);
  const scaleX = useTransform(progress, [0, 1], [0, 1]);
  const ctrl = useRef<ReturnType<typeof animate> | null>(null);
  // The reveal is driven by a timer, not by the fill animation, so it still works when
  // animation frames are throttled or reduced motion is on. The fill is only feedback.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holding = useRef(false);

  const start = () => {
    if (holding.current) return;
    holding.current = true;
    const remaining = HOLD_MS * (1 - progress.get());
    ctrl.current?.stop();
    ctrl.current = animate(progress, 1, { duration: remaining / 1000, ease: "linear" });
    timer.current = setTimeout(() => {
      holding.current = false;
      onComplete();
    }, remaining);
  };

  const cancel = () => {
    if (!holding.current) return;
    holding.current = false;
    clearTimeout(timer.current);
    ctrl.current?.stop();
    ctrl.current = animate(progress, 0, { duration: 0.2, ease: "easeOut" });
  };

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      ctrl.current?.stop();
    },
    [],
  );

  return (
    <button
      type="button"
      onPointerDown={(e) => {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointer: no capture, still works */
        }
        start();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") cancel();
      }}
      onBlur={cancel}
      onContextMenu={(e) => e.preventDefault()}
      aria-label="Hold to reveal the recovery phrase"
      className="relative isolate inline-flex h-12 touch-none items-center gap-2 overflow-hidden rounded-full border border-zec/40 px-6 text-sm font-medium text-foreground select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [-webkit-touch-callout:none]"
    >
      <motion.span aria-hidden style={{ scaleX }} className="absolute inset-0 -z-10 origin-left bg-hold-fill" />
      <HandPointing size={18} weight="light" className="text-zec" />
      Hold to reveal
    </button>
  );
}
