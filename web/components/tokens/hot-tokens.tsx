"use client";

import Link from "next/link";
import { useMemo } from "react";
import { motion } from "motion/react";
import { Fire } from "@phosphor-icons/react";
import type { FeedEvent, Token } from "@/lib/api/types";
import { formatCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/page-shell";
import { captureShared, sharedProps } from "@/components/motion/shared-element";
import { Tilt } from "@/components/motion/tilt";
import { TokenGlyph } from "./token-glyph";
import { VenueTag } from "./venue-tag";

const WINDOW_MS = 10 * 60_000;

interface Props {
  tokens: Token[] | null;
  events: FeedEvent[];
  now: number | null;
  limit?: number;
}

/** Ranked by unzeen activity in the last 10 minutes, then by market cap. */
export function HotTokens({ tokens, events, now, limit = 6 }: Props) {
  const ranked = useMemo(() => {
    if (!tokens) return null;
    const since = (now ?? 0) - WINDOW_MS;
    const counts = new Map<string, number>();
    for (const e of events) {
      if (now !== null && e.ts < since) continue;
      counts.set(e.mint, (counts.get(e.mint) ?? 0) + 1);
    }
    return tokens
      .map((t) => ({ token: t, trades: counts.get(t.mint) ?? 0 }))
      .sort((a, b) => b.trades - a.trades || Number(b.token.marketCapSol) - Number(a.token.marketCapSol))
      .slice(0, limit);
  }, [tokens, events, now, limit]);

  if (!ranked)
    return (
      <ul aria-hidden className="space-y-1 p-2">
        {Array.from({ length: limit }).map((_, i) => (
          <li key={i} className="flex items-center gap-3 p-2">
            <Skeleton className="size-9 bg-skeleton" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-20 bg-skeleton" />
              <Skeleton className="h-3 w-28 bg-skeleton" />
            </div>
          </li>
        ))}
      </ul>
    );

  if (ranked.length === 0) return <EmptyState title="No tokens yet" className="m-3" />;

  return (
    <ol className="p-2">
      {ranked.map(({ token, trades }, i) => (
        <motion.li key={token.mint} layout="position" transition={{ type: "spring", bounce: 0, duration: 0.4 }}>
          <Tilt>
          <Link
            href={`/token/${token.mint}`}
            onClick={(e) => captureShared(e.currentTarget)}
            className="group flex items-center gap-3 rounded-xl border border-transparent p-2.5 transition-colors duration-200 hover:border-border hover:bg-surface-1 focus-visible:border-ring focus-visible:outline-none"
          >
            <span className="tabular w-4 shrink-0 text-right font-mono text-[11px] text-faint-foreground">{i + 1}</span>
            <span {...sharedProps(`glyph-${token.mint}`)} className="shrink-0">
              <TokenGlyph symbol={token.symbol} image={token.image} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-2">
                <span {...sharedProps(`ticker-${token.mint}`)} className="font-medium">
                  ${token.symbol}
                </span>
                <span className="truncate text-xs text-faint-foreground">{token.name}</span>
              </p>
              <p className="mt-0.5 flex items-center gap-2 text-xs">
                <VenueTag venue={token.venue} />
                {token.status === "graduated" && <span className="text-faint-foreground">· graduated</span>}
              </p>
            </div>
            <div className="text-right">
              <p className="tabular text-sm">
                {formatCompact(Number(token.marketCapSol))} <span className="text-faint-foreground">SOL</span>
              </p>
              <p
                className={cn(
                  "tabular mt-0.5 inline-flex items-center gap-1 text-xs",
                  trades > 0 ? "text-muted-foreground" : "text-faint-foreground",
                )}
              >
                {trades > 2 && <Fire size={11} weight="duotone" className="text-zec" />}
                {trades} {trades === 1 ? "trade" : "trades"}
              </p>
            </div>
          </Link>
          </Tilt>
        </motion.li>
      ))}
    </ol>
  );
}
