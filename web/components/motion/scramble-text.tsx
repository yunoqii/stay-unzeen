"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";

const GLYPHS = "░▒▓abcdefghijklmnopqrstuvwxyz";

interface Props {
  text: string;
  durationMs?: number;
  className?: string;
}

/**
 * Text resolves from noise into `text` once, on mount. Writes to the DOM node
 * directly so the scramble does not re-render React.
 */
export function ScrambleText({ text, durationMs = 300, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el || reduce) return;
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      const settled = Math.floor(p * text.length);
      let out = text.slice(0, settled);
      for (let i = settled; i < text.length; i++) {
        out += GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      el.textContent = out;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      el.textContent = text;
    };
  }, [text, durationMs, reduce]);

  return (
    <span aria-label={text} className={className}>
      <span ref={ref} aria-hidden>
        {text}
      </span>
    </span>
  );
}
