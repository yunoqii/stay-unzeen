"use client";

// Proximity-spring navigation: items near the pointer swell and drop a little, the rest settle.
// Behaviour adapted from "Animated Top Dock" by Sable on ThreeUI (https://threeui.com,
// MIT License, Meng To / Design+Code): the smoothstep proximity field and the spring per item.
// Rebuilt on Motion with transforms only (no width/height writes, no Three.js), recoloured to unzeen,
// and switched off for touch, narrow screens and reduced motion.

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from "motion/react";

const PROXIMITY_PX = 110;
const DockContext = createContext<MotionValue<number> | null>(null);

function useFinePointer(): boolean {
  const [fine, setFine] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 768px)");
    const on = () => setFine(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return fine;
}

/** The track: reports the pointer x to its items. Off = plain list. */
export function ProximityDock({ enabled, className, children }: { enabled: boolean; className?: string; children: React.ReactNode }) {
  const x = useMotionValue(Number.NEGATIVE_INFINITY);
  const reduce = useReducedMotion();
  const fine = useFinePointer();
  const live = enabled && fine && !reduce;
  return (
    <DockContext.Provider value={live ? x : null}>
      <ul
        className={className}
        onPointerMove={live ? (e) => x.set(e.clientX) : undefined}
        onPointerLeave={live ? () => x.set(Number.NEGATIVE_INFINITY) : undefined}
      >
        {children}
      </ul>
    </DockContext.Provider>
  );
}

export function DockItem({ className, children }: { className?: string; children: React.ReactNode }) {
  const x = useContext(DockContext);
  if (!x) return <li className={className}>{children}</li>;
  return (
    <LiveItem x={x} className={className}>
      {children}
    </LiveItem>
  );
}

function LiveItem({ x, className, children }: { x: MotionValue<number>; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLLIElement>(null);
  const influence = useTransform(x, (px) => {
    const el = ref.current;
    if (!el || !Number.isFinite(px)) return 0;
    const r = el.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, 1 - Math.abs(px - (r.left + r.width / 2)) / PROXIMITY_PX));
    return p * p * (3 - 2 * p); // smoothstep
  });
  const v = useSpring(influence, { stiffness: 380, damping: 26, mass: 0.6 });
  const scale = useTransform(v, (k) => 1 + 0.07 * k);
  const y = useTransform(v, (k) => 2.5 * k);
  return (
    <motion.li ref={ref} style={{ scale, y }} className={className}>
      {children}
    </motion.li>
  );
}
