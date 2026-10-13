import { cn } from "@/lib/utils";

// Final brand (docs/brand/final/GUIDE.md): mark D · Tape, wordmark D2a ("un" + tape over the z + "een").
// The tape geometry and the outlined wordmark come from the brand kit; do not redraw or recolour them.

const TAPE_D = "M2,21 L62,21 L56,23.75 L62,26.5 L60.5,29.25 L62,32 L56,34.75 L62,37.5 L60.5,40.25 L62,43 L2,43Z";

/** Tape mark: a strip of yellow redaction tape with a torn end, at -14°. */
export function TapeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn("size-6", className)}>
      <path transform="rotate(-14 32 32)" d={TAPE_D} fill="var(--zec)" />
    </svg>
  );
}

/** Mark + wordmark. The name lives in aria-label; the wordmark image itself is silent so it is not read twice. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} role="img" aria-label="unzeen">
      <TapeMark className="size-7" />
      {/* 22px tall in the header (brand min 16px, header 20-24px). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/unzeen-wordmark-on-dark.svg" alt="" aria-hidden width={71} height={22} className="h-[22px] w-auto" />
    </span>
  );
}
