import type { Venue } from "@/lib/api/types";
import { VENUE_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Venue is a label only: no third-party logos fetched. */
export function VenueTag({ venue, className }: { venue: Venue; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-muted-foreground", className)}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          venue === "pumpfun" ? "bg-white/50" : venue === "meteora-dbc" ? "bg-white/25 ring-1 ring-white/40" : "bg-white/15",
        )}
      />
      {VENUE_LABEL[venue]}
    </span>
  );
}
