"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { LockSimple, LockSimpleOpen } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
// Imported (not served from /public) so the asset is emitted only into a build that compiles fair launch in.
import mark1x from "./sealed-mark.webp";
import mark2x from "./sealed-mark@2x.webp";

/**
 * The sealed-bid mark (owner asset, bundled next to this file). While sealed, a dense hatch lies over it; at the
 * reveal the hatch is pulled away left to right, like tape coming off. Falls back to the lock icon if
 * the image is missing. Reduced motion: the hatch just disappears.
 */
export function SealedMark({ revealed, size = 56, className }: { revealed: boolean; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const reduce = useReducedMotion();
  if (broken)
    return revealed ? <LockSimpleOpen size={18} weight="light" className="text-zec" aria-hidden /> : <LockSimple size={18} weight="light" className="text-muted-foreground" aria-hidden />;
  return (
    <span aria-hidden className={cn("relative inline-block overflow-hidden rounded-[22%]", className)} style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- local 256/512 px webp, no optimizer round-trip */}
      <img
        src={mark1x.src}
        srcSet={`${mark1x.src} 256w, ${mark2x.src} 512w`}
        sizes={`${size}px`}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={cn("size-full transition-[filter,opacity] duration-500", !revealed && "opacity-60 saturate-[0.35]")}
      />
      <motion.span
        className="absolute inset-0 bg-background/55"
        style={{ backgroundImage: "repeating-linear-gradient(135deg, rgb(244 183 40 / 0.55) 0 1.5px, transparent 1.5px 5px)" }}
        initial={false}
        animate={{ clipPath: revealed ? "inset(0 0 0 100%)" : "inset(0 0 0 0%)" }}
        transition={reduce ? { duration: 0 } : { duration: 0.9, ease: [0.65, 0, 0.35, 1] }}
      />
    </span>
  );
}
