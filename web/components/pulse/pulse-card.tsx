"use client";

import Link from "next/link";
import { ShieldCheck, ShieldWarning, UsersThree } from "@phosphor-icons/react";
import type { PulseToken } from "@/lib/api/types";
import { formatCompact, formatPrice } from "@/lib/format";
import { etaOf, formatEta, sparkOf } from "@/lib/pulse/board";
import { cn } from "@/lib/utils";
import { SolAmount } from "@/components/layout/amount";
import { TokenGlyph } from "@/components/tokens/token-glyph";
import { VenueTag } from "@/components/tokens/venue-tag";
import { QuickBuy } from "@/components/trading/quick-buy";
import { Sparkline } from "@/components/trading/sparkline";
import { WatchStar } from "@/components/trading/watch-star";

/** One Pulse card: price, market cap, curve progress + ETA, holders, safety, sparkline, star and quick buy. */
export function PulseCard({ token: t, now }: { token: PulseToken; now: number }) {
  const progress = t.status === "curve" && t.curveProgressPct !== undefined ? Math.max(0, Math.min(100, Number(t.curveProgressPct))) : null;
  const eta = etaOf(t);
  const safe = t.safety ? t.safety.mintRevoked && t.safety.freezeRevoked : null;
  const ageMin = Math.max(0, Math.round((now - t.createdAt) / 60_000));
  return (
    <article className="group relative rounded-2xl border border-border bg-background p-3.5 transition-colors duration-200 hover:border-zec/40">
      <Link href={`/token/${t.mint}`} className="absolute inset-0 rounded-2xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label={`Open $${t.symbol}`} />
      <div className="flex items-start gap-3">
        <TokenGlyph symbol={t.symbol} image={t.image} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2">
            <span className="truncate font-medium">${t.symbol}</span>
            {t.unzeenLaunch && <span className="shrink-0 rounded-full border border-zec/40 px-1.5 py-px text-[10px] text-zec">via unzeen</span>}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-faint-foreground">
            <VenueTag venue={t.venue} />
            <span aria-hidden>·</span>
            <span className="tabular">{ageMin < 60 ? `${ageMin}m` : ageMin < 1440 ? `${Math.round(ageMin / 60)}h` : `${Math.round(ageMin / 1440)}d`}</span>
          </p>
        </div>
        <div className="relative z-10">
          <WatchStar mint={t.mint} symbol={t.symbol} />
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <dt className="text-faint-foreground">Price</dt>
          <dd className="tabular text-right">
            <SolAmount sol={Number(t.priceSol)} format={formatPrice} unitClassName="text-faint-foreground" />
          </dd>
          <dt className="text-faint-foreground">MCap</dt>
          <dd className="tabular text-right">
            <SolAmount sol={Number(t.marketCapSol)} format={formatCompact} unitClassName="text-faint-foreground" />
          </dd>
        </dl>
        <Sparkline points={sparkOf(t.mint)} />
      </div>

      {progress !== null && (
        <div className="mt-3">
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="text-faint-foreground">Bonding curve</span>
            <span className="tabular">
              <span className="text-foreground">{progress.toFixed(progress < 10 ? 1 : 0)}%</span>
              {eta && <span className="ml-1.5 text-faint-foreground" title={eta.local ? "Estimated in this tab from the pace it saw" : "At the current pace"}>≈ {formatEta(eta.secs)} to graduation</span>}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} aria-label="Bonding curve progress">
            <div className={cn("h-full rounded-full", progress >= 80 ? "bg-zec" : "bg-zec/60")} style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-[11px] text-faint-foreground">
          {t.holders !== null && (
            <span className="inline-flex items-center gap-1" title="Holders, latest snapshot">
              <UsersThree size={12} aria-hidden />
              <span className="tabular">{formatCompact(t.holders)}</span>
            </span>
          )}
          {safe !== null && (
            <span className={cn("inline-flex items-center gap-1", safe ? "text-muted-foreground" : "text-sell")} title={safe ? "Mint and freeze authority revoked" : "Mint or freeze authority still active"}>
              {safe ? <ShieldCheck size={12} aria-hidden /> : <ShieldWarning size={12} aria-hidden />}
              {safe ? "Revoked" : "Authority live"}
            </span>
          )}
          {t.safety?.top10Pct && <span className="tabular" title="Top 10 holders, excluding the curve and pool vaults">Top10 {Number(t.safety.top10Pct).toFixed(0)}%</span>}
        </div>
        <div className="relative z-10">
          <QuickBuy token={t} />
        </div>
      </div>
    </article>
  );
}
