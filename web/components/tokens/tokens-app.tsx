"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { motion } from "motion/react";
import { MagnifyingGlass, SealCheck, X } from "@phosphor-icons/react";
import { api, errorText } from "@/lib/api/client";
import type { DiscoveryToken } from "@/lib/api/types";
import { formatCompact, formatPrice, timeAgo } from "@/lib/format";
import { useNetwork } from "@/lib/network";
import { DEFAULT_FILTERS, filterTokens, fromDiscovery, type ListedToken, isNearGraduation, NEAR_GRADUATION_PCT, type QuoteFilter, type SortKey, type StatusFilter, type TokenFilters, type VenueFilter } from "@/lib/token-list";
import { onTabListKeyDown } from "@/lib/tabs";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/use-now";
import { usePool } from "@/hooks/use-pool";
import { useTokens } from "@/hooks/use-tokens";
import { EmptyState } from "@/components/layout/page-shell";
import { SolAmount } from "@/components/layout/amount";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { TokenGlyph } from "./token-glyph";
import { QuoteBadge } from "./quote-badge";
import { VenueTag } from "./venue-tag";

type Source = "pool" | "discovery";

const VENUES: { id: VenueFilter; label: string }[] = [
  { id: "all", label: "All venues" },
  { id: "pumpfun", label: "pump.fun" },
  { id: "meteora-dbc", label: "Meteora DBC" },
  { id: "raydium-launchlab", label: "Raydium LaunchLab" },
  { id: "jupiter", label: "Other" },
];
const PAIRS: { id: QuoteFilter; label: string }[] = [
  { id: "all", label: "Any pair" },
  { id: "SOL", label: "SOL pairs" },
  { id: "ZEC", label: "ZEC pairs" },
  { id: "USDC", label: "USDC pairs" },
  { id: "USD1", label: "USD1 pairs" },
];
const STATUSES: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "Any status" },
  { id: "curve", label: "On curve" },
  { id: "near", label: "Near graduation" },
  { id: "graduated", label: "Graduated" },
];
const SORTS: { id: SortKey; label: string }[] = [
  { id: "volume", label: "Volume 24h" },
  { id: "mcap", label: "Market cap" },
  { id: "age", label: "Newest" },
  { id: "trades", label: "unzeen trades" },
];

/** Discovery list (v0.12 GET /api/tokens?source=discovery): fetched only while that source is on, every 30 s. */
function useDiscovery(on: boolean) {
  const network = useNetwork();
  const [data, setData] = useState<{ network: string; tokens: DiscoveryToken[] | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    const load = () =>
      api
        .getDiscovery()
        .then((tokens) => alive && setData({ network, tokens, error: null }))
        .catch((e: unknown) => alive && setData((d) => ({ network, tokens: d?.network === network ? d.tokens : null, error: errorText(e) })));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [on, network]);
  return data?.network === network ? data : null;
}

