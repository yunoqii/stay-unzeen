"use client";

import { onTabListKeyDown } from "@/lib/tabs";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import type { CandlestickData, IChartApi, IPriceLine, ISeriesApi, ISeriesMarkersPluginApi, HistogramData, SeriesMarker, Time, UTCTimestamp, WhitespaceData, AutoscaleInfo } from "lightweight-charts";
import { api, errorText } from "@/lib/api/client";
import type { Candle, CandleTimeframe, FeedEvent } from "@/lib/api/types";
import type { Fill } from "@/lib/pnl";
import { formatPrice, lamportsToSol, unitsToNumber } from "@/lib/format";
import { ORDER_LABEL } from "@/lib/orders";
import { useNetwork } from "@/lib/network";
import { eventQuote } from "@/lib/quotes";
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
  volume: number; // whole units of the axis currency (SOL, or the pair's quote)
}

const hourLabel = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
const dayLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const fullTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

const ZEC = "#F4B728";

/**
 * Bars of a token we have no trades for are the pool's per-minute price samples: every bar has volume 0
 * (and mostly o = h = l = c). Drawn as candles they read as a row of dashes, so a series that is mostly
 * samples is drawn as a price line instead. Real trades always carry volume.
 */
const SAMPLED_SHARE = 0.8;
function isSampled(bars: readonly Bar[]) {
  if (!bars.length) return false;
  return bars.filter((b) => !(b.volume > 0)).length / bars.length >= SAMPLED_SHARE;
}

type Mode = "candles" | "line";

/** v0.17: `volume` is a base-unit string (no i64 limit): lamports, or the pair quote's base units with quote=1. */
const toBar = (c: Candle, decimals: number, k = 1): Bar => ({
  time: c.time,
  open: Number(c.open) * k,
  high: Number(c.high) * k,
  low: Number(c.low) * k,
  close: Number(c.close) * k,
  volume: /^\d+$/.test(String(c.volume)) ? unitsToNumber(String(c.volume), decimals) * k : 0,
});

/**
 * Unit of the price axis. SOL by default; a non-SOL pair can be drawn in its own quote (v0.17: the server
 * returns those bars natively with `quote=1`, nothing is converted at today's price), live trades priced from
 * their own quote amount.
 */
