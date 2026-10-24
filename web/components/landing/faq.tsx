import { Plus } from "@phosphor-icons/react/ssr";
import { Section, SectionHeading } from "./section";
import { FAQ } from "./content";

export function Faq() {
  return (
    <Section id="faq" labelledBy="faq-title">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
        <SectionHeading id="faq-title" lead="Questions," turn="answered plainly." className="lg:sticky lg:top-28 lg:self-start" />
        <div className="faq border-t border-border">
          {FAQ.map((f) => (
            <details key={f.q} className="group border-b border-border">
              <summary className="flex cursor-pointer items-center justify-between gap-6 py-5 text-left text-[17px] font-medium tracking-tight transition-colors duration-150 hover:text-zec focus-visible:text-zec focus-visible:outline-none">
                {f.q}
                <Plus size={16} weight="regular" aria-hidden className="faq-caret shrink-0 text-muted-foreground transition-transform duration-300 ease-shadow" />
              </summary>
              <p className="faq-body max-w-[64ch] pb-6 text-[15px] leading-relaxed text-pretty text-muted-foreground">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}
