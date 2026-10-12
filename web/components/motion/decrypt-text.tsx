"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";

const GLYPHS = "░▒▓";

/**
 * Text that "decrypts" from shade glyphs into its value, left to right, once per mount (Peek). Only
 * letters and digits are masked, so separators and units hold their place and nothing jumps.
 * Writes to the DOM node directly (no React re-render per frame); reduced motion = plain text.
 */
export function DecryptText({ text, durationMs = 420, className }: { text: string; durationMs?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el || reduce) return;
    const chars = [...text];
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      const settled = Math.floor(p * chars.length);
      let out = "";
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        out += i < settled || !/[0-9A-Za-z]/.test(c) ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0];
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
    <span ref={ref} className={className}>
      {text}
    </span>
  );
}