export function TokensApp() {
  const id = useId();
  const { pool } = usePool();
  const discoveryOn = pool?.features?.discovery === true;
  const [source, setSource] = useState<Source>("pool");
  const src: Source = discoveryOn ? source : "pool";
  const poolList = useTokens(undefined, 20_000);
  const disc = useDiscovery(src === "discovery");
  const discRows = useMemo(() => disc?.tokens?.map(fromDiscovery) ?? null, [disc?.tokens]);
  const tokens: ListedToken[] | null = src === "pool" ? poolList.tokens : discRows;
  const error = src === "pool" ? poolList.error : (disc?.error ?? null);
  const [f, setF] = useState<TokenFilters>(DEFAULT_FILTERS);
  const set = <K extends keyof TokenFilters>(k: K, v: TokenFilters[K]) => setF((x) => ({ ...x, [k]: v }));
  const shown = useMemo(() => (tokens ? filterTokens(tokens, f) : null), [tokens, f]);
  const now = useNow(10_000);
  const filtered = f.unzeenOnly || f.venue !== "all" || f.quote !== "all" || f.status !== "all" || f.query.trim() !== "";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {discoveryOn && (
          <div role="tablist" aria-label="Source" onKeyDown={(e) => onTabListKeyDown(e)} className="flex gap-0.5 rounded-full border border-border p-0.5">
            {(["pool", "discovery"] as const).map((s) => {
              const on = src === s;
              return (
                <button
                  key={s}
                  role="tab"
                  type="button"
                  aria-selected={on}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setSource(s)}
                  title={s === "discovery" ? "Every new launchpad token, through the indexer" : "Tokens the pool trades"}
                  className={cn(
                    "hit relative rounded-full px-3 py-1 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {on && <motion.span layoutId={`${id}-src`} className="absolute inset-0 rounded-full bg-surface-3" transition={{ type: "spring", bounce: 0, duration: 0.25 }} />}
                  <span className="relative">{s === "pool" ? "Pool" : "Discovery"}</span>
                </button>
              );
            })}
          </div>
        )}
        <label className="relative min-w-56 flex-1">
          <span className="sr-only">Search by ticker, name or contract address</span>
          <MagnifyingGlass size={16} weight="light" aria-hidden className="absolute top-1/2 left-3 -translate-y-1/2 text-faint-foreground" />
          <input
            value={f.query}
            onChange={(e) => set("query", e.target.value)}
            placeholder="Ticker, name or contract address"
            autoComplete="off"
            spellCheck={false}
            className="h-10 w-full rounded-full border border-border bg-surface-1 pr-9 pl-9 text-sm outline-none placeholder:text-faint-foreground focus-visible:border-ring"
          />
          {f.query && (
            <button type="button" aria-label="Clear search" onClick={() => set("query", "")} className="hit absolute top-1/2 right-3 -translate-y-1/2 text-faint-foreground hover:text-foreground">
              <X size={14} />
            </button>
          )}
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={f.unzeenOnly}
          onClick={() => set("unzeenOnly", !f.unzeenOnly)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            f.unzeenOnly ? "border-zec/50 bg-zec/10 text-foreground" : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
          )}
        >
          <SealCheck size={14} weight={f.unzeenOnly ? "fill" : "light"} className={f.unzeenOnly ? "text-zec" : undefined} aria-hidden />
          Launched via Unzeen
        </button>
        <Select label="Venue" value={f.venue} options={VENUES} onChange={(v) => set("venue", v)} />
        <Select label="Pair" value={f.quote} options={PAIRS} onChange={(v) => set("quote", v)} />
        <Select label="Status" value={f.status} options={STATUSES} onChange={(v) => set("status", v)} />
        <Select label="Sort by" value={f.sort} options={SORTS} onChange={(v) => set("sort", v)} />
        {filtered && (
          <button type="button" onClick={() => setF({ ...DEFAULT_FILTERS, sort: f.sort })} className="text-xs text-faint-foreground underline-offset-4 hover:text-foreground hover:underline">
            Reset filters
          </button>
        )}
        <span className="tabular ml-auto text-xs text-faint-foreground" aria-live="polite">
          {shown ? `${shown.length} of ${tokens?.length ?? 0}` : ""}
        </span>
      </div>

      {src === "discovery" && (
        <p className="text-xs text-pretty text-faint-foreground">
          Discovery lists every fresh launchpad token, not only ones the pool trades. Opening one asks the indexer about it on its next tick, the same way a contract-address search does.
        </p>
      )}

      {error && !tokens ? (
        <ErrorState error={error} title="Tokens unavailable" />
      ) : !shown ? (
        <div aria-busy className="ledger">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="size-9 rounded-lg bg-skeleton" />
              <Skeleton className="h-4 bg-skeleton" style={{ width: `${30 + ((i * 11) % 40)}%` }} />
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState art title={filtered ? "Nothing matches these filters." : "No tokens yet."}>
          {filtered
            ? src === "discovery" && f.quote !== "all"
              ? "Discovery rows don't say which pair they trade against. Pick Any pair, or switch to Pool."
              : "Try another venue, pair or status, or clear the search."
            : "Once unzeen trades a token, it shows up here."}
        </EmptyState>
      ) : (
        <div className="ledger overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">Tokens, sorted by {SORTS.find((s) => s.id === f.sort)?.label}</caption>
            <thead>
              <tr className="text-left text-xs text-faint-foreground [&>th]:px-4 [&>th]:py-2.5 [&>th]:font-normal">
                <th scope="col">Token</th>
                <th scope="col">Venue</th>
                <th scope="col">Status</th>
                <th scope="col" className="text-right" aria-sort={f.sort === "mcap" ? "descending" : undefined}>
                  Market cap
                </th>
                <th scope="col" className="text-right" aria-sort={f.sort === "volume" ? "descending" : undefined}>
                  Volume 24h
                </th>
                <th scope="col" className="text-right" aria-sort={f.sort === "trades" ? "descending" : undefined}>
                  unzeen trades
                </th>
                <th scope="col" className="text-right" aria-sort={f.sort === "age" ? "descending" : undefined}>
                  Age
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60 border-t border-border/60">
              {shown.map((t) => (
                <Row key={t.mint} t={t} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ t, now }: { t: ListedToken; now: number | null }) {
  const pct = t.curveProgressPct !== undefined ? Number(t.curveProgressPct) : null;
  const near = isNearGraduation(t);
  return (
    <tr className="group relative transition-colors hover:bg-feed-row-hover">
      <td className="px-4 py-3">
        <Link href={`/token/${t.mint}`} className="flex min-w-0 items-center gap-3 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset">
          <TokenGlyph symbol={t.symbol} image={t.image} className="size-9 shrink-0" />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="font-medium">${t.symbol}</span>
              <QuoteBadge quote={t.quote} />
              {t.unzeenLaunch && <SealCheck size={13} weight="fill" className="text-zec" aria-label="Launched via Unzeen" />}
            </span>
            <span className="block max-w-[14rem] truncate text-xs text-muted-foreground">{t.name}</span>
          </span>
        </Link>
      </td>
      <td className="px-4 py-3 text-xs">
        <VenueTag venue={t.venue} platform={t.platform} />
      </td>
      <td className="px-4 py-3 text-xs">
        {t.status === "graduated" ? (
          <span className="text-muted-foreground">Graduated</span>
        ) : pct === null ? (
          <span className="text-muted-foreground">On curve</span>
        ) : (
          <span className="flex items-center gap-2" title={near ? `At least ${NEAR_GRADUATION_PCT}% of the curve is filled` : undefined}>
            <span aria-hidden className="h-1 w-16 overflow-hidden rounded-full bg-surface-3">
              <span className={cn("block h-full rounded-full", near ? "bg-zec" : "bg-muted-foreground/60")} style={{ width: `${Math.min(100, pct)}%` }} />
            </span>
            <span className={cn("tabular", near ? "text-zec" : "text-muted-foreground")}>{pct.toFixed(0)}%</span>
          </span>
        )}
      </td>
      <td className="tabular px-4 py-3 text-right">
        {Number(t.marketCapSol) > 0 ? (
          <>
            <SolAmount sol={Number(t.marketCapSol)} format={formatCompact} unitClassName="text-xs text-faint-foreground" />
          </>
        ) : (
          <span className="text-faint-foreground">—</span>
        )}
        <RowPrice t={t} />
      </td>
      <td className="tabular px-4 py-3 text-right">{t.volume24hSol === undefined ? <span className="text-faint-foreground">—</span> : <SolAmount sol={Number(t.volume24hSol)} format={formatCompact} unitClassName="text-xs text-faint-foreground" />}</td>
      <td className="tabular px-4 py-3 text-right">{t.unzeenTrades24h === undefined ? <span className="text-faint-foreground">—</span> : t.unzeenTrades24h}</td>
      <td className="tabular px-4 py-3 text-right font-mono text-xs text-faint-foreground">{now === null ? "" : timeAgo(t.createdAt, now)}</td>
    </tr>
  );
}

/** Price under the market cap: in the pair's own quote when it has one (ZEC pairs never via SOL). */
function RowPrice({ t }: { t: ListedToken }) {
  const q = t.quote ?? "SOL";
  const inQuote = q !== "SOL" && Number(t.priceQuote) > 0;
  return (
    <span className="block text-[11px] text-faint-foreground">
      {inQuote ? (
        <>
          {formatPrice(t.priceQuote!)} <span>{q}</span>
        </>
      ) : Number(t.priceSol) > 0 ? (
        <SolAmount sol={Number(t.priceSol)} format={formatPrice} unitClassName="" />
      ) : (
        "—"
      )}
    </span>
  );
}

function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <label className="relative inline-flex">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className={cn(
          "h-8 appearance-none rounded-full border bg-surface-1 pr-7 pl-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
          value === options[0].id && label !== "Sort by" ? "border-border text-muted-foreground" : "border-border-strong text-foreground",
        )}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {label === "Sort by" ? `Sort: ${o.label}` : o.label}
          </option>
        ))}
      </select>
      <span aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[9px] text-faint-foreground">
        ▼
      </span>
    </label>
  );
}
