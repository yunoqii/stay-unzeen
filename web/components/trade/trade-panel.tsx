"use client";

import { onTabListKeyDown } from "@/lib/tabs";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { hotkeyIntent, isTyping, onIntent, peekIntent, requestTrade, SELL_SLOTS, takeIntent } from "@/lib/trade-intent";
import { HotkeysSheet } from "@/components/trading/hotkeys-sheet";
import { quoteAgeMin, useJupiterQuote } from "@/lib/jupiter-quote";
import { AnimatePresence, motion } from "motion/react";
import { CaretDown, Info, Key, LockKey, ShieldCheck, SlidersHorizontal } from "@phosphor-icons/react";
import { ApiError } from "@/lib/api/client";
import type { SignedAction, Token, Venue } from "@/lib/api/types";
import { lastRate, submitAction, useAction, useActivityVersion } from "@/lib/activity";
import { useKeyState } from "@/lib/crypto/session";
import { formatCompact, formatSol, formatUnits, formatZec, parseUnits, unitsToNumber, VENUE_LABEL, ZEC_DECIMALS } from "@/lib/format";
import { NETWORK_CONFIG, nativeOf, useNetwork } from "@/lib/network";
import { nowFee as poolNowFee, resolveExec, useDefaultExec, withExec, type ExecMode, type NowFee } from "@/lib/exec";
import { curveBuyPartial, curveFor, isPriceStale, lamportsToZat, lamportsToZatCeil, withSlippage, quoteBuy, quoteRate, saleBelowMinimum, quoteBuyZecPair, quoteSell, quoteSellZecPair, sellMirrorsBuy } from "@/lib/trade";
import { useRecentBuys } from "@/hooks/use-recent-buys";
import { useNow } from "@/hooks/use-now";
import { usePriceTs } from "@/hooks/use-price-ts";
import { formatQuote, QUOTE_DECIMALS, quoteAsset, quotePerSol, tokenQuote, zecSpreadBps } from "@/lib/quotes";
import type { Quote as Pair } from "@/lib/api/types";
import { isSlippageBps, MAX_SLIPPAGE_BPS, SELL_PRESETS, SLIPPAGE_CHOICES_BPS, updateTradeSettings, useTradeSettings } from "@/lib/trade-settings";
import { cn } from "@/lib/utils";
import { usePool } from "@/hooks/use-pool";
import { usePortfolio } from "@/hooks/use-portfolio";
import { useTokens } from "@/hooks/use-tokens";
import { orderSupport } from "@/lib/orders";
import { OrdersPanel, OrdersUnavailable } from "./orders-panel";
import { Button } from "@/components/ui/button";
import { CoinIcon } from "@/components/icons/coin";
import { ActionStatusCard } from "./action-status";
import { ExecSwitch } from "./exec-switch";
import { Chip, ErrorNote } from "./parts";

type Side = "buy" | "sell";
/** Automatic retries after 503 stale_price before the error is shown. */
const STALE_TRIES = 3;
type Tab = Side | "orders";
const TAB_LABEL: Record<Tab, string> = { buy: "Buy", sell: "Sell", orders: "Orders" };

