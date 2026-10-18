"use client";

import { useId, useMemo } from "react";
import { ChartLineUp, DownloadSimple, LockSimple } from "@phosphor-icons/react";
import { useDisplay } from "@/lib/display-store";
import { formatSol, formatZec, zatToZec } from "@/lib/format";
import { useHistory } from "@/lib/history/store";
import { nativeOf, useNetwork } from "@/lib/network";
import { historyCsv, realizedSeries } from "@/lib/pnl-series";
import { cn } from "@/lib/utils";
import { useNow } from "@/hooks/use-now";
import { PeekToggle, usePeek, Veiled } from "./peek";

const W = 560;
const H = 120;

/**
 * Realized PnL over time across every token, and the CSV of your trades, both from the encrypted history on this
 * device. Veiled like balances until Peek; the export never touches the network.
 */
export function PnlCard() {
  const history = useHistory();
  const display = useDisplay();
  const network = useNetwork();
  const { shown } = usePeek();
  const id = useId();
  const series = useMemo(() => realizedSeries(history.entries), [history.entries]);
  const now = useNow(60_000);
  if (history.status !== "ready" || history.entries.length === 0) return null;

  const last = series.length ? series[series.length - 1].realizedZat : BigInt(0);
  const zecShown = (zat: bigint) => {
    const v = display.zec(zatToZec(zat.toString()));
    if (v === null) return "—";
    return display.zecConverted ? formatSol(v) : formatZec(zat.toString());
  };
  const sign = last > BigInt(0) ? "+" : "";

  // Step line of the cumulative value, from zero at the first trade.
  const pts = [{ ts: Math.min(...history.entries.map((e) => e.fill?.ts ?? e.submittedAt)), v: 0 }, ...series.map((p) => ({ ts: p.ts, v: Number(p.realizedZat) }))];
  const t0 = pts[0].ts;
  // The line runs on to now: one early sale is a step, not a vertical stroke at the left edge.
  const t1 = Math.max(pts[pts.length - 1].ts, now ?? 0, t0 + 1);
  const lo = Math.min(0, ...pts.map((p) => p.v));
  const hi = Math.max(0, ...pts.map((p) => p.v));
  const span = hi - lo || 1;
  const x = (ts: number) => ((ts - t0) / (t1 - t0)) * (W - 8) + 4;
  const y = (v: number) => H - 6 - ((v - lo) / span) * (H - 12);
  const d = pts.map((p, i) => (i === 0 ? `M${x(p.ts)},${y(p.v)}` : `H${x(p.ts)}V${y(p.v)}`)).join("") + `H${x(t1)}`;

  const exportCsv = () => {
    const nat = nativeOf();
    const blob = new Blob([historyCsv(history.entries, nat.symbol, nat.decimals)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `unzeen-trades-${network}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section aria-labelledby={`${id}-t`} className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${id}-t`} className="flex items-center gap-2 font-medium">
          <ChartLineUp size={16} weight="light" className="text-muted-foreground" aria-hidden />
          Realized PnL
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <DownloadSimple size={12} aria-hidden /> CSV
          </button>
          <PeekToggle className="h-7 px-2.5" />
        </div>
      </div>
      <p className="tabular mt-2 text-2xl font-medium tracking-tight">
        <Veiled>
          <span className={cn(last > BigInt(0) && "text-buy", last < BigInt(0) && "text-sell")}>
            {display.zecConverted ? "≈ " : ""}
            {sign}
            {zecShown(last)}
          </span>
        </Veiled>{" "}
        <span className="text-sm font-normal text-muted-foreground">{display.zecUnit}</span>
      </p>
      <div className="mt-3">
        {series.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-faint-foreground">The line starts with your first sale.</p>
        ) : shown ? (
          <svg role="img" aria-label="Cumulative realized PnL over time" viewBox={`0 0 ${W} ${H}`} className="h-28 w-full" preserveAspectRatio="none">
            <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="stroke-border" strokeDasharray="3 4" />
            <path d={d} fill="none" strokeWidth={1.6} vectorEffect="non-scaling-stroke" className={last >= BigInt(0) ? "stroke-buy" : "stroke-sell"} />
          </svg>
        ) : (
          <div aria-hidden className="hatch h-28 rounded-xl" />
        )}
      </div>
      <p className="mt-3 flex items-start gap-1.5 text-[11px] text-pretty text-faint-foreground">
        <LockSimple size={11} weight="light" className="mt-px shrink-0" aria-hidden />
        From your own trades kept encrypted on this device; sells count at their average cost. The CSV is made here and saved by your browser, never uploaded.
      </p>
    </section>
  );
}
