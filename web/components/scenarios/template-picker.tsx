"use client";

import { motion } from "motion/react";
import { formatSecs } from "@/lib/scenarios/catalog";
import type { ScenarioBlockType } from "@/lib/api/types";
import { TEMPLATES, type TemplateId } from "@/lib/scenarios/templates";
import { cn } from "@/lib/utils";
import { Chip } from "@/components/ui/chip";

/**
 * The four shared templates. Same constants for everyone: picking one makes your timing look like everyone
 * else's who picked it. The server is never told a plan came from a template.
 */
export function TemplatePicker({ active, onPick, enabled, compact }: { active?: string; onPick: (id: TemplateId) => void; enabled: ReadonlySet<ScenarioBlockType>; compact?: boolean }) {
  // Once a chain exists the cards fold into one row, so the builder starts higher on the screen.
  if (compact)
    return (
      <section aria-label="Templates" className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted-foreground">Start over from a template</span>
        {TEMPLATES.map((t) => {
          const ready = t.build({}).blocks.every((b) => enabled.has(b.block.type));
          return (
            <Chip key={t.id} active={active === t.id} disabled={!ready} onClick={() => onPick(t.id)} title={ready ? t.line : "Uses blocks this pool hasn't switched on yet"}>
              {t.name}
            </Chip>
          );
        })}
      </section>
    );
  return (
    <section aria-labelledby="tpl-title">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="tpl-title" className="text-sm font-medium">
          Templates
        </h2>
        <p className="text-xs text-faint-foreground">Identical for everyone — your timing blends in with theirs.</p>
      </div>
      <ul className="ledger grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        {TEMPLATES.map((t) => {
          const on = active === t.id;
          const ready = t.build({}).blocks.every((b) => enabled.has(b.block.type));
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onPick(t.id)}
                aria-pressed={on}
                disabled={!ready}
                title={ready ? undefined : "Uses blocks this pool hasn't switched on yet"}
                className={cn(
                  "group relative flex h-full w-full flex-col gap-3 p-4 text-left transition-colors duration-150 hover:bg-surface-1 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
                  on && "bg-surface-1",
                )}
              >
                {on && <motion.span layoutId="tpl-mark" aria-hidden className="absolute inset-x-0 top-0 h-px bg-zec" transition={{ type: "spring", bounce: 0, duration: 0.3 }} />}
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{t.name}</span>
                  <span className="font-mono text-[10px] text-faint-foreground">{ready ? formatSecs(t.ttlSecs) : "SOON"}</span>
                </span>
                <span className="text-xs text-pretty text-muted-foreground">{t.line}</span>
                {/* the chain in miniature */}
                <span aria-label={`Blocks: ${t.outline.join(", ")}`} className="mt-auto flex flex-wrap items-center gap-x-1 gap-y-1 font-mono text-[10px] text-faint-foreground">
                  {t.outline.map((o, i) => (
                    <span key={i} className="flex items-center gap-1">
                      {i > 0 && <span aria-hidden className="h-px w-2 bg-border-strong" />}
                      <span className={cn("rounded border border-border px-1 py-px transition-colors", "group-hover:border-border-strong", on && "border-zec/30 text-muted-foreground")}>{o}</span>
                    </span>
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
