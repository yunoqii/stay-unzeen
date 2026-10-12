"use client";

import { CheckCircle, CircleNotch, WarningCircle } from "@phosphor-icons/react";
import type { VerifySnapshotSummary } from "@/lib/api/types";
import { fmtUtc } from "@/lib/verify/display";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

/** Published roots, newest first. Selecting one loads that snapshot (public, cacheable, same for everyone). */
export function RootHistory({
  items,
  selected,
  onSelect,
  hasMore,
  onMore,
}: {
  items: VerifySnapshotSummary[] | null;
  selected: number;
  onSelect: (id: number) => void;
  hasMore: boolean;
  onMore: () => void;
}) {
  if (!items)
    return (
      <div className="space-y-px" aria-busy>
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-12 rounded-none" />
        ))}
      </div>
    );
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No roots published yet.</p>;
  return (
    <div>
      <ol className="max-h-[26rem] divide-y divide-border overflow-y-auto border border-border">
        {items.map((h) => {
          const on = h.id === selected;
          return (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => onSelect(h.id)}
                aria-current={on ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
                  on ? "bg-surface-3" : "hover:bg-surface-1",
                )}
              >
                <span className={cn("w-10 shrink-0 font-mono text-xs tabular", on ? "text-zec" : "text-muted-foreground")}>#{h.id}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-foreground/90">{fmtUtc(h.takenAt)}</span>
                  <span className="block truncate font-mono text-[10px] text-faint-foreground">{h.rootsDigest.slice(0, 16)}…</span>
                </span>
                {!h.anchor ? (
                  <CircleNotch size={12} className="shrink-0 animate-spin text-faint-foreground motion-reduce:animate-none" aria-label="Not anchored yet" />
                ) : h.anchor.matches ? (
                  <CheckCircle size={12} weight="fill" className="shrink-0 text-zec" aria-label="Anchored on Solana" />
                ) : (
                  <WarningCircle size={12} weight="fill" className="shrink-0 text-sell" aria-label="Anchor mismatch" />
                )}
              </button>
            </li>
          );
        })}
      </ol>
      {hasMore && (
        <button type="button" onClick={onMore} className="mt-2 text-xs text-muted-foreground underline decoration-border-strong underline-offset-2 hover:text-foreground">
          Load older roots
        </button>
      )}
    </div>
  );
}
