"use client";

import { AnimatePresence } from "motion/react";
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
          <Skeleton className="mt-1 size-8 rounded-full bg-white/[0.04]" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 bg-white/[0.04]" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
            <Skeleton className="h-3 w-32 bg-white/[0.03]" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function FeedStatusDot({ status }: { status: FeedStatus }) {
  const label = status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting";
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          status === "live" ? "live-dot bg-zec" : status === "connecting" ? "bg-white/40" : "bg-sell",
        )}
      />
      {label}
    </span>
  );
}
