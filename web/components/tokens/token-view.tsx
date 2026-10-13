"use client";

import { ErrorState } from "@/components/ui/states";
import Link from "next/link";
import { use, useMemo, useState } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { CopyButton } from "@/components/ui/copy-button";
import { api } from "@/lib/api/client";
import { fillsOf } from "@/lib/history/reduce";
import { useHistory } from "@/lib/history/store";
import { isSolanaAddress } from "@/lib/trade";
import { cn } from "@/lib/utils";
import type { FeedEvent, TokenWithTrades } from "@/lib/api/types";
import { formatCompact, formatPrice, shortAddr, timeAgo } from "@/lib/format";
import { eventQuote, quoteOfMint, quotePerSol, tokenQuote } from "@/lib/quotes";
import type { Quote } from "@/lib/api/types";
import { QuoteBadge } from "./quote-badge";
import { useDisplay } from "@/lib/display-store";
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
import { TokenActivity } from "./token-activity";
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
        <ErrorState error={s.error} title="Could not load this token" onRetry={s.retry} />
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
        <EmptyState art title="Unknown token">
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
  const { sol: priceSol, quote: priceQuote } = useLivePrice(token, feed.events);
  const quote = tokenQuote(token);
  // v0.13: non-SOL pairs read in their own quote by default; SOL is the comparable view (switchable).
  const [denomPick, setDenom] = useState<"quote" | "SOL">("quote");
  const scale = quotePerSol(token);
  // SOL figures read in the display unit (ZEC by default, converted at the public rate with "≈").
  const display = useDisplay();
  // A ZEC pair with the ZEC display has nothing to switch to: its own quote is already ZEC.
  const sameUnit = quote === display.unit;
  const quoteView = quote !== "SOL" && (denomPick === "quote" || sameUnit);
  // v0.17: the chart of a pair comes from the server in the pair's own units (candles?quote=1).
  const pairDecimals = quoteOfMint(token.quoteMint)?.decimals;
  const solScale = display.converted && display.rates?.zecSol ? 1 / display.rates.zecSol : null;
  // The chart converts at the rate it loaded with (refreshed on a timeframe or unit change, not every minute).
  const roundedScale = solScale === null ? null : Number(solScale.toPrecision(3));
  const chartDenom = useMemo(
    () =>
      quoteView && pairDecimals !== undefined
        ? { unit: quote, pairDecimals }
        : roundedScale !== null
          ? { unit: `≈ ${display.unit}`, solScale: roundedScale }
          : { unit: "SOL" },
    [quoteView, quote, pairDecimals, roundedScale, display.unit],
  );
  const solPrice = display.sol(Number(priceSol));
  const shownPrice = quoteView ? priceQuote : Number(priceSol) > 0 && solPrice !== null ? solPrice : undefined;
  const mcapSol = Number(token.marketCapSol);
  const shownMcap = !(mcapSol > 0) ? null : quoteView ? (scale !== null ? mcapSol * scale : null) : display.sol(mcapSol);
  const statUnit = quoteView ? quote : display.unit;
  const statApprox = !quoteView && display.converted;
  const denomSwitch =
    quote !== "SOL" && !sameUnit ? <DenomSwitch quote={quote} alt={display.unit} value={denomPick} onChange={setDenom} solAvailable={Number(priceSol) > 0} /> : null;
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
        .flatMap((o) =>
          o.kind === "bracket"
            ? [
                { id: `${o.id}:tp`, price: Number(o.triggerPriceSol), label: "Bracket TP" },
                ...(o.slPriceSol ? [{ id: `${o.id}:sl`, price: Number(o.slPriceSol), label: o.armed ? "Bracket SL · armed" : "Bracket SL" }] : []),
              ]
            : [{ id: o.id, price: Number(o.triggerPriceSol), label: ORDER_LABEL[o.kind] }],
        ),
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
            <QuoteBadge quote={quote} className="h-5 self-center text-[11px]" />
            <span className="text-lg text-muted-foreground">{token.name}</span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <VenueTag venue={token.venue} platform={token.platform} />
            <span className="text-faint-foreground">
              {token.status === "graduated" ? "graduated" : curve === null ? "on bonding curve" : <span className="tabular">curve {curve}%</span>}
            </span>
            <CopyButton value={token.mint} label="Copy mint address" className="font-mono">
              {shortAddr(token.mint, 5, 5)}
            </CopyButton>
          </div>
        </div>
      </header>

      {quote === "ZEC" && <ZecPairNote />}

      <dl className="ledger mt-8 grid-cols-3">
        <Stat label="Price" value={shownPrice === undefined ? "—" : formatPrice(shownPrice)} unit={statUnit} approx={statApprox && shownPrice !== undefined} />
        <Stat label="Market cap" value={shownMcap === null ? "—" : formatCompact(shownMcap)} unit={statUnit} approx={statApprox && shownMcap !== null} />
        <Stat label="Created" value={now === null ? "" : timeAgo(token.createdAt, now)} unit="ago" />
      </dl>

      <div aria-hidden className="hatch mt-6 h-3" />
      <div className="ledger grid lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_1fr]">
        <div className="min-w-0">
          <PriceChart mint={token.mint} trades={feed.events} markers={ownFills} triggers={triggers} showMarkers={shown} denom={chartDenom} denomSwitch={denomSwitch} />
        </div>

        <aside className="flex flex-col gap-px bg-border lg:col-start-2 lg:row-span-2 lg:row-start-1 [&>*]:bg-background">
          <TradePanel token={token} priceSol={priceSol} priceQuote={priceQuote} />
          <PositionCard token={token} priceSol={priceSol} priceQuote={priceQuote} />
          <SafetyPanel state={safety} />
          <div className="hatch hidden min-h-6 flex-1 opacity-50 lg:block" aria-hidden />
        </aside>

        <TokenActivity mint={token.mint} feed={feed} />
      </div>
      <div aria-hidden className="hatch h-3" />
    </Frame>
  );
}

