"use client";

import { ShadeLoader } from "@/components/motion/shade-loader";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";

/**
 * 202 pending (card: seconds; full safety scan: next main tick): the mint waits for the backend's next fixed tick (batched with decoys, so nobody can
 * tell this browser asked). Shows when the next check happens.
 */
export function Analyzing({ retryAt, className, compact }: { retryAt: number; className?: string; compact?: boolean }) {
  const now = useNow(1000);
  const left = now === null ? null : Math.max(0, Math.ceil((retryAt - now) / 1000));
  return (
    <div role="status" aria-live="polite" className={cn("flex items-start gap-3", className)}>
      <ShadeLoader className={compact ? "mt-0.5 size-6" : "size-9"} />
      <div className="min-w-0">
        <p className={cn("font-medium", compact ? "text-sm" : "text-base")}>{compact ? "Safety scan in progress…" : "Loading token… (a few seconds)"}</p>
        <p className="mt-0.5 text-xs text-pretty text-faint-foreground">
          {compact
            ? "The full scan runs in shared batches on a fixed schedule, so no one can tell you looked."
            : "New tokens are fetched in shared batches on a fixed schedule, so no one can tell you looked."}
          {left !== null && left > 0 && <span className="tabular"> Next check in {left}s.</span>}
        </p>
      </div>
    </div>
  );
}