export interface ChartDenom {
  unit: string;
  /** Set for a pair drawn in its own quote: decimals of that quote (volume base units -> whole units). */
  pairDecimals?: number;
  /**
   * SOL bars shown in another display unit (ZEC by default): display units per SOL at the public reference
   * rate. Applied to history, live trades and trigger lines alike, with the rate taken when the bars loaded.
   */
  solScale?: number;
}

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
  onMoveTrigger,
  showMarkers = false,
  denom = { unit: "SOL" },
  denomSwitch,
}: {
  mint: string;
  denom?: ChartDenom;
  /** Optional control rendered in the header (price unit switch of non-SOL pairs). */
  denomSwitch?: React.ReactNode;
  trades: FeedEvent[];
  markers?: readonly Fill[];
  /** v0.8: your open orders' trigger prices, drawn as dashed lines (local only, behind Peek like markers). */
  triggers?: readonly { id: string; price: number; label: string; tone?: "buy" | "sell" | "neutral"; draggable?: boolean }[];
  /** Drag-to-move of an order line ended at `priceSol` (SOL per whole token); the page confirms and replaces it. */
  onMoveTrigger?: (id: string, priceSol: number) => void;
  showMarkers?: boolean;
}) {
  const [tf, setTf] = useState<CandleTimeframe>("5m");
  const [state, setState] = useState<"loading" | "ready" | "empty" | { error: string }>("loading");
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const area = useRef<ISeriesApi<"Area"> | null>(null);
  const [mode, setMode] = useState<Mode>("candles");
  const modeRef = useRef<Mode>("candles");
  const [points, setPoints] = useState(0);
  const marks = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const last = useRef<Bar | null>(null);
  const applied = useRef<Set<string>>(new Set());
  const network = useNetwork();
  const colors = useRef({ up: "#4fc98a", down: "#ef6b73" });
  const [readyTick, setReadyTick] = useState(0);
  const pair = denom.unit !== "SOL" && denom.pairDecimals !== undefined;
  const solScale = pair ? 1 : (denom.solScale ?? 1);
  // Latest scale for the next load; `loadedScale` is the one the bars on screen were drawn with.
  const scaleRef = useRef(solScale);
  useEffect(() => {
    scaleRef.current = solScale;
  }, [solScale]);
  const [loadedScale, setLoadedScale] = useState(solScale);
  const loadedScaleRef = useRef(loadedScale);
  useEffect(() => {
    loadedScaleRef.current = loadedScale;
  }, [loadedScale]);
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
      // Price line of sampled-only series (see isSampled); hidden while real candles are shown.
      area.current = c.addSeries(lc.AreaSeries, {
        lineColor: ZEC,
        lineWidth: 2,
        // Straight segments: a curved line overshoots between samples and draws prices that never were.
        lineType: lc.LineType.Simple,
        topColor: "rgba(244,183,40,0.22)",
        bottomColor: "rgba(244,183,40,0)",
        priceFormat: { type: "custom", formatter: (p: number) => formatPrice(p), minMove: 1e-12 },
        priceLineColor: "rgba(244,183,40,0.6)",
        crosshairMarkerBorderColor: ZEC,
        crosshairMarkerBackgroundColor: "#0b0b0d",
        visible: false,
        // A flat run of samples would collapse the axis to one repeated label: keep at least ±5% around it.
        autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => {
          const a = base();
          if (!a?.priceRange) return a;
          const { minValue, maxValue } = a.priceRange;
          const mid = (minValue + maxValue) / 2;
          const half = Math.abs(mid) * 0.05;
          return maxValue - minValue >= half * 2 ? a : { ...a, priceRange: { minValue: mid - half, maxValue: mid + half } };
        },
      });
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
      area.current = null;
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

  // Trigger lines of open orders: limit / TP / SL in their own colours; draggable ones move on the chart.
  const lineRefs = useRef<Map<string, { line: IPriceLine; price: number; draggable: boolean }>>(new Map());
  useEffect(() => {
    const series = candles.current;
    if (!series || !showMarkers) return;
    const tone = (t: (typeof triggers)[number]) => (t.tone === "buy" ? colors.current.up : t.tone === "sell" ? colors.current.down : "#F4B728");
    const map = new Map<string, { line: IPriceLine; price: number; draggable: boolean }>();
    for (const t of triggers) {
      if (!(t.price > 0)) continue;
      const price = t.price * loadedScale;
      const line = series.createPriceLine({ price, color: tone(t) + "b0", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: t.draggable && !pair ? `${t.label} ⇅` : t.label });
      map.set(t.id, { line, price, draggable: !!t.draggable && !pair });
    }
    lineRefs.current = map;
    // On unmount the chart is removed first (effect above): its series are disposed by then.
    return () => {
      if (chart.current) map.forEach((l) => series.removePriceLine(l.line));
      lineRefs.current = new Map();
    };
  }, [triggers, showMarkers, readyTick, loadedScale, pair]);

  // Dragging a line: grab within 6 px, the chart stops panning while it moves, the drop is reported in SOL.
  const moveRef = useRef(onMoveTrigger);
  useEffect(() => {
    moveRef.current = onMoveTrigger;
  });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let drag: { id: string; startY: number; price: number } | null = null;
    const yOf = (e: PointerEvent) => e.clientY - el.getBoundingClientRect().top;
    const hit = (y: number) => {
      const series = candles.current;
      if (!series) return null;
      for (const [id, l] of lineRefs.current) {
        if (!l.draggable) continue;
        const ly = series.priceToCoordinate(l.price);
        if (ly !== null && Math.abs(ly - y) <= 6) return id;
      }
      return null;
    };
    const down = (e: PointerEvent) => {
      if (!moveRef.current || e.button !== 0) return;
      const id = hit(yOf(e));
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      drag = { id, startY: yOf(e), price: lineRefs.current.get(id)!.price };
      chart.current?.applyOptions({ handleScroll: false, handleScale: false });
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      const y = yOf(e);
      if (!drag) {
        el.style.cursor = moveRef.current && hit(y) ? "ns-resize" : "";
        return;
      }
      const p = candles.current?.coordinateToPrice(y);
      if (p === null || p === undefined || !(Number(p) > 0)) return;
      drag.price = Number(p);
      lineRefs.current.get(drag.id)?.line.applyOptions({ price: drag.price });
    };
    const up = (e: PointerEvent) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      chart.current?.applyOptions({ handleScroll: true, handleScale: true });
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      const l = lineRefs.current.get(d.id);
      if (Math.abs(yOf(e) - d.startY) < 3 || !l) return;
      // Snap back until the page confirms; a confirmed move redraws from the new order.
      l.line.applyOptions({ price: l.price });
      moveRef.current?.(d.id, d.price / loadedScaleRef.current);
    };
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, []);

  /**
   * Line mode: the candlestick series stays (markers, order lines and drag hang off it) but goes invisible and
   * flat at the close, the area draws the price, no volume pane, and the scale hugs the data. With one or two
   * samples the last price runs across the chart as a line instead of a lone dot.
   */
  function applyMode(m: Mode, n: number) {
    const line = m === "line";
    const { up, down } = colors.current;
    const clear = "rgba(0,0,0,0)";
    candles.current?.applyOptions({
      upColor: line ? clear : up,
      downColor: line ? clear : down,
      wickUpColor: line ? clear : up,
      wickDownColor: line ? clear : down,
      lastValueVisible: !line,
      priceLineVisible: !line,
    });
    area.current?.applyOptions({
      visible: line,
      // One or two samples: no filled block, the price line carries it across the chart.
      topColor: n <= 2 ? "rgba(244,183,40,0)" : "rgba(244,183,40,0.22)",
      lineVisible: n > 2, priceLineVisible: line, priceLineStyle: n <= 2 ? 0 : 2, priceLineWidth: n <= 2 ? 2 : 1, priceLineColor: n <= 2 ? ZEC : "rgba(244,183,40,0.6)" });
    volume.current?.applyOptions({ visible: !line });
    chart.current?.priceScale("right").applyOptions({ scaleMargins: line ? { top: 0.18, bottom: 0.14 } : { top: 0.12, bottom: 0.24 } });
  }

  // History for the selected timeframe.
  useEffect(() => {
    if (!chart.current) return;
    let alive = true;
    setState("loading");
    api
      .getCandles(mint, { tf, ...(pair ? { quote: 1 as const } : {}) })
      .then((list) => {
        if (!alive || !candles.current || !volume.current || !area.current) return;
        const k = scaleRef.current;
        const bars = list.map((c) => toBar(c, pair ? denom.pairDecimals! : 9, k));
        setLoadedScale(k);
        const m: Mode = isSampled(bars) ? "line" : "candles";
        modeRef.current = m;
        setMode(m);
        setPoints(bars.length);
        applyMode(m, bars.length);
        candles.current.setData(bars.map((b) => candleOf(b, m)));
        volume.current.setData(m === "line" ? [] : bars.map((b) => volumeBar(b, colors.current.up, colors.current.down)));
        area.current.setData(m === "line" ? bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.close })) : []);
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
  }, [mint, tf, network, readyTick, denom.unit, pair, denom.pairDecimals]);
  // A unit switch reloads above; a rate tick alone does not (the axis would jump every minute).

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
      // Pair view: only trades with a known quote amount (the server's quote=1 bars count the same ones).
      const q = pair ? eventQuote(e) : null;
      const paid = pair ? (q && q.quote === denom.unit ? q.amount : 0) : lamportsToSol(e.solAmount) * loadedScale;
      if (!(tokens > 0) || !(paid > 0)) continue;
      const price = paid / tokens;
      const prev = last.current;
      const bar: Bar =
        prev && prev.time === t
          ? { ...prev, high: Math.max(prev.high, price), low: Math.min(prev.low, price), close: price, volume: prev.volume + paid }
          : { time: t, open: prev?.close ?? price, high: Math.max(prev?.close ?? price, price), low: Math.min(prev?.close ?? price, price), close: price, volume: paid };
      last.current = bar;
      candles.current?.update(candleOf(bar, modeRef.current));
      if (modeRef.current === "line") area.current?.update({ time: bar.time as UTCTimestamp, value: bar.close });
      else volume.current?.update(volumeBar(bar, colors.current.up, colors.current.down));
    }
  }, [trades, tf, state, denom.unit, pair, loadedScale]);

  return (
    <section aria-labelledby="chart-title">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h2 id="chart-title" className="text-sm font-medium">
            Price <span className="font-normal text-faint-foreground">· {denom.unit}</span>
          </h2>
          {denomSwitch}
        </div>
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
        <div ref={box} className="absolute inset-0" aria-label={mode === "line" ? `Price line, ${tf} pool samples` : `Candlestick chart, ${tf} bars`} role="img" />
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
      <p className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/60 px-4 py-2 text-[11px] text-pretty text-faint-foreground">
        {mode === "line" && state === "ready" ? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden className="h-0.5 w-3 rounded-full bg-zec/80" />
            {points <= 2 ? "Latest price from pool reserves. History fills in each minute." : "Price from pool reserves, sampled each minute. No trades indexed in this range."}
          </span>
        ) : (
          <span />
        )}
        <span>Chart: TradingView Lightweight Charts™</span>
      </p>
    </section>
  );
}

/** Zero-volume bars (price samples between trades) draw nothing: whitespace keeps the time slot. */
function volumeBar(b: Bar, up: string, down: string): HistogramData | WhitespaceData {
  if (!(b.volume > 0)) return { time: b.time as UTCTimestamp };
  return { time: b.time as UTCTimestamp, value: b.volume, color: (b.close >= b.open ? up : down) + "40" };
}

/** Line mode keeps the (invisible) candle flat at the close so wicks of stray trades don't stretch the scale. */
function candleOf(b: Bar, m: Mode): CandlestickData {
  const t = b.time as UTCTimestamp;
  return m === "line" ? { time: t, open: b.close, high: b.close, low: b.close, close: b.close } : { time: t, open: b.open, high: b.high, low: b.low, close: b.close };
}
