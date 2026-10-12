"use client";

import { useEffect, useId, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api, errorText } from "@/lib/api/client";
import type { TokenTrade, TradeFilter } from "@/lib/api/types";
import { formatCompact, formatSol, lamportsToSol, shortAddr, timeAgo, unitsToNumber } from "@/lib/format";
import { useNetwork } from "@/lib/network";
import { cn } from "@/lib/utils";
import type { LiveFeed as LiveFeedState } from "@/hooks/use-live-feed";
import { useNow } from "@/hooks/use-now";
import { usePool } from "@/hooks/use-pool";
import { EmptyState } from "@/components/layout/page-shell";
import { FeedStatusDot, LiveFeed } from "@/components/feed/live-feed";
import { Skeleton } from "@/components/ui/skeleton";

const FILTERS: { id: TradeFilter; label: string; needsFull: boolean }[] = [
  { id: "all", label: "All", needsFull: false },
  { id: "unzeen", label: "unzeen", needsFull: false },
  { id: "whales", label: "Whales", needsFull: true },
  { id: "dev", label: "Dev", needsFull: true },
];

const SOON = "Needs the full on-chain trade feed. Coming soon.";

/**
 * Trades of one token with the All / unzeen / Whales / Dev filters. Until the full feed is switched on
 * (PoolInfo.features.fullTrades), the backend only knows unzeen trades: All = unzeen, Whales and Dev are disabled.
 */
export function TokenTrades({ mint, feed }: { mint: string; feed: LiveFeedState }) {
  const [filter, setFilter] = useState<TradeFilter>("all");
  const id = useId();
  const { pool } = usePool();
  const FULL_TRADES = pool?.features?.fullTrades === true;
  const usesFull = FULL_TRADES && filter !== "unzeen";

  return (
    <section aria-labelledby={`${id}-t`} className="min-w-0">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
        <h2 id={`${id}-t`} className="text-sm font-medium">
          Trades
        </h2>
        <div className="flex items-center gap-3">
          <div role="tablist" aria-label="Filter trades" className="flex gap-0.5 rounded-full border border-border p-0.5">
            {FILTERS.map((f) => {
              const disabled = f.needsFull && !FULL_TRADES;
              const on = filter === f.id;
              return (
                <button
                  key={f.id}
                  role="tab"
                  type="button"
                  aria-selected={on}
                  aria-disabled={disabled || undefined}
                  title={disabled ? SOON : undefined}
                  onClick={() => !disabled && setFilter(f.id)}
                  className={cn(
                    "relative rounded-full px-2.5 py-1 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                    disabled && "cursor-not-allowed text-faint-foreground/60 hover:text-faint-foreground/60",
                  )}
                >
                  {on && <motion.span layoutId={`${id}-f`} className="absolute inset-0 rounded-full bg-surface-3" transition={{ type: "spring", bounce: 0, duration: 0.25 }} />}
                  <span className="relative">{f.label}</span>
                </button>
              );
            })}
          </div>
          <FeedStatusDot status={feed.status} beat={feed.events[0]?.id} />
        </div>
      </header>

      {!FULL_TRADES && (
        <p className="border-b border-border/60 px-4 py-2 text-[11px] text-faint-foreground">
          Showing unzeen trades. Whales and Dev arrive with the full on-chain feed.
        </p>
      )}

      {usesFull ? (
        <FilteredTrades key={filter} mint={mint} filter={filter} />
      ) : (
        <LiveFeed
          events={feed.events}
          fresh={feed.fresh}
          loading={feed.loading}
          error={feed.error}
          dense
          emptyText="No unzeen trades on this token yet."
        />
      )}
    </section>
  );
}

/** GET /api/tokens/:mint/trades?filter= (full feed only), refreshed every 15 s. */
function FilteredTrades({ mint, filter }: { mint: string; filter: TradeFilter }) {
  const [list, setList] = useState<TokenTrade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const network = useNetwork();
  const now = useNow(1000);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getTokenTrades(mint, { filter, limit: 50 })
        .then((l) => {
          if (!alive) return;
          setList(l);
          setError(null);
        })
        .catch((e: unknown) => alive && setError(errorText(e)));
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [mint, filter, network]);

  if (error && !list) return <EmptyState title="Trades unavailable" className="m-4">{error}</EmptyState>;
  if (!list)
    return (
      <ul aria-hidden className="space-y-3 p-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-5 bg-skeleton" style={{ width: `${60 + ((i * 13) % 30)}%` }} />
        ))}
      </ul>
    );
  if (list.length === 0)
    return <EmptyState title={filter === "whales" ? "No whale trades yet." : filter === "dev" ? "The dev has not traded." : "No trades yet."} className="m-4" />;

  return (
    <ol className="divide-y divide-border/60">
      <AnimatePresence initial={false}>
        {list.map((t) => (
          <TradeRow key={t.id} trade={t} now={now} />
        ))}
      </AnimatePresence>
    </ol>
  );
}

function TradeRow({ trade, now }: { trade: TokenTrade; now: number | null }) {
  const unzeen = trade.trader === "unzeen";
  const buy = trade.kind !== "sell";
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25 }}
      className="flex items-center gap-3 px-3 py-2.5 text-sm"
    >
      <span className={cn("w-9 shrink-0 text-xs", buy ? "text-buy" : "text-sell")}>{trade.kind === "create" ? "Launch" : buy ? "Buy" : "Sell"}</span>
      <span className="min-w-0 flex-1 truncate">
        {unzeen ? <span className="text-foreground/90">unzeen</span> : <span className="font-mono text-xs text-muted-foreground">{shortAddr(trade.trader, 4, 4)}</span>}
        {trade.tags.map((tag) => (
          <span key={tag} className="ml-1.5 rounded-full border border-border px-1.5 py-px text-[10px] text-faint-foreground">
            {tag}
          </span>
        ))}
      </span>
      <span className="tabular text-right text-muted-foreground">
        {formatCompact(unitsToNumber(trade.tokenAmount, trade.decimals))}
        <span className="text-faint-foreground"> · </span>
        <span className="text-foreground/90">{formatSol(lamportsToSol(trade.solAmount))} SOL</span>
      </span>
      <span className="tabular w-8 shrink-0 text-right font-mono text-[11px] text-faint-foreground">{now === null ? "" : timeAgo(trade.ts, now)}</span>
    </motion.li>
  );
}