function Stat({ label, value, unit, approx }: { label: string; value: string; unit: string; approx?: boolean }) {
  return (
    <div className="bg-background px-4 py-4 sm:px-5">
      <dt className="text-xs text-faint-foreground">{label}</dt>
      <dd className="tabular mt-1 truncate text-lg sm:text-xl">
        {approx && <span className="text-faint-foreground">≈ </span>}
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

/** Plain decimal string with ~6 significant digits (no e-notation). */
function plain(p: number): string {
  return p.toFixed(Math.min(20, Math.max(0, 5 - Math.floor(Math.log10(p)))));
}

/**
 * Price of the latest trade we saw on the socket, else the token's own prices. SOL: the SOL (equivalent)
 * per token; quote (v0.13, non-SOL pairs): the pair's own price from the trade's quote amount.
 */
function useLivePrice(token: TokenWithTrades, events: FeedEvent[]): { sol: string; quote: string | undefined } {
  const base = { sol: token.priceSol, quote: Number(token.priceQuote) > 0 ? token.priceQuote : undefined };
  const e = events.find((x) => x.kind !== "create");
  if (!e || token.trades.some((t) => t.id === e.id)) return base;
  const tokens = Number(e.tokenAmount) / 10 ** e.decimals;
  if (!(tokens > 0)) return base;
  const sol = Number(e.solAmount) / 1e9;
  const q = eventQuote(e);
  return {
    sol: sol > 0 ? plain(sol / tokens) : base.sol,
    quote: q && q.quote === token.quote && q.amount > 0 ? plain(q.amount / tokens) : base.quote,
  };
}

/** Price unit of a non-SOL pair: its quote (default) or the SOL equivalent. */
function DenomSwitch({ quote, alt, value, onChange, solAvailable }: { quote: Quote; alt: string; value: "quote" | "SOL"; onChange: (v: "quote" | "SOL") => void; solAvailable: boolean }) {
  return (
    <div role="radiogroup" aria-label="Price unit" className="flex gap-0.5 rounded-full border border-border p-0.5">
      {(["quote", "SOL"] as const).map((v) => {
        const on = value === v;
        const off = v === "SOL" && !solAvailable;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={off}
            title={off ? `No ${alt} equivalent for this pair yet` : v === "SOL" ? (alt === "SOL" ? "SOL equivalent of the pair's price" : `≈ ${alt} at the public reference rate`) : `Priced in ${quote}`}
            onClick={() => onChange(v)}
            className={cn(
              "hit rounded-full px-2 py-0.5 font-mono text-[11px] transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40",
              on ? "bg-surface-3 text-foreground" : "text-faint-foreground hover:text-muted-foreground",
            )}
          >
            {v === "quote" ? quote : alt}
          </button>
        );
      })}
    </div>
  );
}

/** The ZEC-pair story, said once, quietly: the whole trade stays in ZEC. */
function ZecPairNote() {
  return (
    <p className="mt-5 flex max-w-2xl items-start gap-2.5 text-sm text-pretty text-muted-foreground">
      <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-zec shadow-[0_0_10px_2px_rgba(244,183,40,0.35)]" />
      <span>
        <span className="text-foreground">Paid in ZEC, priced in ZEC.</span> This token trades against ZEC on Solana (bridged ZEC SPL). Your shielded balance buys it one to one, with no
        SOL rate in between.
      </span>
    </p>
  );
}
