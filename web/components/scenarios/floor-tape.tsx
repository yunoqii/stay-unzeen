import { cn } from "@/lib/utils";

/**
 * A server-side privacy floor, stuck onto the step like a strip of redaction tape: it changes when or how
 * much the step runs, and nobody can switch it off. Hatched ends = the brand's "part you cannot see".
 * A <span>: it also sits inside the chain's step buttons.
 */
export function FloorTape({ text, className, compact }: { text: string; className?: string; compact?: boolean }) {
  return (
    <span
      className={cn(
        "relative flex items-center gap-2 overflow-hidden rounded-[2px] border border-zec/25 bg-zec/[0.06] pr-4 pl-5 leading-snug text-foreground/90",
        compact ? "py-0.5 text-[10.5px]" : "py-1 text-[11px]",
        className,
      )}
    >
      <span aria-hidden className="hatch-zec absolute inset-y-0 left-0 w-3" />
      <span aria-hidden className="hatch-zec absolute inset-y-0 right-0 w-2 opacity-60" />
      <span className="shrink-0 font-mono text-[9.5px] tracking-wider text-zec uppercase">
        Floor<span className="sr-only"> (privacy rule the pool applies)</span>
      </span>
      <span className="text-pretty">{text}</span>
    </span>
  );
}
