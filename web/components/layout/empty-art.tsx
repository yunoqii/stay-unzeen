"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Empty-state illustration (owner art, web/public/illustrations/empty.webp, redrawn in CSS so one detail can
 * live): a ledger of three lines, the middle one taped over. M7 "Someone was here" (motion-v2): that tape
 * drifts slowly (14 s, linear, endless), only while on screen; reduced motion keeps it still.
 */
export function EmptyArt() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} aria-hidden className="relative mb-3 grid w-full max-w-[240px] gap-3.5 py-2 opacity-80">
      <i className="block h-px bg-[var(--uz-fog-1)]" />
      <div className="relative ml-3 h-4 border-y border-[var(--uz-fog-1)]">
        <span className="uz-drift absolute inset-0" style={{ animationPlayState: visible ? "running" : "paused" }} />
        <span className="absolute top-1/2 -left-3 size-1.5 -translate-y-1/2 rounded-full bg-zec" />
      </div>
      <i className="block h-px bg-[var(--uz-fog-1)]" />
    </div>
  );
}