export function TradePanel({ token, priceSol, priceQuote }: { token: Token; priceSol: string; priceQuote?: string }) {
  const key = useKeyState();
  const [side, setSide] = useState<Tab>("buy");
  const [help, setHelp] = useState(false);
  const network = useNetwork();
  const instant = useTradeSettings(network).oneTap;
  // Hotkeys (B / S / 1–4 / Esc / ?) and intents from the position panel: the side switches here, the form
  // of that side applies the rest once it is mounted.
  const sideRef = useRef(side);
  useEffect(() => {
    sideRef.current = side;
  });
  useEffect(() => {
    const off = onIntent(() => {
      const i = peekIntent(token.mint);
      if (i && i.side !== sideRef.current) setSide(i.side);
    });
    const keydown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isTyping(e.target)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const i = hotkeyIntent(e.key, token.mint, sideRef.current);
      if (!i) return;
      e.preventDefault();
      if (i === "help") setHelp(true);
      else requestTrade(i);
    };
    window.addEventListener("keydown", keydown);
    return () => {
      off();
      window.removeEventListener("keydown", keydown);
    };
  }, [token.mint]);
  const tabsId = useId();
  const { pool } = usePool();
  // Public list, same for every visitor: "has the pool traded this mint" decides whether orders apply.
  const { tokens } = useTokens(undefined, 60_000);
  const support = orderSupport(token, pool, tokens);

  return (
    <section aria-labelledby={`${tabsId}-title`} className="p-4 sm:p-5">
      <h2 id={`${tabsId}-title`} className="sr-only">
        Trade ${token.symbol}
      </h2>
      <div role="tablist" aria-label="Side" onKeyDown={(e) => onTabListKeyDown(e, true)} className="grid grid-cols-3 gap-1 rounded-full border border-border p-1">
        {(["buy", "sell", "orders"] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={side === s}
            tabIndex={side === s ? 0 : -1}
            // Orders stay reachable when unsupported: the panel explains why instead of a dead tab.
            aria-disabled={s === "orders" && !support.ok ? true : undefined}
            title={s === "orders" && !support.ok ? support.reason : undefined}
            onClick={() => setSide(s)}
            className={cn(
              "relative rounded-full py-2 text-sm font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              side === s ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              s === "orders" && !support.ok && "text-faint-foreground hover:text-muted-foreground",
            )}
          >
            {side === s && (
              <motion.span layoutId={`${tabsId}-side`} className="absolute inset-0 rounded-full bg-surface-3" transition={{ type: "spring", bounce: 0, duration: 0.3 }} />
            )}
            <span className="relative">{TAB_LABEL[s]}</span>
          </button>
        ))}
      </div>

      {side === "orders" && !support.ok ? (
        <OrdersUnavailable reason={support.reason} />
      ) : key.status === "loading" ? (
        <div className="h-64" aria-busy />
      ) : key.status !== "unlocked" ? (
        <KeyPrompt mint={token.mint} locked={key.status === "locked"} />
      ) : side === "orders" && support.ok ? (
        <OrdersPanel key={key.pubkey} token={token} priceSol={priceSol} support={support} />
      ) : side !== "orders" ? (
        <OrderForm key={`${side}:${key.pubkey}`} side={side} token={token} priceSol={priceSol} priceQuote={priceQuote} />
      ) : null}
      <p className="mt-3 hidden text-center text-[11px] text-faint-foreground lg:block">
        <button type="button" onClick={() => setHelp(true)} className="underline-offset-4 hover:text-muted-foreground hover:underline">
          Keyboard: B, S, 1–4, Esc · press ? for all
        </button>
      </p>
      <HotkeysSheet open={help} onClose={() => setHelp(false)} instant={instant} />
    </section>
  );
}

export function KeyPrompt({ mint, locked }: { mint: string; locked: boolean }) {
  const href = `/key?next=${encodeURIComponent(`/token/${mint}`)}`;
  return (
    <div className="mt-6 flex flex-col items-center px-2 pb-2 text-center">
      {locked ? <LockKey size={26} weight="thin" className="text-muted-foreground" /> : <Key size={26} weight="thin" className="text-muted-foreground" />}
      <p className="mt-3 text-sm font-medium">{locked ? "Unlock your anon key to trade" : "Trade from a private balance"}</p>
      <p className="mt-1 max-w-xs text-sm text-pretty text-muted-foreground">
        {locked
          ? "Your balance belongs to the key in this browser. Unlock it and come straight back."
          : "Create a 12-word anon key, top up once with shielded ZEC, then buy and sell in a tap. No wallet, no QR per trade."}
      </p>
      <Button asChild className="mt-5 h-10 rounded-full px-5">
        <Link href={href}>{locked ? "Unlock key" : "Set up anon key"}</Link>
      </Button>
    </div>
  );
}

