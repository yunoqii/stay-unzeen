"use client";

import Link from "next/link";
import { Ghost } from "@phosphor-icons/react";
import type { Portfolio, Token } from "@/lib/api/types";
import { formatCompact, formatSol, shortAddr, unitsToNumber } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { TokenGlyph } from "@/components/tokens/token-glyph";
import { VenueTag } from "@/components/tokens/venue-tag";
import { Veiled } from "./peek";

export function HoldingsList({ holdings, tokens }: { holdings: Portfolio["holdings"] | null; tokens: Token[] | null }) {
  const bySymbol = new Map((tokens ?? []).map((t) => [t.mint, t]));

  return (
    <section aria-labelledby="tokens-title" className="rounded-2xl border border-border bg-card/60 p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="tokens-title" className="font-medium">
          Tokens
        </h2>
        <p className="text-xs text-faint-foreground">Held by pool vaults for you</p>
      </div>

      {holdings === null ? (
        <div className="mt-4 space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-14 rounded-xl bg-skeleton" />
          ))}
        </div>
      ) : holdings.length === 0 ? (
        <div className="mt-4 flex flex-col items-center rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <Ghost size={24} weight="thin" className="text-muted-foreground" aria-hidden />
          <p className="mt-3 text-sm font-medium">No tokens yet</p>
          <p className="mt-1 max-w-xs text-sm text-pretty text-muted-foreground">
            Pick one from the feed. The pool buys it; the chain only sees “unzeen”.
          </p>
          <Link
            href="/"
            className="mt-4 rounded-full text-sm text-zec underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Open the feed
          </Link>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-border/60">
          {holdings.map((h) => {
            const t = bySymbol.get(h.mint);
            const amount = t ? unitsToNumber(h.amount, t.decimals) : null;
            const valueSol = t && amount !== null ? amount * Number(t.priceSol) : null;
            const held = t && /^[1-9]\d*$/.test(h.held) ? unitsToNumber(h.held, t.decimals) : null;
            return (
              <li key={h.mint}>
                <Link
                  href={`/token/${encodeURIComponent(h.mint)}`}
                  className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 transition-colors duration-150 hover:bg-feed-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <TokenGlyph symbol={t?.symbol ?? "?"} image={t?.image} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{t ? `$${t.symbol}` : shortAddr(h.mint)}</p>
                    {t ? <VenueTag venue={t.venue} className="text-xs" /> : <p className="text-xs text-faint-foreground">Loading…</p>}
                  </div>
                  <div className="text-right text-sm tabular">
                    <p>
                      <Veiled>{amount === null ? "—" : formatCompact(amount)}</Veiled>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      ≈ <Veiled>{valueSol === null ? "—" : formatSol(valueSol)}</Veiled> SOL
                    </p>
                    {held !== null && (
                      <p className="text-xs text-faint-foreground">
                        + <Veiled>{formatCompact(held)}</Veiled> held
                      </p>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
