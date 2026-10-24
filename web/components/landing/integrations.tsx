import { cn } from "@/lib/utils";
import { Section, SectionHeading } from "./section";
import { INTEGRATIONS } from "./content";

export function Integrations() {
  return (
    <Section id="integrations" labelledBy="integrations-title">
      <SectionHeading id="integrations-title" lead="Launch anywhere." turn="One balance for every launchpad.">
        <p>Unzeen does not run its own curve. It trades on the launchpads people already use, through adapters on the pool’s side. Your balance stays in ZEC throughout.</p>
      </SectionHeading>

      <ul className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {INTEGRATIONS.map((p) => (
          <li key={p.name} className={cn("flex flex-col bg-background p-6", p.name === "Zcash" && "bg-[linear-gradient(160deg,rgb(244_183_40/0.07),transparent_60%),var(--background)] lg:row-span-2")}>
            <div className="flex items-start justify-between gap-3">
              <p className={cn("font-medium tracking-[-0.03em]", p.name === "Zcash" ? "text-[1.75rem] text-zec" : "text-xl")}>{p.name}</p>
              <span className={cn("mt-1.5 inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap", p.status === "live" ? "text-foreground/80" : "text-faint-foreground")}>
                <span aria-hidden className={cn("size-1.5 rounded-full", p.status === "live" ? "bg-zec" : "border border-[var(--uz-fog-2)]")} />
                {p.status === "live" ? "Live" : "In code"}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{p.role}</p>
            <p className="mt-auto pt-6 text-[13px] leading-relaxed text-pretty text-faint-foreground">{p.note}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
