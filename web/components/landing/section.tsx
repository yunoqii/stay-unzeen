import { cn } from "@/lib/utils";

/** One landing section: shared width, gutters and vertical rhythm. */
export function Section({ id, className, children, labelledBy }: { id?: string; className?: string; children: React.ReactNode; labelledBy?: string }) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cn("relative scroll-mt-20 border-t border-border/60", className)}>
      <div className="mx-auto w-full max-w-6xl px-(--landing-gutter) py-20 sm:py-28">{children}</div>
    </section>
  );
}

/**
 * Two-tone heading, the voice of the hero carried down the page: the claim in paper, the turn in fog.
 * No eyebrow above it: the heading carries its own weight.
 */
export function SectionHeading({ id, lead, turn, children, className }: { id: string; lead: string; turn: string; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("max-w-3xl", className)}>
      <h2 id={id} className="text-[2rem] leading-[1.05] font-medium tracking-[-0.035em] text-balance sm:text-[2.75rem] lg:text-[3.25rem]">
        {lead} <span className="text-muted-foreground">{turn}</span>
      </h2>
      {children && <div className="mt-5 max-w-[62ch] text-[17px] leading-relaxed text-pretty text-muted-foreground">{children}</div>}
    </div>
  );
}
