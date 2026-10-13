"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Brand v4 tape strip, full detail (docs/brand/final/for-web/tape-strip-full.svg), inline so it can stretch to
 * the amount it covers (preserveAspectRatio none) and keep its clip id unique per instance. Geometry and tones
 * are the brand kit's; do not recolour.
 */
export function TapeStripFull({ className }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="4 8 234 66" preserveAspectRatio="none" aria-hidden focusable="false" className={cn("block size-full overflow-visible", className)}>
      <g>
        <path d="M26.16,10.00 L234.00,10.00 L213.84,19.33 L226.94,28.67 L218.88,38.00 L230.98,47.33 L214.85,56.67 L234.00,66.00 L6.00,66.00 L12.05,58.83 L7.01,51.66 L15.07,44.50 L9.02,37.33 L6.00,30.16Z" fill="#7A560A" transform="translate(2.80 6.16)"/>
        <path d="M26.16,10.00 L234.00,10.00 L213.84,19.33 L226.94,28.67 L218.88,38.00 L230.98,47.33 L214.85,56.67 L234.00,66.00 L6.00,66.00 L12.05,58.83 L7.01,51.66 L15.07,44.50 L9.02,37.33 L6.00,30.16Z" fill="#F4B728"/>
        <clipPath id={id}><path d="M26.16,10.00 L234.00,10.00 L213.84,19.33 L226.94,28.67 L218.88,38.00 L230.98,47.33 L214.85,56.67 L234.00,66.00 L6.00,66.00 L12.05,58.83 L7.01,51.66 L15.07,44.50 L9.02,37.33 L6.00,30.16Z"/>
        </clipPath><g clipPath={`url(#${id})`}><path d="M6.00,10 l2.24,56M10.76,10 l2.24,56M15.52,10 l2.24,56M20.28,10 l2.24,56M25.04,10 l2.24,56M29.80,10 l2.24,56M34.56,10 l2.24,56M39.32,10 l2.24,56M44.08,10 l2.24,56M48.84,10 l2.24,56M53.60,10 l2.24,56M58.36,10 l2.24,56M63.12,10 l2.24,56M67.88,10 l2.24,56M72.64,10 l2.24,56M77.40,10 l2.24,56M82.16,10 l2.24,56M86.92,10 l2.24,56M91.68,10 l2.24,56M96.44,10 l2.24,56M101.20,10 l2.24,56M105.96,10 l2.24,56M110.72,10 l2.24,56M115.48,10 l2.24,56M120.24,10 l2.24,56M125.00,10 l2.24,56M129.76,10 l2.24,56M134.52,10 l2.24,56M139.28,10 l2.24,56M144.04,10 l2.24,56M148.80,10 l2.24,56M153.56,10 l2.24,56M158.32,10 l2.24,56M163.08,10 l2.24,56M167.84,10 l2.24,56M172.60,10 l2.24,56M177.36,10 l2.24,56M182.12,10 l2.24,56M186.88,10 l2.24,56M191.64,10 l2.24,56M196.40,10 l2.24,56M201.16,10 l2.24,56M205.92,10 l2.24,56M210.68,10 l2.24,56M215.44,10 l2.24,56M220.20,10 l2.24,56M224.96,10 l2.24,56M229.72,10 l2.24,56" stroke="#D99E17" strokeWidth="0.67" opacity=".22" fill="none"/>
        <rect x="6" y="10" width="228" height="4.20" fill="#F8CA5C" opacity=".9"/>
        <rect x="6" y="61.80" width="228" height="4.20" fill="#F8CA5C" opacity=".9"/>
        <path d="M92.64,10 L74.16,66" stroke="#D99E17" strokeWidth="1.96" fill="none"/>
        <path d="M95.16,10 L76.96,66" stroke="#F8CA5C" strokeWidth="1.68" fill="none"/>
        <path d="M165.60,10 L174.00,66" stroke="#D99E17" strokeWidth="1.96" fill="none"/>
        <path d="M168.12,10 L176.80,66" stroke="#F8CA5C" strokeWidth="1.68" fill="none"/>
        </g><path d="M26.16,10 L6.00,30.16 L24.55,28.55Z" fill="#B98410"/>
        <path d="M26.16,10 L24.55,28.55" stroke="#F8CA5C" strokeWidth="1.40"/>
      </g>
    </svg>
  );
}
