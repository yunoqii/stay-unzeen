import Link from "next/link";
import { cn } from "@/lib/utils";
import { Section, SectionHeading } from "./section";
import { PRIVACY_ROWS, VISIBILITY_LABEL, type Visibility } from "./content";

const PILL: Record<Visibility, string> = {
  hidden: "border-zec/40 text-zec",
  public: "border-border-strong text-foreground/80",
  operator: "border-dashed border-border-strong text-muted-foreground",
};

export function PrivacyTable() {
  return (
    <Section id="privacy" labelledBy="privacy-title">
      <SectionHeading id="privacy-title" lead="What stays hidden," turn="and what does not.">
        <p>
          The price is public because the curve is on chain. The people are not. Hidden means nobody watching the chain can read it. The last rows are what you trust the pool’s operator with. The{" "}
          <Link href="/docs" className="text-foreground underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-zec">
            docs
          </Link>{" "}
          list every known leak.
        </p>
      </SectionHeading>

      <div className="mt-12 overflow-hidden rounded-2xl border border-border">
        <table className="w-full text-left">
          <caption className="sr-only">What is hidden, what is public, and what the operator is trusted with</caption>
          <thead className="max-md:sr-only">
            <tr className="border-b border-border text-xs text-faint-foreground">
              <th scope="col" className="w-[36%] px-5 py-3 font-normal">What</th>
              <th scope="col" className="w-[120px] px-5 py-3 font-normal">Status</th>
              <th scope="col" className="px-5 py-3 font-normal">Why</th>
            </tr>
          </thead>
          <tbody>
            {PRIVACY_ROWS.map((r) => (
              <tr key={r.what} className={cn("border-b border-border/60 last:border-0 max-md:grid max-md:grid-cols-[1fr_auto] max-md:gap-x-4 max-md:px-5 max-md:py-4", r.who === "operator" && "bg-surface-1")}>
                <th scope="row" className="px-5 py-4 align-top text-[15px] font-medium tracking-tight max-md:p-0">
                  {r.what}
                </th>
                <td className="px-5 py-4 align-top max-md:col-start-2 max-md:row-start-1 max-md:p-0">
                  <span className={cn("inline-flex rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap", PILL[r.who])}>
                    {VISIBILITY_LABEL[r.who]}
                  </span>
                </td>
                <td className="px-5 py-4 align-top text-[14px] leading-relaxed text-pretty text-muted-foreground max-md:col-span-2 max-md:p-0 max-md:pt-1.5">{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 max-w-[70ch] text-sm text-pretty text-faint-foreground">
        Privacy grows with the crowd. While few people use the pool, a trade in a quiet token is easier to attribute to one person. We do not fake traffic to hide that.
      </p>
    </Section>
  );
}
