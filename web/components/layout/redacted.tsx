"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";

/**
 * A word under redaction tape. Hover, focus or tap lifts the tape (and it drops back): the same
 * "hidden until you look" feedback as Peek, used on the 404.
 */
export function Redacted({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  return (
    <button
      type="button"
      aria-pressed={open}
      aria-label={open ? text : "Redacted. Press to reveal."}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={() => setOpen((o) => !o)}
      className={`relative inline-block rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${className ?? ""}`}
    >
      <span aria-hidden className={open ? "text-foreground" : "text-transparent"}>
        {text}
      </span>
      <motion.span
        aria-hidden
        className="hatch-zec absolute inset-y-[12%] -inset-x-1 origin-right rounded-sm border border-zec/40 bg-[var(--uz-ink-1)]"
        initial={false}
        animate={{ scaleX: open ? 0 : 1 }}
        transition={reduce ? { duration: 0 } : { duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      />
    </button>
  );
}
