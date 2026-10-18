"use client";

import { useId, useMemo } from "react";
import { LockSimple } from "@phosphor-icons/react";
import type { Token } from "@/lib/api/types";
import { useKeyState } from "@/lib/crypto/session";
import { formatCompact, formatPrice, formatSol, formatZec, unitsToNumber, zatToZec } from "@/lib/format";
import { useDisplay } from "@/lib/display-store";
import { UsdHint } from "@/components/layout/amount";
import { expiredCount, fillsOf } from "@/lib/history/reduce";
import { useHistory } from "@/lib/history/store";
import { avgEntrySol, avgEntryZec, computePosition, unrealized, unrealizedZecPair } from "@/lib/pnl";
import { QUOTE_DECIMALS, quoteAsset, tokenQuote, zecSpreadBps } from "@/lib/quotes";
import { lastRate } from "@/lib/activity";
import { useNetwork } from "@/lib/network";
import { cn } from "@/lib/utils";
import { requestTrade } from "@/lib/trade-intent";
import { usePool } from "@/hooks/use-pool";
import { usePortfolio } from "@/hooks/use-portfolio";
import { PeekToggle, Veiled } from "@/components/portfolio/peek";
import { Skeleton } from "@/components/ui/skeleton";

const ZERO = BigInt(0);

/**
 * Your position in this token: size, average entry, PnL. Computed only here, from your own executed
 * actions kept encrypted on this device (lib/history). Veiled until "Peek", like balances.
 */
export function PositionCard({ token, priceSol, priceQuote }: { token: Token; priceSol: string; priceQuote?: string }) {
  const key = useKeyState();
  const history = useHistory();
  const { portfolio } = usePortfolio();
  const { pool } = usePool();
  const network = useNetwork();
  const display = useDisplay();
  const id = useId();

  const fills = useMemo(() => fillsOf(history.entries, token.mint), [history.entries, token.mint]);
  const pos = useMemo(() => computePosition(fills), [fills]);
  if (key.status !== "unlocked") return null;

  const held = portfolio ? BigInt(portfolio.holdings.find((h) => h.mint === token.mint)?.amount ?? "0") : null;
  const expired = expiredCount(history.entries, token.mint);
  if (history.status === "ready" && fills.length === 0 && (held === null || held === ZERO)) return null;

  const last = lastRate(network, "sell");
  const sellRate = pool?.rate ? BigInt(pool.rate.lamportsPerZecSell) : last ? BigInt(last.lamportsPerZec) : ZERO;
  // v0.13: a ZEC pair is marked at its own ZEC price through the 1:1 parity, never via SOL.
  const zecPair = tokenQuote(token) === "ZEC";
  const spread = zecSpreadBps(pool);
  const qDec = quoteAsset(pool, "ZEC", token.venue)?.decimals ?? QUOTE_DECIMALS.ZEC;
  const mark = (p: typeof pos) => (zecPair ? (spread === null ? null : unrealizedZecPair(p, priceQuote, token.decimals, spread, qDec)) : unrealized(p, priceSol, token.decimals, sellRate));
  const u = mark(pos);
  // Value = what you hold now (the pool's ledger), not what this device's history explains: a position bought
  // before the history began (or partly sold since) still has a value even when its PnL can't be computed.
  const value = held !== null && held > ZERO ? mark({ ...pos, qty: held }) : u;
  const entry = zecPair ? avgEntryZec(pos, token.decimals) : avgEntrySol(pos, token.decimals);
  const incomplete = pos.incomplete || expired > 0 || (held !== null && held > pos.qty);
  const pnl = u ? u.pnlZat + pos.realizedZat : pos.realizedZat;
  const sign = pnl > ZERO ? "+" : "";
  // Display unit (owner 13.10): ZEC by default; the native pick shows value and PnL as "≈ SOL" at the public
  // rate. The ledger's own numbers stay ZEC; this is only how they are read.
  const zecShown = (zat: bigint) => {
    const v = display.zec(zatToZec(zat.toString()));
    if (v === null) return "—";
    return display.zecConverted ? formatSol(v) : formatZec(zat.toString());
  };
  const zecMark = display.zecConverted ? "≈ " : "";
  const entryShown = entry === null ? null : zecPair ? entry : display.sol(entry);
  const entryUnit = zecPair ? "ZEC" : display.unit;
  const entryMark = !zecPair && display.converted ? "≈ " : "";

  return (
    <section aria-labelledby={`${id}-t`} className="p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${id}-t`} className="text-sm font-medium">
          Your position
        </h2>
        <PeekToggle className="h-7 px-2.5" />
      </div>

      {history.status === "loading" ? (
        <Skeleton className="mt-3 h-16 rounded-xl bg-skeleton" />
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
          <Cell label="Size">
            <Veiled>
              {formatCompact(unitsToNumber((held ?? pos.qty).toString(), token.decimals))} <span className="text-faint-foreground">${token.symbol}</span>
            </Veiled>
          </Cell>
          <Cell label="Avg entry">
            <Veiled>{entryShown === null ? "—" : `${entryMark}${formatPrice(entryShown)} ${entryUnit}`}</Veiled>
          </Cell>
          <Cell label="Value">
            <Veiled>{value ? `≈ ${zecShown(value.valueZat)} ${display.zecUnit}` : "—"}</Veiled>
            {value && <UsdHint zec={zatToZec(value.valueZat.toString())} className="ml-1.5" />}
          </Cell>
          <Cell label="PnL">
            <Veiled>
              <span className={cn(pnl > ZERO && "text-buy", pnl < ZERO && "text-sell")}>
                {fills.length === 0 ? "—" : `${zecMark}${sign}${zecShown(pnl)} ${display.zecUnit}`}
                {u?.pnlPct !== null && u?.pnlPct !== undefined && fills.length > 0 && (
                  <span className="ml-1 text-xs">
                    ({u.pnlPct > 0 ? "+" : ""}
                    {u.pnlPct.toFixed(1)}%)
                  </span>
                )}
              </span>
            </Veiled>
          </Cell>
        </dl>
      )}

      {held !== null && held > ZERO && (
        <div className="mt-3 flex gap-1.5" role="group" aria-label="Sell part of your position">
          {[25, 50, 100].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => requestTrade({ mint: token.mint, side: "sell", kind: "percent", pct: p })}
              className="h-8 flex-1 rounded-full border border-border text-xs transition-colors duration-150 hover:border-sell/60 hover:text-sell focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Sell {p}%
            </button>
          ))}
        </div>
      )}

      {incomplete && (
        <p className="mt-3 text-[11px] text-pretty text-zec/85">
          {expired > 0
            ? `PnL incomplete: ${expired} action${expired === 1 ? "" : "s"} expired before this device saw ${expired === 1 ? "it" : "them"} settle.`
            : "PnL incomplete: part of this position was bought before this device kept history."}
        </p>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-[11px] text-pretty text-faint-foreground">
        <LockSimple size={11} weight="light" className="mt-px shrink-0" aria-hidden />
        Computed in this browser from your own trades, encrypted with your key. Never sent to the server.
      </p>
    </section>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-faint-foreground">{label}</dt>
      <dd className="tabular mt-0.5 truncate">{children}</dd>
    </div>
  );
}
