"use client";

import { onTabListKeyDown } from "@/lib/tabs";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import type { CandlestickData, IChartApi, IPriceLine, ISeriesApi, ISeriesMarkersPluginApi, HistogramData, SeriesMarker, Time, UTCTimestamp } from "lightweight-charts";
import { api, errorText } from "@/lib/api/client";
import type { Candle, CandleTimeframe, FeedEvent } from "@/lib/api/types";
import type { Fill } from "@/lib/pnl";
import { formatPrice, lamportsToSol, unitsToNumber } from "@/lib/format";
import { ORDER_LABEL } from "@/lib/orders";
import { useNetwork } from "@/lib/network";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

const TIMEFRAMES: CandleTimeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const TF_SEC: Record<CandleTimeframe, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };

interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // lamports
}

const hourLabel = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
const dayLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const fullTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

const toBar = (c: Candle): Bar => ({
  time: c.time,
  open: Number(c.open),
  high: Number(c.high),
  low: Number(c.low),
  close: Number(c.close),
  volume: Number(c.volume),
});

function cssVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Candles from GET /api/tokens/:mint/candles, kept live by this token's trades from the socket.
 * lightweight-charts is loaded on demand (client only). `markers` are the user's own fills from the
 * local encrypted history: drawn only while `showMarkers` (Peek), never sent anywhere.
 */
