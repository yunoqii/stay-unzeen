import type { LaunchPlatform, Venue } from "@/lib/api/types";
import { venueLabel } from "@/lib/quotes";
import { cn } from "@/lib/utils";

/** Venue is a label only: no third-party logos fetched. LaunchLab tokens name their platform ("bonk.fun · LaunchLab"). */
export function VenueTag({ venue, platform, className }: { venue: Venue; platform?: LaunchPlatform; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-muted-foreground", className)}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          venue === "pumpfun"
            ? "bg-white/50"
            : venue === "meteora-dbc"
              ? "bg-white/25 ring-1 ring-white/40"
              : venue === "raydium-launchlab"
                ? "rounded-[2px] bg-white/35"
                : "bg-white/15",
        )}
      />
      {venueLabel(venue, platform)}
    </span>
  );
}
