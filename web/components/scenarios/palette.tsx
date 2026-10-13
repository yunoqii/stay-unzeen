"use client";

import type { ScenarioBlockType } from "@/lib/api/types";
import { BLOCKS, CATEGORIES } from "@/lib/scenarios/catalog";
import { cn } from "@/lib/utils";
import { BLOCK_ICON, CATEGORY_ICON } from "./block-icon";

export const DND_NEW = "application/x-unzeen-block";
export const DND_MOVE = "application/x-unzeen-step";

/**
 * Blocks by category. Drag one onto the chain, or press it (click / Enter / Space) to add it after the
 * selected step. Blocks the pool hasn't switched on (PoolInfo.scenarios.blocks) show as "Soon".
 */
export function Palette({ enabled, onAdd, onDragStart, onDragEnd, full }: { enabled: ReadonlySet<ScenarioBlockType>; onAdd: (t: ScenarioBlockType) => void; onDragStart: (t: ScenarioBlockType) => void; onDragEnd: () => void; full: boolean }) {
  return (
    <nav aria-label="Blocks" className="space-y-5 px-4 py-5">
      {CATEGORIES.map((c) => {
        // Blocks the pool hasn't switched on yet stay visible, disabled, marked "Soon".
        const blocks = c.blocks;
        const CIcon = CATEGORY_ICON[c.id];
        return (
          <section key={c.id} aria-labelledby={`cat-${c.id}`}>
            <h3 id={`cat-${c.id}`} className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-faint-foreground uppercase" title={c.hint}>
              <CIcon size={11} weight="light" aria-hidden />
              {c.label}
            </h3>
            <ul className="space-y-px">
              {blocks.map((t) => {
                const Icon = BLOCK_ICON[t];
                const on = enabled.has(t);
                return (
                  <li key={t}>
                    <button
                      type="button"
                      draggable={!full && on}
                      disabled={full || !on}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DND_NEW, t);
                        e.dataTransfer.effectAllowed = "copy";
                        onDragStart(t);
                      }}
                      onDragEnd={onDragEnd}
                      onClick={() => onAdd(t)}
                      title={on ? BLOCKS[t].hint : "Coming soon on this pool"}
                      aria-label={on ? `Add ${BLOCKS[t].label}: ${BLOCKS[t].hint}` : `${BLOCKS[t].label}: coming soon`}
                      className={cn(
                        "group flex w-full cursor-grab items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors duration-150 hover:bg-surface-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40",
                      )}
                    >
                      <Icon size={15} weight="light" className="shrink-0 text-faint-foreground transition-colors group-hover:text-zec" aria-hidden />
                      <span className="truncate">{BLOCKS[t].label}</span>
                      {on ? (
                        <span aria-hidden className="ml-auto font-mono text-[10px] text-faint-foreground opacity-40 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                          +
                        </span>
                      ) : (
                        <span className="ml-auto rounded border border-border px-1 font-mono text-[9px] tracking-wide text-faint-foreground uppercase">Soon</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