function OrderForm({ side, token, priceSol, priceQuote }: { side: Side; token: Token; priceSol: string; priceQuote?: string }) {
  const network = useNetwork();
  const { portfolio } = usePortfolio();
  const { pool } = usePool();
  useActivityVersion(); // re-render when a new rate arrives
  const [amount, setAmount] = useState("");
  const settings = useTradeSettings(network);
  const slippage = settings.slippageBps;
  const setSlippage = (bps: number) => updateTradeSettings(network, { slippageBps: bps });
  const profileExec = useDefaultExec(network);
  const [execOverride, setExecOverride] = useState<ExecMode | null>(null);
  const exec = resolveExec(profileExec, execOverride);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = useAction(activeId);
  const ids = useId();

  const isBuy = side === "buy";
  const decimals = isBuy ? ZEC_DECIMALS : token.decimals;
  const unit = isBuy ? "ZEC" : `$${token.symbol}`;
  const graduated = token.status === "graduated";
  // v0.13: Jupiter routes SOL / USDC / USD1 pairs after graduation, never ZEC pairs (400).
  const venue: Venue = graduated && token.venue !== "jupiter" && tokenQuote(token) !== "ZEC" ? "jupiter" : token.venue;
  // Without a rate from an earlier order in this tab the quote uses the pool's published one (PoolInfo.rate,
  // docs/API.md D10), on every chain: otherwise the first trade after a reload was signed with minOut 0, i.e. no
  // price limit at all (found on the live devnet run). On hood a zero limit is even refused (v0.22: 400).
  const hood = NETWORK_CONFIG[network].chain === "hood";
  const rate = quoteRate(lastRate(network, side), pool, side);
  // v0.22: 503 stale_price -> the button waits for Retry-After, then the same amount is re-quoted and re-signed.
  const [stale, setStale] = useState<{ left: number; value: string; tries: number } | null>(null);
  // v0.23: block before sending when the pool's price is missing or older than priceMaxAgeSecs − 20 s.
  const now = useNow(5000);
  const priceTs = usePriceTs(token.mint, token.priceTs, hood);
  const priceOld = hood && now !== null && isPriceStale(priceTs, pool?.chain?.priceMaxAgeSecs, now);
  // v0.13: the pair. ZEC pairs run at 1:1 parity with the pool's spread (no SOL rate); USDC / USD1 pairs use the
  // ZEC/SOL rate like SOL pairs, against the token's SOL-equivalent price.
  const pair = tokenQuote(token);
  const zecPair = pair === "ZEC";
  const spread = zecSpreadBps(pool);
  const pairDecimals = quoteAsset(pool, pair, token.venue)?.decimals ?? QUOTE_DECIMALS[pair];
  // v0.26: a SOL-paired token still on a curve the pool publishes (PoolInfo.venues[].curve, pump.fun today) is
  // quoted on that curve, impact and venue fee included, like the pool's own checks; anything else: spot.
  const curve = !hood && venue === token.venue && token.status === "curve" && pair === "SOL" ? curveFor(token, pool, venue) : null;

  const zecBalance = portfolio ? BigInt(portfolio.zecBalance) : null;
  const own = portfolio?.holdings.find((h) => h.mint === token.mint);
  const holding = portfolio ? BigInt(own?.amount ?? "0") : null;
  const available = isBuy ? zecBalance : holding;
  const minAction = pool ? BigInt(pool.minActionZat) : null;
  // v0.17 (A6): a sell sized like a recent buy, their sum or the whole position is shaved 0.5–2 % and rounded.
  const position = own ? BigInt(own.amount) + BigInt(own.held) : null;
  const buys = useRecentBuys(token.mint);

  /** Parse and quote an amount string: the form and one-tap presets use the same checks. */
  const evaluate = (value: string) => {
    let parsed: bigint | null = null;
    let inputError: string | null = null;
    if (value.trim() !== "") {
      try {
        parsed = BigInt(parseUnits(value, decimals));
        if (parsed === BigInt(0)) inputError = "Enter an amount above zero.";
      } catch {
        inputError = `Use a number with up to ${decimals} decimals.`;
      }
    }
    if (parsed !== null && !inputError) {
      if (available !== null && parsed > available)
        inputError = isBuy ? "More than your ZEC balance." : `You hold ${formatCompact(unitsToNumber(available.toString(), decimals))} ${unit}.`;
      else if (isBuy && minAction !== null && parsed < minAction) inputError = `The pool minimum is ${formatZec(minAction.toString())} ZEC.`;
    }
    const quote =
      parsed === null || inputError
        ? null
        : zecPair
          ? spread === null
            ? null
            : isBuy
              ? quoteBuyZecPair(parsed, spread, priceQuote, token.decimals, pairDecimals, slippage)
              : quoteSellZecPair(parsed, spread, priceQuote, token.decimals, pairDecimals, slippage)
          : isBuy
            ? quoteBuy(parsed, rate, priceSol, token.decimals, slippage, curve)
            : quoteSell(parsed, rate, priceSol, token.decimals, slippage, curve);
    // A sale worth less than the pool minimum at the current price is refused (422 below_minimum): say so first.
    if (!isBuy && !inputError && quote && "zecOut" in quote && saleBelowMinimum(quote.zecOut, minAction) && minAction !== null)
      inputError = `Worth about ${formatZec(quote.zecOut.toString())} ZEC, under the pool minimum of ${formatZec(minAction.toString())} ZEC for a sale. Sell more of it.`;
    return { parsed, inputError, quote };
  };
  /** v0.28: the buy would run past the end of the curve (or the DBC segment): only part of it fills. */
  const partialFill = (q: ReturnType<typeof evaluate>["quote"]) => isBuy && !!q && "lamports" in q && curveBuyPartial(curve, q.lamports);
  const shown = evaluate(amount);
  // v0.28: graduated tokens through Jupiter get Jupiter's own impact (GET /api/quote, mainnet, features.quote),
  // asked once the amount settles; until it answers (or if it can't) the spot estimate stays.
  const routed = pool?.features?.quote === true && venue === "jupiter" && pair === "SOL";
  const routeAmount = !shown.quote ? null : isBuy ? ("lamports" in shown.quote ? shown.quote.lamports : null) : shown.parsed;
  const jq = useJupiterQuote(routed, token.mint, side, routeAmount);
  const applyRoute = (q: ReturnType<typeof evaluate>["quote"], parsedAmount: bigint | null): ReturnType<typeof evaluate>["quote"] => {
    if (!jq || jq.kind !== "ok" || !q || !routed) return q;
    if (isBuy && "tokensOut" in q && "lamports" in q && q.lamports === jq.amount) return { ...q, tokensOut: jq.out, minOut: withSlippage(jq.out, slippage) };
    if (!isBuy && "zecOut" in q && "lamports" in q && parsedAmount === jq.amount && rate) {
      const zecOut = lamportsToZat(jq.out, BigInt(rate.lamportsPerZec));
      return { ...q, lamports: jq.out, zecOut, minZecOut: withSlippage(zecOut, slippage) };
    }
    return q;
  };
  const { parsed, inputError } = shown;
  const quote = applyRoute(shown.quote, shown.parsed);
  const mirrors = !isBuy && parsed !== null && !inputError ? sellMirrorsBuy(parsed, buys, position) : null;

  const frozen = portfolio?.frozen ?? false;
  /** Hood: no quote or a zero limit means no fresh price to sign against; never send 0. */
  const limitOf = (q: typeof quote) => (q === null ? BigInt(0) : "minOut" in q ? q.minOut : q.minZecOut);
  const noPrice = hood && parsed !== null && !inputError && limitOf(quote) === BigInt(0);
  const waiting = stale !== null || noPrice || priceOld;
  const canSubmit = !busy && !waiting && parsed !== null && !inputError && !frozen && portfolio !== null;

  const setPreset = (v: string) => {
    setError(null);
    setAmount(v);
    if (settings.oneTap) void submit(v);
  };
  const setPercent = (pct: number) => {
    if (holding === null) return;
    setError(null);
    const v = formatUnits(((holding * BigInt(pct)) / BigInt(100)).toString(), token.decimals);
    setAmount(v);
    if (settings.oneTap) void submit(v);
  };

  const submit = async (value: string = amount, tries = 0) => {
    const fresh = evaluate(value);
    const { parsed, inputError } = fresh;
    const quote = applyRoute(fresh.quote, fresh.parsed);
    // Invalid input stays in the field with its hint; nothing is signed.
    if (busy || parsed === null || inputError || frozen || portfolio === null) return;
    if (hood && limitOf(quote) === BigInt(0)) return; // "Price updating…": the server would answer 400
    if (priceOld) {
      // An automatic retry that meets a still-old price waits another round instead of sending a sure 503.
      if (tries > 0) setStale({ left: 10, value, tries });
      return;
    }
    setBusy(true);
    setError(null);
    const action: SignedAction = withExec(
      isBuy
        ? { op: "buy", venue, mint: token.mint, zecIn: parsed.toString(), minOut: (quote && "minOut" in quote ? quote.minOut : BigInt(0)).toString() }
        : { op: "sell", venue, mint: token.mint, amount: parsed.toString(), minZecOut: (quote && "minZecOut" in quote ? quote.minZecOut : BigInt(0)).toString() },
      exec,
    );
    try {
      const it = await submitAction(network, action, {
        op: side,
        mint: token.mint,
        symbol: token.symbol,
        decimals: token.decimals,
        amount: parsed.toString(),
      });
      setActiveId(it.id);
      setAmount("");
      setExecOverride(null); // the override was for this order only
    } catch (e) {
      if (e instanceof ApiError && e.code === "stale_price" && tries < STALE_TRIES) {
        // Nothing was held. Keep the amount and try again after Retry-After with a fresh quote.
        setAmount(value);
        setStale({ left: e.retryAfter ?? 60, value, tries: tries + 1 });
      } else setError(e instanceof ApiError ? e : new ApiError("internal", String(e)));
    } finally {
      setBusy(false);
    }
  };

  // Countdown of the stale-price wait, then one automatic retry of the same amount (re-quoted, re-signed).
  const submitRef = useRef(submit);
  // Intents (hotkeys, "Sell 50 %" on the position panel) for this side, applied once.
  const applyIntent = () => {
    const i = takeIntent(token.mint, side);
    if (!i) return;
    if (i.kind === "clear") {
      setError(null);
      setStale(null);
      setAmount("");
    } else if (i.kind === "percent") setPercent(i.pct);
    else if (i.kind === "slot") {
      if (isBuy) {
        if (i.slot <= 3) setPreset(settings.buyPresets[i.slot - 1]);
        // Max only fills the field, even with instant trade: a full-balance buy is always one more key.
        else if (zecBalance !== null && zecBalance > BigInt(0)) setAmount(formatUnits(zecBalance.toString(), ZEC_DECIMALS));
      } else setPercent(SELL_SLOTS[i.slot - 1]);
    }
  };
  const intentRef = useRef(applyIntent);
  useEffect(() => {
    intentRef.current = applyIntent;
  });
  useEffect(() => {
    intentRef.current();
    return onIntent(() => intentRef.current());
  }, []);
  useEffect(() => {
    submitRef.current = submit;
  });
  useEffect(() => {
    if (!stale) return;
    const t = setTimeout(() => {
      if (stale.left > 1) setStale({ ...stale, left: stale.left - 1 });
      else {
        setStale(null);
        void submitRef.current(stale.value, stale.tries);
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [stale]);
  const staleLeft = stale?.left ?? 0;
  const maxAge = pool?.chain?.priceMaxAgeSecs;

  return (
    <div className="mt-5 space-y-4">
      <AnimatePresence initial={false}>
        {active && (
          <motion.div
            key={active.id}
            initial={{ opacity: 0, y: 8, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          >
            <ActionStatusCard action={active} />
            <button type="button" onClick={() => setActiveId(null)} className="mt-2 w-full text-center text-xs text-faint-foreground hover:text-muted-foreground">
              Dismiss
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex items-baseline justify-between text-xs">
        <label htmlFor={`${ids}-amount`} className="text-muted-foreground">
          {isBuy ? "You pay" : "You sell"}
        </label>
        <span className="text-faint-foreground">
          {isBuy ? "Balance " : "Holding "}
          <span className="tabular text-muted-foreground">
            {available === null ? "…" : isBuy ? `${formatZec(available.toString())} ZEC` : `${formatCompact(unitsToNumber(available.toString(), decimals))} ${unit}`}
          </span>
        </span>
      </div>

      <div
        className={cn(
          "flex h-14 items-center rounded-2xl border bg-surface-1 px-4 transition-colors duration-150 focus-within:border-ring",
          inputError ? "border-destructive/60" : "border-border",
        )}
      >
        <input
          id={`${ids}-amount`}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0.00"
          value={amount}
          onChange={(e) => {
            setError(null);
            setStale(null); // a new amount cancels the pending retry
            setAmount(e.target.value.replace(",", "."));
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          aria-invalid={!!inputError}
          aria-describedby={`${ids}-hint`}
          className="tabular min-w-0 flex-1 bg-transparent text-2xl font-medium tracking-tight outline-none placeholder:text-faint-foreground"
        />
        <span className="ml-3 inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
          {isBuy && <CoinIcon symbol="ZEC" size={14} />}
          {unit}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {isBuy
          ? settings.buyPresets.map((v) => (
              <Chip key={v} onClick={() => setPreset(v)} active={amount === v} disabled={busy} aria-label={settings.oneTap ? `Buy ${v} ZEC now` : `${v} ZEC`}>
                {settings.oneTap ? `Buy ${v}` : v}
              </Chip>
            ))
          : SELL_PRESETS.map((p) => (
              <Chip key={p} onClick={() => setPercent(p)} disabled={!holding || busy} aria-label={settings.oneTap ? `Sell ${p}% now` : `${p}% of holding`}>
                {settings.oneTap ? `Sell ${p}%` : `${p}%`}
              </Chip>
            ))}
        {isBuy && !settings.oneTap && zecBalance !== null && zecBalance > BigInt(0) && (
          <Chip onClick={() => setPreset(formatUnits(zecBalance.toString(), ZEC_DECIMALS))}>Max</Chip>
        )}
      </div>
      {settings.oneTap && (
        <p className="-mt-2 text-[11px] text-faint-foreground">
          Instant trade is on: a preset signs the order right away.{" "}
          <Link href="/portfolio#settings" className="underline-offset-4 hover:text-muted-foreground hover:underline">
            Change
          </Link>
        </p>
      )}

      {routed && quote && (
        <p role="note" className="-mt-1 text-[11px] text-pretty text-faint-foreground">
          {jq?.kind === "ok"
            ? `Jupiter${jq.route.length ? ` (${jq.route.join(" → ")})` : ""}: price impact ${jq.impactPct.toFixed(2)} %, quote ${now === null ? "" : `${quoteAgeMin(jq.asOf, now)} min old`}. From the pool's background quotes, not asked for you.`
            : jq?.kind === "above"
              ? `Quote unavailable above ${isBuy ? `${formatSol(unitsToNumber(jq.maxAmount.toString(), nativeOf().decimals))} ${nativeOf().symbol}` : `${formatCompact(unitsToNumber(jq.maxAmount.toString(), token.decimals))} $${token.symbol}`}: showing the spot estimate. Mind your slippage.`
              : "Spot estimate until the pool's Jupiter quote arrives."}
        </p>
      )}
      {partialFill(quote) && (
        <p role="note" className="-mt-1 text-xs text-pretty text-zec">
          The curve ends before this amount: only part of it fills, the rest of the hold comes back.
        </p>
      )}

      {mirrors && parsed !== null && (
        <p role="note" className="-mt-1 text-xs text-pretty text-faint-foreground">
          <span className="tabular text-muted-foreground">
            ≈ {formatCompact(unitsToNumber(parsed.toString(), token.decimals))} {unit}
          </span>{" "}
          · Rounded so it doesn&apos;t mirror your buy. The pool sells a little less; the rest stays in your holding.
        </p>
      )}

      {(inputError || (isBuy && zecBalance === BigInt(0))) && (
        <p id={`${ids}-hint`} className={cn("text-xs", inputError ? "text-sell" : "text-faint-foreground")}>
          {inputError ?? "Your balance is empty. Top up with shielded ZEC first."}
        </p>
      )}

      <Quote
        side={side}
        token={token}
        quote={quote}
        hasAmount={parsed !== null && !inputError}
        rate={rate ? BigInt(rate.lamportsPerZec) : null}
        slippage={slippage}
        nowFee={exec === "now" ? { fee: poolNowFee(pool) } : null}
        pair={{ quote: pair, decimals: pairDecimals, perSol: quotePerSol({ priceSol, priceQuote }), spread }}
        rounded={!!mirrors}
      />

      <PanelSettings slippage={slippage} onSlippage={setSlippage} />

      <ExecSwitch value={exec} onChange={(m) => setExecOverride(m === profileExec ? null : m)} profileDefault={profileExec} />

      {graduated && venue === "jupiter" && (
        <p className="flex gap-2 text-xs text-muted-foreground">
          <Info size={14} weight="light" className="mt-px shrink-0" aria-hidden />
          This token left the {VENUE_LABEL[token.venue]} curve. The order routes through Jupiter.
        </p>
      )}

      {frozen && (
        <p role="alert" className="rounded-xl bg-zec-soft p-3 text-xs text-zec">
          Your balance is on hold while a deposit is reviewed. Trading resumes when the review ends.
        </p>
      )}

      <AnimatePresence initial={false}>
        {error && (
          <motion.div
            key="err"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: "hidden" }}
          >
            <ErrorNote error={error} minAction={minAction} pair={pair} />
          </motion.div>
        )}
      </AnimatePresence>

      {waiting && (
        <p role="status" aria-live="polite" className="flex gap-2 rounded-xl border border-border px-3 py-2.5 text-xs text-pretty text-muted-foreground">
          <Info size={14} weight="light" className="mt-px shrink-0" aria-hidden />
          <span>
            {stale && !priceOld ? (
              <>
                Price updating… The pool needs a fresh price for ${token.symbol} before it trades. Nothing was held. Retrying in{" "}
                <span className="tabular text-foreground">{staleLeft}s</span>.{" "}
                <button type="button" onClick={() => setStale(null)} className="underline-offset-4 hover:text-foreground hover:underline">
                  Cancel
                </button>
              </>
            ) : (
              <>
                Price updating… There is no fresh pool price for ${token.symbol} to set your limit against yet
                {maxAge ? ` (prices older than ${Math.round(maxAge / 60)} min aren't traded on)` : ""}. Buy and sell unlock by themselves when it arrives.
              </>
            )}
          </span>
        </p>
      )}

      <Button
        onClick={() => submit()}
        disabled={!canSubmit}
        aria-busy={busy}
        className={cn("h-12 w-full rounded-full text-[15px]", busy && "busy-hatch disabled:opacity-90")}
      >
        {busy ? "Signing…" : waiting ? "Price updating…" : `${isBuy ? "Buy" : "Sell"} $${token.symbol}`}
      </Button>
      <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-faint-foreground">
        <ShieldCheck size={12} weight="light" aria-hidden />
        Signed in this browser. On-chain it reads “unzeen”.
      </p>

    </div>
  );
}

type AnyQuote = ReturnType<typeof quoteBuy> | ReturnType<typeof quoteSell> | ReturnType<typeof quoteBuyZecPair> | ReturnType<typeof quoteSellZecPair>;

interface PairInfo {
  quote: Pair;
  decimals: number;
  /** Quote per SOL from the token's own prices (USDC / USD1 trade size), null when unknown. */
  perSol: number | null;
  /** ZEC parity spread, bps. */
  spread: number | null;
}

function Quote({
  side,
  token,
  quote,
  hasAmount,
  rate,
  slippage,
  nowFee,
  pair,
  rounded = false,
}: {
  side: Side;
  token: Token;
  quote: AnyQuote;
  hasAmount: boolean;
  rate: bigint | null;
  slippage: number;
  /** Shown when exec is "now"; fee null = the pool does not publish it yet. */
  nowFee: { fee: NowFee | null } | null;
  pair: PairInfo;
  /** v0.17 A6: the pool will shave and round this sell. */
  rounded?: boolean;
}) {
  const sym = `$${token.symbol}`;
  const zecPair = pair.quote === "ZEC";
  if (!hasAmount)
    return (
      <div className="flex items-center justify-between rounded-xl border border-dashed border-border px-3 py-3 text-sm text-faint-foreground">
        <span>{side === "buy" ? "You get" : "You receive"}</span>
        <span>—</span>
      </div>
    );
  if (!quote || (!zecPair && !rate))
    return (
      <div className="flex gap-2 rounded-xl border border-border px-3 py-3 text-xs text-pretty text-muted-foreground">
        <Info size={14} weight="light" className="mt-px shrink-0" aria-hidden />
        <span>
          {zecPair
            ? "No ZEC price for this pair yet, so this order has no price limit. It fills at the pool's 1:1 ZEC parity once a price exists."
            : !rate
              ? "No quote yet: the pool fixes the ZEC/SOL rate when it accepts your first order, so this one has no price limit. Later orders get a quote and your slippage limit."
              : "No price for this token yet, so this order has no price limit."}
        </span>
      </div>
    );
  // Trade size in the pair's own unit: ZEC SPL for ZEC pairs, the quote (with a small SOL equivalent) for USDC / USD1.
  const size = (lamports: bigint | null, quoteUnits: bigint | null): React.ReactNode => {
    if (quoteUnits !== null) return `≈ ${formatQuote(Number(quoteUnits) / 10 ** pair.decimals, pair.quote)} ${pair.quote}`;
    // v0.18: native base units (lamports, or wei on Robinhood Chain) through the exact string.
    const nat = nativeOf();
    const sol = unitsToNumber((lamports ?? BigInt(0)).toString(), nat.decimals);
    if (pair.quote === "SOL" || pair.perSol === null)
      return (
        <span key="size">
          ≈ {formatSol(sol)} <CoinIcon symbol={nat.symbol} size={11} /> {nat.symbol}
        </span>
      );
    return (
      <span key="size">
        ≈ {formatQuote(sol * pair.perSol, pair.quote)} {pair.quote}
        <span className="text-faint-foreground"> · {formatSol(sol)} {nativeOf().symbol}</span>
      </span>
    );
  };
  const rows: Array<[string, React.ReactNode]> =
    "tokensOut" in quote
      ? [
          ["You get", <span key="v" className="text-foreground">≈ {formatCompact(unitsToNumber(quote.tokensOut.toString(), token.decimals))} {sym}</span>],
          ["Trade size", size("lamports" in quote ? quote.lamports : null, "quoteUnits" in quote ? quote.quoteUnits : null)],
          [`Min received · ${slippage / 100}%`, `${formatCompact(unitsToNumber(("minOutShown" in quote && quote.minOutShown !== undefined ? quote.minOutShown : quote.minOut).toString(), token.decimals))} ${sym}`],
        ]
      : [
          ["You receive", <span key="v" className="text-foreground">≈ {formatZec(quote.zecOut.toString())} <CoinIcon symbol="ZEC" size={12} /> ZEC</span>],
          ["Trade size", size("lamports" in quote ? quote.lamports : null, "quoteUnits" in quote ? quote.quoteUnits : null)],
          // A6: a rounded sell signs the same minimum price on fewer tokens, so the floor shrinks with it.
          [`Min received · ${slippage / 100}%`, `${rounded ? "≈ " : ""}${formatZec(quote.minZecOut.toString())} ZEC`],
        ];
  if (zecPair && pair.spread !== null) rows.push(["ZEC parity", `1:1 · ${pair.spread / 100}% spread`]);
  if (nowFee)
    rows.push([
      "Priority fee · Now",
      nowFee.fee === null ? (
        "Flat, set by the pool, from balance"
      ) : "zat" in nowFee.fee ? (
        `${formatZec(nowFee.fee.zat.toString())} ZEC from balance`
      ) : (
        <span key="fee">
          {formatSol(unitsToNumber(nowFee.fee.lamports.toString(), nativeOf().decimals))} {nativeOf().symbol}
          {rate !== null && <span className="text-faint-foreground"> · ≈ {formatZec(lamportsToZatCeil(nowFee.fee.lamports, rate).toString())} ZEC from balance</span>}
        </span>
      ),
    ]);
  return (
    <dl className="space-y-1.5 rounded-xl border border-border px-3 py-3 text-xs">
      {rows.map(([k, v], i) => (
        <div key={k} className={cn("flex items-baseline justify-between gap-3", i === 0 && "text-sm")}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="tabular text-right text-muted-foreground">{v}</dd>
        </div>
      ))}
      <p className="pt-1 text-[11px] text-pretty text-faint-foreground">
        {zecPair
          ? "Paid in ZEC, priced in ZEC: no SOL rate in between. At the current price; the amount locks when the pool accepts, min received is rounded down."
          : "At the current price and the last rate the pool fixed. Final rate locks when the pool accepts; min received is rounded down."}
      </p>
    </dl>
  );
}

/**
 * Panel settings: max slippage (saved per network in this browser). Priority is the execution mode
 * below (Now / Delayed): there is no separate priority fee to tune.
 */
function PanelSettings({ slippage, onSlippage }: { slippage: number; onSlippage: (bps: number) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const id = useId();
  const customBps = custom.trim() === "" ? null : Math.round(Number(custom) * 100);
  const customOk = customBps !== null && isSlippageBps(customBps);
  return (
    <div className="rounded-xl border border-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-p`}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <SlidersHorizontal size={13} weight="light" aria-hidden />
        <span className="flex-1 text-left">
          Max slippage <span className="tabular text-foreground">{slippage / 100}%</span>
        </span>
        <CaretDown size={11} weight="light" className={cn("transition-transform duration-200", open && "rotate-180")} aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`${id}-p`}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            style={{ overflow: "hidden" }}
          >
            <div className="space-y-3 border-t border-border/60 px-3 pt-3 pb-3">
              <div role="radiogroup" aria-label="Max slippage" className="grid grid-cols-5 gap-1.5">
                {SLIPPAGE_CHOICES_BPS.map((b) => (
                  <Chip key={b} role="radio" aria-checked={slippage === b} onClick={() => onSlippage(b)} active={slippage === b} className="w-full justify-center px-0">
                    {b / 100}%
                  </Chip>
                ))}
                <input
                  aria-label="Custom slippage, percent"
                  inputMode="decimal"
                  placeholder="%"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value.replace(",", "."))}
                  onBlur={() => customOk && onSlippage(customBps!)}
                  onKeyDown={(e) => e.key === "Enter" && customOk && onSlippage(customBps!)}
                  className={cn(
                    "tabular h-9 w-full min-w-0 rounded-full border bg-transparent text-center text-xs outline-none sm:h-8 focus:border-ring",
                    custom && !customOk ? "border-destructive/60" : "border-border",
                  )}
                />
              </div>
              {custom && !customOk && <p className="text-[11px] text-sell">Use 0.01–{MAX_SLIPPAGE_BPS / 100}%.</p>}
              <p className="text-[11px] text-pretty text-faint-foreground">
                Priority is the execution mode below: Now skips the batch. No separate priority fee. Buy presets live in{" "}
                <Link href="/portfolio#settings" className="underline underline-offset-4 hover:text-muted-foreground">
                  Settings
                </Link>
                .
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
