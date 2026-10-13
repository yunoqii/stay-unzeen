"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { sealedOn } from "@/lib/features";
import { cn } from "@/lib/utils";
import { usePool } from "@/hooks/use-pool";
import { SECTIONS } from "./sections";

// The sealed launch section ships in its own chunk, compiled in only with NEXT_PUBLIC_FAIR_LAUNCH_BUILD=1
// and requested only when the server reports the feature on (same rule as /launch).
const Fair =
  process.env.NEXT_PUBLIC_FAIR_LAUNCH_BUILD === "1"
    ? {
        Section: dynamic(() => import("@/components/fair/docs-section").then((m) => m.FairDocsSection), { ssr: false }),
        Toc: dynamic(() => import("@/components/fair/docs-section").then((m) => m.FairDocsTocItem), { ssr: false }),
      }
    : null;

export function DocsApp() {
  const { pool } = usePool();
  const fair = Fair && sealedOn(pool) ? Fair : null;
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  // Scroll spy: the section nearest the top is the current one.
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-doc-section]"));
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: "-80px 0px -65% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [fair]);

  return (
    <div className="grid gap-10 pb-16 lg:grid-cols-[220px_minmax(0,1fr)]">
      <nav aria-label="Docs sections" className="lg:sticky lg:top-24 lg:self-start">
        <ol className="ledger grid-cols-2 text-sm sm:grid-cols-3 lg:grid-cols-1">
          {SECTIONS.map((s, i) => (
            <li key={s.id}>
              <TocLink id={s.id} n={i + 1} active={active === s.id}>
                {s.title}
              </TocLink>
            </li>
          ))}
          {fair && (
            <li>
              <fair.Toc render={(label, id) => <TocLink id={id} n={SECTIONS.length + 1} active={active === id}>{label}</TocLink>} />
            </li>
          )}
        </ol>
      </nav>

      <article className="docs min-w-0 max-w-[68ch]">
        {SECTIONS.map((s, i) => (
          <section key={s.id} id={s.id} data-doc-section aria-labelledby={`${s.id}-h`} className="scroll-mt-24 border-b border-border/60 pt-2 pb-10 last:border-b-0 [&+section]:pt-10">
            <p className="font-mono text-[11px] tracking-wider text-faint-foreground uppercase">{String(i + 1).padStart(2, "0")}</p>
            <h2 id={`${s.id}-h`} className="mt-1 text-2xl font-medium tracking-tight">
              {s.title}
            </h2>
            <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-pretty text-muted-foreground">{s.body}</div>
          </section>
        ))}
        {fair && <fair.Section n={SECTIONS.length + 1} />}
      </article>
    </div>
  );
}

function TocLink({ id, n, active, children }: { id: string; n: number; active: boolean; children: React.ReactNode }) {
  return (
    <a
      href={`#${id}`}
      aria-current={active ? "location" : undefined}
      className={cn(
        "flex items-baseline gap-2 px-3 py-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <span className={cn("tabular font-mono text-[10px]", active ? "text-zec" : "text-faint-foreground")}>{String(n).padStart(2, "0")}</span>
      {children}
    </a>
  );
}
