"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, Ghost } from "@phosphor-icons/react";
import { captureShared, sharedProps } from "@/components/motion/shared-element";
import type { Portfolio, Token } from "@/lib/api/types";
import { formatCompact, formatSol, shortAddr, unitsToNumber } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { TokenGlyph } from "@/components/tokens/token-glyph";
import { VenueTag } from "@/components/tokens/venue-tag";
import { Veiled } from "./peek";
import { UsdHint } from "@/components/layout/amount";
import { useDisplay } from "@/lib/display-store";

export function HoldingsList({
  holdings,
  tokens,
  onWithdraw,
}: {
  holdings: Portfolio["holdings"] | null;
  tokens: Token[] | null;
  onWithdraw?: (mint: string) => void;
}) {
  const bySymbol = new Map((tokens ?? []).map((t) => [t.mint, t]));
  const display = useDisplay();

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
        <ul className="relative mt-3">
          <AnimatePresence initial={false} mode="popLayout">
          {holdings.map((h) => {
            const t = bySymbol.get(h.mint);
            const amount = t ? unitsToNumber(h.amount, t.decimals) : null;
            const valueSol = t && amount !== null ? amount * Number(t.priceSol) : null;
            // Valued in the display unit (ZEC by default), always approximate: a mark, not a quote.
            const shownValue = valueSol === null ? null : display.sol(valueSol);
            const held = t && /^[1-9]\d*$/.test(h.held) ? unitsToNumber(h.held, t.decimals) : null;
            return (
              <motion.li
                key={h.mint}
                layout="position"
                // Withdrawn in full: the row dissolves (FRONTEND.md moment 7).
                exit={{ opacity: 0, filter: "blur(12px)", scale: 0.9, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } }}
                transition={{ layout: { type: "spring", bounce: 0, duration: 0.35 } }}
                className="flex items-center gap-1 border-b border-border/60 last:border-b-0"
              >
                <Link
                  href={`/token/${encodeURIComponent(h.mint)}`}
                  onClick={(e) => captureShared(e.currentTarget)}
                  className="-mx-2 flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-3 transition-colors duration-150 hover:bg-feed-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span {...sharedProps(`glyph-${h.mint}`)} className="shrink-0">
                    <TokenGlyph symbol={t?.symbol ?? "?"} image={t?.image} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      <span {...sharedProps(`ticker-${h.mint}`)}>{t ? `$${t.symbol}` : shortAddr(h.mint)}</span>
                    </p>
                    {t ? <VenueTag venue={t.venue} className="text-xs" /> : <p className="text-xs text-faint-foreground">Loading…</p>}
                  </div>
                  <div className="text-right text-sm tabular">
                    <p>
                      <Veiled>{amount === null ? "—" : formatCompact(amount)}</Veiled>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      ≈ <Veiled>{shownValue === null ? "—" : formatSol(shownValue)}</Veiled> {display.unit}
                    </p>
                    {valueSol !== null && (
                      <p>
                        <UsdHint sol={valueSol} className="text-[11px]" />
                      </p>
                    )}
                    {held !== null && (
                      <p className="text-xs text-faint-foreground">
                        + <Veiled>{formatCompact(held)}</Veiled> held
                      </p>
                    )}
                  </div>
                </Link>
                {onWithdraw && h.amount !== "0" && (
                  <button
                    type="button"
                    onClick={() => onWithdraw(h.mint)}
                    aria-label={`Withdraw ${t ? "$" + t.symbol : "token"}`}
                    className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <ArrowUpRight size={16} weight="light" />
                  </button>
                )}
              </motion.li>
            );
          })}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}
