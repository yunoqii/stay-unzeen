"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { ArrowLeft, ChartLineUp, Copy, ShieldCheck } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, errorText } from "@/lib/api/client";
import { useNetwork } from "@/lib/network";
import type { TokenWithTrades } from "@/lib/api/types";
import { formatCompact, formatPrice, shortAddr, timeAgo } from "@/lib/format";
import { useLiveFeed } from "@/hooks/use-live-feed";
import { useNow } from "@/hooks/use-now";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/page-shell";
import { FeedStatusDot, LiveFeed } from "@/components/feed/live-feed";
import { TokenGlyph } from "./token-glyph";
import { VenueTag } from "./venue-tag";

export function TokenView({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = use(params);
  const [token, setToken] = useState<TokenWithTrades | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const network = useNetwork(); // refetch / resubscribe on Devnet <-> Mainnet
  useEffect(() => {
    let alive = true;
    api
      .getToken(mint)
      .then((t) => alive && setToken(t))
      .catch((e: unknown) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [mint, network]);

  if (error)
    return (
      <Frame>
        <EmptyState title="Could not load this token">{error}</EmptyState>
      </Frame>
    );
  if (token === undefined) return <TokenViewSkeleton />;
  if (token === null)
    return (
      <Frame>
        <EmptyState title="Unknown token">
          No unzeen activity for <span className="font-mono">{shortAddr(mint, 6, 6)}</span>.
        </EmptyState>
      </Frame>
    );

  return <TokenLoaded key={token.mint} token={token} />;
}

function TokenLoaded({ token }: { token: TokenWithTrades }) {
  const feed = useLiveFeed({ mint: token.mint, initial: token.trades, limit: 100 });
  const now = useNow(1000);

  const copyMint = async () => {
    try {
      await navigator.clipboard.writeText(token.mint);
      toast("Mint address copied");
    } catch {
      toast.error("Clipboard unavailable");
    }
  };

  return (
    <Frame>
      <header className="flex flex-wrap items-start gap-4">
        <TokenGlyph symbol={token.symbol} image={token.image} className="size-14 rounded-xl text-sm" />
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-3xl font-medium tracking-tight">${token.symbol}</span>
            <span className="text-lg text-muted-foreground">{token.name}</span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <VenueTag venue={token.venue} />
            <span className="text-faint-foreground">{token.status === "graduated" ? "graduated" : "on bonding curve"}</span>
            <button
              onClick={copyMint}
              className="inline-flex items-center gap-1 font-mono text-faint-foreground transition-colors hover:text-muted-foreground"
              aria-label="Copy mint address"
            >
              {shortAddr(token.mint, 5, 5)}
              <Copy size={12} weight="light" />
            </button>
          </div>
        </div>
      </header>

      <dl className="mt-8 grid grid-cols-3 gap-px overflow-hidden rounded-2xl border border-border bg-border">
        <Stat label="Price" value={formatPrice(token.priceSol)} unit="SOL" />
        <Stat label="Market cap" value={formatCompact(Number(token.marketCapSol))} unit="SOL" />
        <Stat label="Created" value={now === null ? "" : timeAgo(token.createdAt, now)} unit="ago" />
      </dl>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <EmptyState icon={<ChartLineUp size={28} weight="thin" />} title="Chart" className="h-64 border-solid">
            Candles arrive with the token page build (days 6–8).
          </EmptyState>

          <section aria-labelledby="trades-title" className="rounded-2xl border border-border">
            <header className="flex items-center justify-between border-b border-border/60 px-4 py-3">
              <h2 id="trades-title" className="text-sm font-medium">
                unzeen trades
              </h2>
              <FeedStatusDot status={feed.status} />
            </header>
            <LiveFeed
              events={feed.events}
              fresh={feed.fresh}
              loading={feed.loading}
              error={feed.error}
              dense
              emptyText="No unzeen trades on this token yet."
            />
          </section>
        </div>

        <aside className="lg:sticky lg:top-[calc(var(--header-h)+1.5rem)] lg:self-start">
          <EmptyState icon={<ShieldCheck size={28} weight="thin" />} title="Buy or sell privately" className="border-solid">
            Pay with shielded ZEC from ZODL by QR. Coming next.
          </EmptyState>
        </aside>
      </div>
    </Frame>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="bg-background px-4 py-4 sm:px-5">
      <dt className="text-xs text-faint-foreground">{label}</dt>
      <dd className="tabular mt-1 truncate text-lg sm:text-xl">
        {value} <span className="text-sm text-faint-foreground">{unit}</span>
      </dd>
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6 sm:pt-8">
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={14} weight="light" />
        Feed
      </Link>
      {children}
    </div>
  );
}

export function TokenViewSkeleton() {
  return (
    <div aria-busy className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6 sm:pt-8">
      <Skeleton className="mb-6 h-5 w-16 bg-skeleton" />
      <div className="flex items-center gap-4">
        <Skeleton className="size-14 rounded-xl bg-skeleton" />
        <div className="space-y-2">
          <Skeleton className="h-8 w-40 bg-skeleton" />
          <Skeleton className="h-4 w-56 bg-skeleton" />
        </div>
      </div>
      <Skeleton className="mt-8 h-20 rounded-2xl bg-skeleton" />
      <Skeleton className="mt-6 h-64 rounded-2xl bg-skeleton" />
    </div>
  );
}
