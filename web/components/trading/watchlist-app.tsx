"use client";

import Link from "next/link";
import { BellRinging, LockKey, Star } from "@phosphor-icons/react";
import type { TokenListItem } from "@/lib/api/types";
import type { PulseToken } from "@/lib/api/types";
import { useKeyState } from "@/lib/crypto/session";
import { formatCompact, formatPrice } from "@/lib/format";
import { boardTokens, sparkOf } from "@/lib/pulse/board";
import { useWorkspace } from "@/lib/workspace/store";
import { usePulse } from "@/hooks/use-pulse";
import { SolAmount } from "@/components/layout/amount";
import { EmptyState } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TokenGlyph } from "@/components/tokens/token-glyph";
import { VenueTag } from "@/components/tokens/venue-tag";
import { QuickBuy } from "./quick-buy";
import { Sparkline } from "./sparkline";
import { WatchStar } from "./watch-star";

/**
 * Your watchlist, filtered on this device from the public lists everyone polls (Pulse board + token list):
 * no request ever names the tokens you watch.
 */
export function WatchlistApp() {
  const key = useKeyState();
  const ws = useWorkspace();
  const { board, tokens } = usePulse();

  if (key.status !== "unlocked")
    return (
      <EmptyState title="Unlock to see your watchlist" art>
        It is kept encrypted with your anon key on this device, never on a server.
        <Button asChild className="mt-4 h-10 rounded-full px-5">
          <Link href="/key?next=%2Fwatchlist">
            <LockKey aria-hidden /> Unlock key
          </Link>
        </Button>
      </EmptyState>
    );
  if (!ws.ready) return <Skeleton className="h-40 rounded-2xl bg-skeleton" />;
  if (ws.file.watchlist.length === 0)
    return (
      <EmptyState title="Nothing watched yet" art>
        Tap the <Star size={12} className="inline align-[-1px]" aria-hidden /> on a token page or a{" "}
        <Link href="/pulse" className="text-foreground underline underline-offset-4 hover:text-zec">
          Pulse
        </Link>{" "}
        card.
      </EmptyState>
    );

  const onBoard = boardTokens(board);
  const byMint = new Map<string, TokenListItem>((tokens ?? []).map((t) => [t.mint, t]));
  const alerts = ws.file.alerts;

  return (
    <ul className="ledger divide-y divide-border/60">
      {ws.file.watchlist.map((w) => {
        const t: PulseToken | TokenListItem | undefined = onBoard.get(w.mint) ?? byMint.get(w.mint);
        const armed = alerts.filter((a) => a.mint === w.mint && !a.firedAt).length;
        return (
          <li key={w.mint} className="relative flex items-center gap-3 p-4">
            <Link href={`/token/${w.mint}`} className="absolute inset-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label={`Open $${w.symbol}`} />
            <TokenGlyph symbol={w.symbol} image={t?.image} />
            <div className="min-w-0 flex-1">
              <p className="font-medium">${w.symbol}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-faint-foreground">
                {t ? <VenueTag venue={t.venue} platform={"platform" in t ? t.platform : undefined} /> : <span>Not in the public list right now</span>}
                {t?.status === "curve" && t.curveProgressPct !== undefined && <span className="tabular">· curve {Number(t.curveProgressPct).toFixed(0)}%</span>}
                {armed > 0 && (
                  <span className="inline-flex items-center gap-1 text-zec" title="Price alerts armed on this device">
                    · <BellRinging size={11} aria-hidden /> {armed}
                  </span>
                )}
              </p>
            </div>
            <Sparkline points={sparkOf(w.mint)} className="hidden sm:block" />
            <div className="tabular w-32 text-right text-sm">
              {t ? (
                <>
                  <p>
                    <SolAmount sol={Number(t.priceSol)} format={formatPrice} unitClassName="text-faint-foreground" />
                  </p>
                  <p className="text-xs text-faint-foreground">
                    MCap <SolAmount sol={Number(t.marketCapSol)} format={formatCompact} unitClassName="" />
                  </p>
                </>
              ) : (
                <span className="text-faint-foreground">—</span>
              )}
            </div>
            <div className="relative z-10 flex items-center gap-1">
              {t && <QuickBuy token={t} />}
              <WatchStar mint={w.mint} symbol={w.symbol} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
