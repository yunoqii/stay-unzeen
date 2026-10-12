// Four orbiting arcs, recoloured to unzeen. Adapted from Uiverse.io "soft-bear-48" by ZacharyCrespin
// (MIT License, Copyright (c) 2023 Uiverse.io); the full notice sits next to its keyframes in
// app/globals.css. Pure CSS: it keeps spinning while JS is busy and stops with reduced motion.

import { cn } from "@/lib/utils";

export function ShadeLoader({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 240 240" className={cn("size-8 shrink-0", className)}>
      <circle className="uz-loader-ring" cx="120" cy="120" r="105" fill="none" strokeWidth="16" strokeDasharray="0 660" strokeDashoffset="-330" strokeLinecap="round" />
      <circle className="uz-loader-ring uz-loader-ring-b" cx="120" cy="120" r="35" fill="none" strokeWidth="16" strokeDasharray="0 220" strokeDashoffset="-110" strokeLinecap="round" />
      <circle className="uz-loader-ring uz-loader-ring-c" cx="85" cy="120" r="70" fill="none" strokeWidth="16" strokeDasharray="0 440" strokeLinecap="round" />
      <circle className="uz-loader-ring uz-loader-ring-d" cx="155" cy="120" r="70" fill="none" strokeWidth="16" strokeDasharray="0 440" strokeLinecap="round" />
    </svg>
  );
}
