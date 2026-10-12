import { cn } from "@/lib/utils";

/** Eclipse mark: a dark disc covering a thin Zcash-yellow ring. */
export function EclipseMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-6", className)}>
      <circle cx="16" cy="16" r="12.5" fill="none" stroke="var(--zec)" strokeWidth="1.5" opacity="0.9" />
      <circle cx="18.5" cy="14.5" r="12" fill="var(--background)" />
      <circle cx="18.5" cy="14.5" r="12" fill="none" stroke="rgb(255 255 255 / 0.08)" strokeWidth="1" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <EclipseMark />
      <span className="text-[15px] font-medium tracking-tight">unzeen</span>
    </span>
  );
}
