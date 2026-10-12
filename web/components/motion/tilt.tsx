"use client";

import { motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";

/** Hover tilt for cards (FRONTEND.md moment 8): at most `max` degrees, fine pointers only, no overshoot. */
export function Tilt({ children, className, max = 3 }: { children: React.ReactNode; className?: string; max?: number }) {
  const reduce = useReducedMotion();
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const sx = useSpring(rx, { stiffness: 260, damping: 30 });
  const sy = useSpring(ry, { stiffness: 260, damping: 30 });

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (reduce || e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    ry.set(px * max * 2);
    rx.set(-py * max * 2);
  };
  const reset = () => {
    rx.set(0);
    ry.set(0);
  };

  return (
    <motion.div
      className={className}
      onPointerMove={onMove}
      onPointerLeave={reset}
      style={{ rotateX: sx, rotateY: sy, transformPerspective: 600 }}
    >
      {children}
    </motion.div>
  );
}
