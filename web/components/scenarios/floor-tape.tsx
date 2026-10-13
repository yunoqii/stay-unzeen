import { ShieldCheck } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/**
 * A server-side privacy floor, stuck onto the step like a strip of redaction tape: it changes when or how
 * much the step runs, and nobody can switch it off. The hatch is the brand's "part you cannot see".
 */
export function FloorTape({ text, className }: { text: string; className?: string }) {
  return (
    <p className={cn("relative flex items-center gap-2 overflow-hidden rounded-md border border-zec/25 bg-zec/[0.06] py-1 pr-2.5 pl-2 text-[11px] leading-snug text-foreground/90", className)}>
      <span aria-hidden className="hatch-zec absolute inset-y-0 left-0 w-1.5 opacity-90" />
      <ShieldCheck size={12} weight="duotone" className="ml-1 shrink-0 text-zec" aria-hidden />
      <span className="sr-only">Privacy floor: </span>
      <span className="text-pretty">{text}</span>
    </p>
  );
}
