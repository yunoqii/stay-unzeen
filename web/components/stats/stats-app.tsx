"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ChartBar } from "@phosphor-icons/react";
import { api, ApiError, errorText } from "@/lib/api/client";
import type { KAmount, KCount, PlatformStats, Venue } from "@/lib/api/types";
import { formatCompact, formatPrice } from "@/lib/format";
import { useNetwork } from "@/lib/network";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/page-shell";
import { TokenGlyph } from "@/components/tokens/token-glyph";
import { VenueTag } from "@/components/tokens/venue-tag";

const EASE = [0.16, 1, 0.3, 1] as const;
const VENUES: Venue[] = ["pumpfun", "meteora-dbc", "jupiter"];
const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

type Load = { s: "loading" } | { s: "none" } | { s: "error"; message: string } | { s: "ready"; data: PlatformStats };

/** "<5" from the server (k-anonymity) is shown as such, never as a number. */
function K({ v, format }: { v: KAmount | KCount; format?: (n: number) => string }) {
  if (v === "<5")
    return (
      <span title="Fewer than 5: too few to publish without pointing at someone" className="text-muted-foreground">
        &lt;5
      </span>
    );
  const n = Number(v);
  return <>{format ? format(n) : n.toLocaleString("en-US")}</>;
}

const sol = (n: number) => (n >= 10_000 ? formatCompact(n) : n.toLocaleString("en-US", { maximumFractionDigits: 1 }));

/**
 * Public, daily stats: one snapshot built after 00:00 UTC, the same for everyone. Nothing moves when
 * a trade or a deposit happens, and every category under 5 events reads "<5".
 */
export function StatsApp() {
  const network = useNetwork();
  const [st, setSt] = useState<Load & { network: string }>({ s: "loading", network });
  const reduce = useReducedMotion();

  useEffect(() => {
    let alive = true;
    api
      .getStats()
      .then((data) => alive && setSt({ s: "ready", data, network }))
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof ApiError && e.code === "not_found") setSt({ s: "none", network });
        else setSt({ s: "error", message: errorText(e), network });
      });
    return () => {
      alive = false;
    };
  }, [network]);

  const load: Load = st.network === network ? st : { s: "loading" };
  if (load.s === "loading")
    return (
      <div aria-busy className="space-y-3">
        <Skeleton className="h-28 rounded-none bg-skeleton" />
        <Skeleton className="h-48 rounded-none bg-skeleton" />
      </div>
    );
  if (load.s === "none")
    return (
      <EmptyState icon={<ChartBar size={28} weight="thin" />} title="Stats appear after the first daily snapshot">
        The pool publishes them once a day, at 00:00 UTC. Nothing here is live.
      </EmptyState>
    );
  if (load.s === "error") return <EmptyState title="Could not load the stats">{load.message}</EmptyState>;

  const d = load.data;
  const cells: Array<[string, React.ReactNode, string]> = [
    ["Volume", <K key="v" v={d.volumeSol} format={sol} />, "SOL"],
    ["Trades", <K key="t" v={d.trades} />, "buys + sells"],
    ["Launches", <K key="l" v={d.launches} />, "through the pool"],
    ["Through the shielded pool", <K key="z" v={d.zecShielded} format={(n) => n.toLocaleString("en-US")} />, "ZEC deposited"],
  ];

  return (
    <div className="space-y-8">
      <motion.dl
        className="ledger grid-cols-2 md:grid-cols-4"
        initial={reduce ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE }}
      >
        {cells.map(([label, value, unit]) => (
          <div key={label} className="px-4 py-5 sm:px-5">
            <dt className="text-xs text-faint-foreground">{label}</dt>
            <dd className="tabular mt-1.5 truncate text-2xl font-medium tracking-tight sm:text-3xl">{value}</dd>
            <dd className="mt-0.5 text-xs text-faint-foreground">{unit}</dd>
          </div>
        ))}
      </motion.dl>

      <section aria-labelledby="venues-t">
        <h2 id="venues-t" className="mb-3 text-sm font-medium">
          By venue
        </h2>
        <div className="ledger">
          <div className="hidden grid-cols-[minmax(0,1.2fr)_repeat(3,minmax(0,1fr))] gap-4 px-4 py-2.5 font-mono text-[10px] tracking-wider text-faint-foreground uppercase sm:grid">
            <span>Venue</span>
            <span className="text-right">Volume, SOL</span>
            <span className="text-right">Trades</span>
            <span className="text-right">Launches</span>
          </div>
          {VENUES.map((v) => {
            const row = d.byVenue[v];
            return (
              <div key={v} className="grid grid-cols-3 gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[minmax(0,1.2fr)_repeat(3,minmax(0,1fr))]">
                <VenueTag venue={v} className="col-span-3 sm:col-span-1" />
                <Cell label="Volume, SOL">
                  <K v={row.volumeSol} format={sol} />
                </Cell>
                <Cell label="Trades">
                  <K v={row.trades} />
                </Cell>
                <Cell label="Launches">
                  <K v={row.launches} />
                </Cell>
              </div>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="top-t">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="top-t" className="text-sm font-medium">
            Top tokens by pool volume
          </h2>
          <span className="text-xs text-faint-foreground">last {d.topWindowDays} days</span>
        </div>
        {d.topTokens.length === 0 ? (
          <p className="border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No token had 5 or more pool trades in the window yet.
          </p>
        ) : (
          <ol className="ledger">
            {d.topTokens.map((t, i) => (
              <li key={t.mint}>
                <Link
                  href={`/token/${t.mint}`}
                  className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-feed-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:grid-cols-[1.5rem_minmax(0,1fr)_7rem_6rem_6rem]"
                >
                  <span className="font-mono text-xs text-faint-foreground tabular">{i + 1}</span>
                  <span className="flex min-w-0 items-center gap-3">
                    <TokenGlyph symbol={t.symbol} image={t.image} className="size-8 shrink-0 rounded-lg text-[10px]" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">${t.symbol}</span>
                      <span className="block truncate text-xs text-faint-foreground">
                        <VenueTag venue={t.venue} /> · {t.status === "graduated" ? "graduated" : "on curve"}
                      </span>
                    </span>
                  </span>
                  <span className="tabular text-right text-sm">
                    {sol(Number(t.volumeSol))} <span className="text-xs text-faint-foreground">SOL</span>
                  </span>
                  <span className="tabular hidden text-right text-sm text-muted-foreground sm:block">{t.trades.toLocaleString("en-US")} trades</span>
                  <span className="tabular hidden text-right text-xs text-faint-foreground sm:block">{formatPrice(t.priceSol)} SOL</span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="space-y-1 border-t border-border/60 pt-4 text-xs text-pretty text-faint-foreground">
        <p className="text-muted-foreground">
          Updated daily at 00:00 UTC · snapshot of <span className="tabular">{day.format(d.asOf)}</span>
        </p>
        <p>
          Only trades the pool already made in public on Solana, volumes rounded down to 0.1 SOL. The ZEC figure moves only after 5 new deposits, so no step is
          ever one person’s deposit. Anything built from fewer than 5 events shows as “&lt;5”. Nothing about creators, ever.
        </p>
      </footer>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="tabular flex flex-col gap-0.5 sm:block sm:text-right">
      <span className="text-[11px] whitespace-nowrap text-faint-foreground sm:hidden">{label}</span>
      {children}
    </span>
  );
}