export function PriceChart({
  mint,
  trades,
  markers = [],
  triggers = [],
  showMarkers = false,
}: {
  mint: string;
  trades: FeedEvent[];
  markers?: readonly Fill[];
  /** v0.8: your open orders' trigger prices, drawn as dashed lines (local only, behind Peek like markers). */
  triggers?: readonly { id: string; price: number; label: string }[];
  showMarkers?: boolean;
}) {
  const [tf, setTf] = useState<CandleTimeframe>("5m");
  const [state, setState] = useState<"loading" | "ready" | "empty" | { error: string }>("loading");
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const marks = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const last = useRef<Bar | null>(null);
  const applied = useRef<Set<string>>(new Set());
  const network = useNetwork();
  const colors = useRef({ up: "#4fc98a", down: "#ef6b73" });
  const [readyTick, setReadyTick] = useState(0);
  const [loadedAt, setLoadedAt] = useState(0);

  // Chart instance: once per mount.
  useEffect(() => {
    let disposed = false;
    import("lightweight-charts").then((lc) => {
      if (disposed || !box.current) return;
      const up = cssVar("--buy", "#4fc98a");
      const down = cssVar("--sell", "#ef6b73");
      colors.current = { up, down };
      const c = lc.createChart(box.current, {
        autoSize: true,
        layout: {
          background: { type: lc.ColorType.Solid, color: "transparent" },
          textColor: cssVar("--faint-foreground", "#7c7c86"),
          fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
          fontSize: 11,
          attributionLogo: false,
        },
        grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.24 } },
        timeScale: {
          borderVisible: false,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 4,
          tickMarkFormatter: (t: number, kind: number) => (kind <= 2 ? dayLabel : hourLabel).format(t * 1000),
        },
        crosshair: {
          mode: lc.CrosshairMode.Magnet,
          vertLine: { color: "rgba(244,183,40,0.35)", labelBackgroundColor: "#18181c" },
          horzLine: { color: "rgba(244,183,40,0.35)", labelBackgroundColor: "#18181c" },
        },
        // Bars are UTC seconds; labels in the viewer's local time.
        localization: { priceFormatter: (p: number) => formatPrice(p), timeFormatter: (t: number) => fullTime.format(t * 1000) },
        handleScale: { axisPressedMouseMove: false },
      });
      candles.current = c.addSeries(lc.CandlestickSeries, {
        upColor: up,
        downColor: down,
        wickUpColor: up,
        wickDownColor: down,
        borderVisible: false,
        priceFormat: { type: "custom", formatter: (p: number) => formatPrice(p), minMove: 1e-12 },
        priceLineColor: "rgba(244,183,40,0.6)",
      });
      volume.current = c.addSeries(lc.HistogramSeries, {
        priceScaleId: "",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      volume.current.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      marks.current = lc.createSeriesMarkers(candles.current, []);
      chart.current = c;
      setReadyTick((t) => t + 1);
    });
    return () => {
      disposed = true;
      chart.current?.remove();
      chart.current = null;
      candles.current = null;
      volume.current = null;
      marks.current = null;
    };
  }, []);

  // Own trades as markers, snapped to the bar they fell into.
  useEffect(() => {
    if (!marks.current) return;
    if (!showMarkers || (state !== "ready" && state !== "empty")) {
      marks.current.setMarkers([]);
      return;
    }
    const step = TF_SEC[tf];
    const { up, down } = colors.current;
    // One marker per bar and side (several fills in one candle read "×3"), and only the latest buy and the
    // latest sell carry a text label: labels on neighbouring bars overprint each other at 5m and wider.
    const groups = new Map<string, { time: number; buy: boolean; n: number; via?: Fill["via"] }>();
    for (const f of markers) {
      if (f.kind === "withdraw_token") continue;
      const buy = f.kind !== "sell";
      const time = Math.floor(f.ts / 1000 / step) * step;
      const k = `${time}:${buy ? "b" : "s"}`;
      const g = groups.get(k);
      if (g) {
        g.n += 1;
        g.via = g.via ?? f.via;
      } else groups.set(k, { time, buy, n: 1, via: f.via });
    }
    const sorted = [...groups.values()].sort((a, b) => a.time - b.time);
    const lastBuy = sorted.findLast((g) => g.buy);
    const lastSell = sorted.findLast((g) => !g.buy);
    const list: SeriesMarker<Time>[] = sorted.map((g) => {
      const label = g.via ? `${ORDER_LABEL[g.via]} filled` : g.buy ? "You bought" : "You sold";
      const labelled = g === lastBuy || g === lastSell;
      return {
        time: g.time as UTCTimestamp,
        position: g.buy ? "belowBar" : "aboveBar",
        shape: g.buy ? "arrowUp" : "arrowDown",
        color: g.buy ? up : down,
        // A fill of one of your private orders reads as such (still local only, behind Peek).
        text: labelled ? `${label}${g.n > 1 ? ` ×${g.n}` : ""}` : g.n > 1 ? `×${g.n}` : "",
        size: 0.8,
      } satisfies SeriesMarker<Time>;
    });
    marks.current.setMarkers(list);
  }, [markers, showMarkers, tf, state, readyTick]);

  // Trigger lines of open orders.
  useEffect(() => {
    const series = candles.current;
    if (!series || !showMarkers) return;
    const lines: IPriceLine[] = triggers
      .filter((t) => t.price > 0)
      .map((t) => series.createPriceLine({ price: t.price, color: "rgba(244,183,40,0.55)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: t.label }));
    return () => lines.forEach((l) => series.removePriceLine(l));
  }, [triggers, showMarkers, readyTick]);

  // History for the selected timeframe.
  useEffect(() => {
    if (!chart.current) return;
    let alive = true;
    setState("loading");
    api
      .getCandles(mint, { tf })
      .then((list) => {
        if (!alive || !candles.current || !volume.current) return;
        const bars = list.map(toBar);
        const { up, down } = colors.current;
        candles.current.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
        volume.current.setData(bars.map((b) => volumeBar(b, up, down)));
        last.current = bars.at(-1) ?? null;
        applied.current = new Set();
        chart.current?.timeScale().fitContent();
        setLoadedAt(Date.now());
        setState(bars.length ? "ready" : "empty");
      })
      .catch((e: unknown) => alive && setState({ error: errorText(e) }));
    return () => {
      alive = false;
    };
  }, [mint, tf, network, readyTick]);

  // Live: fold new trades into the current bar (or open the next one).
  useEffect(() => {
    if (state !== "ready" && state !== "empty") return;
    const step = TF_SEC[tf];
    for (const e of [...trades].reverse()) {
      if (applied.current.has(e.id) || e.kind === "create") continue;
      const cut = last.current ? last.current.time : 0;
      const t = Math.floor(e.ts / 1000 / step) * step;
      if (t < cut) continue; // already in the history bars
      applied.current.add(e.id);
      const tokens = unitsToNumber(e.tokenAmount, e.decimals);
      const sol = lamportsToSol(e.solAmount);
      if (!(tokens > 0) || !(sol > 0)) continue;
      const price = sol / tokens;
      const prev = last.current;
      const bar: Bar =
        prev && prev.time === t
          ? { ...prev, high: Math.max(prev.high, price), low: Math.min(prev.low, price), close: price, volume: prev.volume + Number(e.solAmount) }
          : { time: t, open: prev?.close ?? price, high: Math.max(prev?.close ?? price, price), low: Math.min(prev?.close ?? price, price), close: price, volume: Number(e.solAmount) };
      last.current = bar;
      candles.current?.update({ time: bar.time as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close } satisfies CandlestickData);
      volume.current?.update(volumeBar(bar, colors.current.up, colors.current.down));
    }
  }, [trades, tf, state]);

  return (
    <section aria-labelledby="chart-title">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
        <h2 id="chart-title" className="text-sm font-medium">
          Price <span className="font-normal text-faint-foreground">· SOL</span>
        </h2>
        <div role="tablist" aria-label="Timeframe" onKeyDown={onTabListKeyDown} className="flex gap-0.5 rounded-full border border-border p-0.5">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tf === t}
              tabIndex={tf === t ? 0 : -1}
              onClick={() => setTf(t)}
              className={cn(
                "hit relative rounded-full px-2.5 py-1 font-mono text-[11px] transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                tf === t ? "text-foreground" : "text-faint-foreground hover:text-muted-foreground",
              )}
            >
              {tf === t && (
                <motion.span layoutId="chart-tf" className="absolute inset-0 rounded-full bg-surface-3" transition={{ type: "spring", bounce: 0, duration: 0.25 }} />
              )}
              <span className="relative">{t}</span>
            </button>
          ))}
        </div>
      </header>
      <div className="relative h-64 sm:h-80">
        <div ref={box} className="absolute inset-0" aria-label={`Candlestick chart, ${tf} bars`} role="img" />
        {state === "loading" && <Skeleton className="absolute inset-3 rounded-xl bg-skeleton" />}
        {state === "empty" && !trades.some((e) => e.kind !== "create" && e.ts >= loadedAt) && (
          <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">No trades in this range yet.</p>
        )}
        {typeof state === "object" && (
          <p role="alert" className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-muted-foreground">
            {state.error}
          </p>
        )}
      </div>
      <p className="border-t border-border/60 px-4 py-2 text-[11px] text-faint-foreground">Chart: TradingView Lightweight Charts™</p>
    </section>
  );
}

function volumeBar(b: Bar, up: string, down: string): HistogramData {
  return { time: b.time as UTCTimestamp, value: b.volume / 1e9, color: (b.close >= b.open ? up : down) + "40" };
}
