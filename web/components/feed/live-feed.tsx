"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { FeedStatus } from "@/lib/api/client";
import type { FeedEvent } from "@/lib/api/types";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/page-shell";
import { FeedItem } from "./feed-item";

interface Props {
  events: FeedEvent[];
  fresh: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
  dense?: boolean;
  emptyText?: string;
}

export function LiveFeed({ events, fresh, loading, error, dense, emptyText = "Nothing yet. The pool is quiet." }: Props) {
  const now = useNow(1000);
  if (loading) return <FeedSkeleton dense={dense} />;
  if (error)
    return (
      <EmptyState title="Feed unavailable" className="m-4">
        {error}
      </EmptyState>
    );
  if (events.length === 0) return <EmptyState title={emptyText} className="m-4" />;

  return (
    <ol aria-live="polite" aria-relevant="additions" className="relative">
      <AnimatePresence initial={false} mode="popLayout">
        {events.map((e) => (
          <FeedItem key={e.id} event={e} now={now} fresh={fresh.has(e.id)} dense={dense} />
        ))}
      </AnimatePresence>
    </ol>
  );
}

function FeedSkeleton({ dense }: { dense?: boolean }) {
  return (
    <ul aria-hidden className="animate-in fade-in duration-300">
      {Array.from({ length: 7 }).map((_, i) => (
        <li key={i} className={cn("flex items-start gap-4 border-b border-border/60", dense ? "p-3" : "px-5 py-4")}>
          <Skeleton className="mt-1 size-8 rounded-full bg-skeleton" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 bg-skeleton" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
            <Skeleton className="h-3 w-32 bg-skeleton" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Connection state; while live, every new event sends one ring out of the dot (`beat` = latest event id). */
export function FeedStatusDot({ status, beat }: { status: FeedStatus; beat?: string }) {
  const label = status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting";
  const reduce = useReducedMotion();
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden className="relative grid size-1.5 place-items-center">
        {status === "live" && beat && !reduce && (
          <motion.span
            key={beat}
            className="absolute size-1.5 rounded-full border border-zec"
            initial={{ scale: 1, opacity: 0.9 }}
            animate={{ scale: 4, opacity: 0 }}
            transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          />
        )}
        <span
          className={cn(
            "size-1.5 rounded-full",
            status === "live" ? "live-dot bg-zec" : status === "connecting" ? "bg-white/40" : "bg-sell",
          )}
        />
      </span>
      {label}
    </span>
  );
}
