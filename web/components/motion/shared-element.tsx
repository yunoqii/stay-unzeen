"use client";

// Card -> token page shared element (FRONTEND.md moment 8).
//
// Motion's `layoutId` animates between two elements only while both are mounted in one tree. An App
// Router navigation unmounts the list page before the token page mounts (and the token page suspends
// on its data), so the previous snapshot is gone by then. Same idea, done by hand: the source records
// the rect of every [data-shared-id] inside the clicked card; the target with the same id plays a FLIP
// from that rect with Motion's `animate`. Within one page, plain `layoutId` still applies.

import { useEffect, useRef } from "react";
import { animate, useReducedMotion } from "motion/react";

interface Snap {
  rect: DOMRect;
  at: number;
}

const snaps = new Map<string, Snap>();
const MAX_AGE_MS = 1_500;

/** Call from a card's onClick: remembers where its shared parts were on screen. */
export function captureShared(root: Element | null) {
  if (!root) return;
  const now = performance.now();
  root.querySelectorAll<HTMLElement>("[data-shared-id]").forEach((el) => {
    snaps.set(el.dataset.sharedId!, { rect: el.getBoundingClientRect(), at: now });
  });
}

/** Mark an element as a shared part of a card. */
export const sharedProps = (id: string) => ({ "data-shared-id": id });

/** Target side: flies in from the captured rect, if the user just came from a card. */
export function SharedTarget({ id, className, children }: { id: string; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const snap = snaps.get(id);
    snaps.delete(id);
    const el = ref.current;
    if (!el || !snap || reduce || performance.now() - snap.at > MAX_AGE_MS) return;
    // Hidden for one frame so the router can restore scroll; then measure the real end position.
    el.style.opacity = "0";
    const raf = requestAnimationFrame(() => {
      const to = el.getBoundingClientRect();
      const from = snap.rect;
      if (!to.width || !to.height) {
        el.style.opacity = "";
        return;
      }
      const dx = from.left + from.width / 2 - (to.left + to.width / 2);
      const dy = from.top + from.height / 2 - (to.top + to.height / 2);
      const s = from.height / to.height;
      el.style.opacity = "";
      animate(
        el,
        { transform: [`translate(${dx}px, ${dy}px) scale(${s})`, "translate(0px, 0px) scale(1)"] },
        { type: "spring", bounce: 0, duration: 0.45 },
      );
    });
    return () => {
      cancelAnimationFrame(raf);
      el.style.opacity = "";
    };
  }, [id, reduce]);

  return (
    <div ref={ref} className={className} style={{ transformOrigin: "50% 50%" }}>
      {children}
    </div>
  );
}
