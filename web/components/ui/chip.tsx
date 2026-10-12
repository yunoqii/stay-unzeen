import { cn } from "@/lib/utils";

/** Small pill choice (presets, windows, tiers). */
export function Chip({ active, className, ...props }: React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      {...props}
      className={cn(
        "tabular inline-flex h-9 items-center rounded-full border px-3 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40 sm:h-8",
        active ? "border-zec/50 bg-zec/10 text-foreground" : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
        className,
      )}
    />
  );
}
