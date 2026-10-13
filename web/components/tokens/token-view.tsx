"use client";

import Link from "next/link";
import { use, useMemo } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { CopyButton } from "@/components/ui/copy-button";
import { api } from "@/lib/api/client";
import { fillsOf } from "@/lib/history/reduce";
import { useHistory } from "@/lib/history/store";
import { isSolanaAddress } from "@/lib/trade";
import type { FeedEvent, TokenWithTrades } from "@/lib/api/types";
import { formatCompact, formatPrice, shortAddr, timeAgo } from "@/lib/format";
import { useLiveFeed } from "@/hooks/use-live-feed";
import { useNow } from "@/hooks/use-now";
import { usePending } from "@/hooks/use-pending";
import { usePortfolio } from "@/hooks/use-portfolio";
import { ORDER_LABEL } from "@/lib/orders";
import { PeekProvider, usePeek } from "@/components/portfolio/peek";
import { PositionCard } from "@/components/trade/position-card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/page-shell";
import { SharedTarget } from "@/components/motion/shared-element";
import { TradePanel } from "@/components/trade/trade-panel";
import { Analyzing } from "./analyzing";
import { PriceChart } from "./price-chart";
import { SafetyPanel, useSafety } from "./safety-panel";
import { ProgressRing } from "@/components/motion/progress-ring";
import { TokenTrades } from "./token-trades";
import { TokenGlyph } from "./token-glyph";
import { VenueTag } from "./venue-tag";

export function TokenView({ params }: { params: Promise<{ mint: string }> }) {
  const { mint: raw } = use(params);
  let mint = raw;
  try {
    mint = decodeURIComponent(raw);
  } catch {
    /* keep raw: fails validation below */
  }
  if (!isSolanaAddress(mint))
    return (
      <Frame>
        <EmptyState title="Not a Solana address">
          <span className="font-mono break-all">{shortAddr(mint, 8, 8)}</span> is not base58 of 32 bytes. Check the contract address and try again.
        </EmptyState>
      </Frame>
    );
  return <TokenByMint key={mint} mint={mint} />;
}

function TokenByMint({ mint }: { mint: string }) {
  // A cold mint (first CA search) answers 202 pending until the backend's next tick: retry when told.
  const s = usePending(`token:${mint}`, () => api.getToken(mint));

  if (s.state === "error")
    return (
      <Frame>
        <EmptyState title="Could not load this token">{s.error}</EmptyState>
      </Frame>
    );
  if (s.state === "loading") return <TokenViewSkeleton />;
  if (s.state === "pending")
    return (
      <Frame>
        <div className="rounded-2xl border border-border p-5 sm:p-6">
          <p className="font-mono text-xs break-all text-faint-foreground">{mint}</p>
          <Analyzing retryAt={s.retryAt} className="mt-4" />
        </div>
      </Frame>
    );
  if (s.state === "missing")
    return (
      <Frame>
        <EmptyState title="Unknown token">
          No token at <span className="font-mono">{shortAddr(mint, 6, 6)}</span> on this network.
        </EmptyState>
      </Frame>
    );

  return (
    <PeekProvider>
      <TokenLoaded key={s.data.mint} token={s.data} />
    </PeekProvider>
  );
}

function TokenLoaded({ token }: { token: TokenWithTrades }) {
  const feed = useLiveFeed({ mint: token.mint, initial: token.trades, limit: 100 });
  const now = useNow(1000);
  const priceSol = useLivePrice(token, feed.events);
  const history = useHistory();
  const { shown } = usePeek();
  const safety = useSafety(token.mint);
  const curve =
    safety.state !== "ready" ? null : safety.data.market.status === "graduated" ? 100 : safety.data.market.curveProgressPct ? Number(safety.data.market.curveProgressPct) : null;
  const ownFills = useMemo(() => fillsOf(history.entries, token.mint), [history.entries, token.mint]);
  const { portfolio } = usePortfolio();
  // Your open orders as dashed trigger lines: drawn from the owner-only portfolio, behind Peek, never sent anywhere.
  const triggers = useMemo(
    () =>
      (portfolio?.orders ?? [])
        .filter((o) => o.mint === token.mint && o.status === "open")
        .map((o) => ({ id: o.id, price: Number(o.triggerPriceSol), label: ORDER_LABEL[o.kind] })),
    [portfolio?.orders, token.mint],
  );

  return (
    <Frame>
      <header className="flex flex-wrap items-start gap-4">
        <SharedTarget id={`glyph-${token.mint}`} className="shrink-0">
          {curve === null ? (
            <TokenGlyph symbol={token.symbol} image={token.image} className="size-14 rounded-xl text-sm" />
          ) : (
            <ProgressRing value={curve} size={68} stroke={2} label={curve >= 100 ? "Graduated from the bonding curve" : `Bonding curve ${curve}% filled`}>
              <TokenGlyph symbol={token.symbol} image={token.image} className="size-14 rounded-full text-sm" />
            </ProgressRing>
          )}
        </SharedTarget>
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <SharedTarget id={`ticker-${token.mint}`} className="inline-block">
              <span className="text-3xl font-medium tracking-tight">${token.symbol}</span>
            </SharedTarget>
            <span className="text-lg text-muted-foreground">{token.name}</span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <VenueTag venue={token.venue} />
            <span className="text-faint-foreground">
              {token.status === "graduated" ? "graduated" : curve === null ? "on bonding curve" : <span className="tabular">curve {curve}%</span>}
            </span>
            <CopyButton value={token.mint} label="Copy mint address" className="font-mono">
              {shortAddr(token.mint, 5, 5)}
            </CopyButton>
          </div>
        </div>
      </header>

      <dl className="ledger mt-8 grid-cols-3">
        <Stat label="Price" value={formatPrice(priceSol)} unit="SOL" />
        <Stat label="Market cap" value={formatCompact(Number(token.marketCapSol))} unit="SOL" />
        <Stat label="Created" value={now === null ? "" : timeAgo(token.createdAt, now)} unit="ago" />
      </dl>

      <div aria-hidden className="hatch mt-6 h-3" />
      <div className="ledger grid lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_1fr]">
        <div className="min-w-0">
          <PriceChart mint={token.mint} trades={feed.events} markers={ownFills} triggers={triggers} showMarkers={shown} />
        </div>

        <aside className="flex flex-col gap-px bg-border lg:col-start-2 lg:row-span-2 lg:row-start-1 [&>*]:bg-background">
          <TradePanel token={token} priceSol={priceSol} />
          <PositionCard token={token} priceSol={priceSol} />
          <SafetyPanel state={safety} />
          <div className="hatch hidden min-h-6 flex-1 opacity-50 lg:block" aria-hidden />
        </aside>

        <TokenTrades mint={token.mint} feed={feed} />
      </div>
      <div aria-hidden className="hatch h-3" />
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

/** Price of the latest trade we saw on the socket, else the token's own priceSol. Plain decimal string. */
function useLivePrice(token: TokenWithTrades, events: FeedEvent[]): string {
  const e = events.find((x) => x.kind !== "create");
  if (!e || token.trades.some((t) => t.id === e.id)) return token.priceSol;
  const tokens = Number(e.tokenAmount) / 10 ** e.decimals;
  const sol = Number(e.solAmount) / 1e9;
  if (!(tokens > 0) || !(sol > 0)) return token.priceSol;
  const p = sol / tokens;
  return p.toFixed(Math.min(20, Math.max(0, 5 - Math.floor(Math.log10(p)))));
}
