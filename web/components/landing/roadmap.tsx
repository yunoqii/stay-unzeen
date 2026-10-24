import { cn } from "@/lib/utils";
import { Section, SectionHeading } from "./section";
import { ROADMAP } from "./content";

export function Roadmap() {
  return (
    <Section id="roadmap" labelledBy="roadmap-title">
      <SectionHeading id="roadmap-title" lead="Trust less," turn="hide in a bigger crowd.">
        <p>This version is a working custodial pool. Everything next is about taking trust away from the operator and making the crowd you hide in larger.</p>
      </SectionHeading>

      <ol className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-3">
        {ROADMAP.map((r, i) => (
          <li key={r.when} className="relative bg-background p-6 sm:p-8">
            <div className="flex items-center gap-3">
              <span aria-hidden className={cn("size-2 rounded-full", i === 0 ? "bg-zec" : i === 1 ? "border border-zec/70" : "border border-[var(--uz-fog-2)]")} />
              <span className={cn("text-sm font-medium", i === 0 ? "text-zec" : "text-foreground/80")}>{r.when}</span>
            </div>
            <h3 className="mt-5 text-lg font-medium tracking-tight">{r.title}</h3>
            <ul className="mt-4 space-y-2.5">
              {r.items.map((it) => (
                <li key={it} className="flex gap-2.5 text-[15px] leading-snug text-muted-foreground">
                  <span aria-hidden className="mt-[0.6em] h-px w-2.5 shrink-0 bg-[var(--uz-fog-2)]" />
                  {it}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </Section>
  );
}
