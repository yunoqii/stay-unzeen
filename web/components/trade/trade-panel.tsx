"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, CaretDown, Info, Key, LockKey, ShieldCheck, SlidersHorizontal, WarningCircle } from "@phosphor-icons/react";
import { ApiError, errorText } from "@/lib/api/client";
import type { SignedAction, Token, Venue } from "@/lib/api/types";
import { lastRate, submitAction, useAction, useActivityVersion } from "@/lib/activity";
import { useKeyState } from "@/lib/crypto/session";
import { formatCompact, formatSol, formatUnits, formatZec, parseUnits, unitsToNumber, VENUE_LABEL, ZEC_DECIMALS } from "@/lib/format";
import { useNetwork } from "@/lib/network";
import { nowFee as poolNowFee, resolveExec, useDefaultExec, withExec, type ExecMode, type NowFee } from "@/lib/exec";
import { lamportsToZatCeil, quoteBuy, quoteSell } from "@/lib/trade";
import { isSlippageBps, MAX_SLIPPAGE_BPS, SELL_PRESETS, SLIPPAGE_CHOICES_BPS, updateTradeSettings, useTradeSettings } from "@/lib/trade-settings";
import { cn } from "@/lib/utils";
import { usePool } from "@/hooks/use-pool";
import { usePortfolio } from "@/hooks/use-portfolio";
import { Button } from "@/components/ui/button";
import { ActionStatusCard } from "./action-status";
import { ExecSwitch } from "./exec-switch";

type Side = "buy" | "sell";

export function TradePanel({ token, priceSol }: { token: Token; priceSol: string }) {
  const key = useKeyState();
  const [side, setSide] = useState<Side>("buy");
  const tabsId = useId();

  return (
    <section aria-labelledby={`${tabsId}-title`} className="p-4 sm:p-5">
      <h2 id={`${tabsId}-title`} className="sr-only">
        Trade ${token.symbol}
      </h2>
      <div role="tablist" aria-label="Side" className="grid grid-cols-2 gap-1 rounded-full border border-border p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={side === s}
            onClick={() => setSide(s)}
            className={cn(
              "relative rounded-full py-2 text-sm font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              side === s ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {side === s && (
              <motion.span layoutId={`${tabsId}-side`} className="absolute inset-0 rounded-full bg-surface-3" transition={{ type: "spring", bounce: 0, duration: 0.3 }} />
            )}
            <span className="relative">{s === "buy" ? "Buy" : "Sell"}</span>
          </button>
        ))}
      </div>

      {key.status === "loading" ? (
        <div className="h-64" aria-busy />
      ) : key.status !== "unlocked" ? (
        <KeyPrompt mint={token.mint} locked={key.status === "locked"} />
      ) : (
        <OrderForm key={`${side}:${key.pubkey}`} side={side} token={token} priceSol={priceSol} />
      )}
    </section>
  );
}

function KeyPrompt({ mint, locked }: { mint: string; locked: boolean }) {
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

function OrderForm({ side, token, priceSol }: { side: Side; token: Token; priceSol: string }) {
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
  const venue: Venue = graduated && token.venue !== "jupiter" ? "jupiter" : token.venue;
  const rate = lastRate(network, side);

  const zecBalance = portfolio ? BigInt(portfolio.zecBalance) : null;
  const holding = portfolio ? BigInt(portfolio.holdings.find((h) => h.mint === token.mint)?.amount ?? "0") : null;
  const available = isBuy ? zecBalance : holding;
  const minAction = pool ? BigInt(pool.minActionZat) : null;

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
        : isBuy
          ? quoteBuy(parsed, rate, priceSol, token.decimals, slippage)
          : quoteSell(parsed, rate, priceSol, token.decimals, slippage);
    return { parsed, inputError, quote };
  };
  const { parsed, inputError, quote } = evaluate(amount);

  const frozen = portfolio?.frozen ?? false;
  const canSubmit = !busy && parsed !== null && !inputError && !frozen && portfolio !== null;

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

  const submit = async (value: string = amount) => {
    const { parsed, inputError, quote } = evaluate(value);
    // Invalid input stays in the field with its hint; nothing is signed.
    if (busy || parsed === null || inputError || frozen || portfolio === null) return;
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
      setError(e instanceof ApiError ? e : new ApiError("internal", String(e)));
    } finally {
      setBusy(false);
    }
  };

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
            setAmount(e.target.value.replace(",", "."));
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          aria-invalid={!!inputError}
          aria-describedby={`${ids}-hint`}
          className="tabular min-w-0 flex-1 bg-transparent text-2xl font-medium tracking-tight outline-none placeholder:text-faint-foreground"
        />
        <span className="ml-3 shrink-0 text-sm text-muted-foreground">{unit}</span>
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
          One-tap is on: a preset signs the order right away.{" "}
          <Link href="/portfolio#settings" className="underline-offset-4 hover:text-muted-foreground hover:underline">
            Change
          </Link>
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
            <ErrorNote error={error} minAction={minAction} />
          </motion.div>
        )}
      </AnimatePresence>

      <Button
        onClick={() => submit()}
        disabled={!canSubmit}
        className="h-12 w-full rounded-full text-[15px]"
      >
        {busy ? "Signing…" : `${isBuy ? "Buy" : "Sell"} $${token.symbol}`}
      </Button>
      <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-faint-foreground">
        <ShieldCheck size={12} weight="light" aria-hidden />
        Signed in this browser. On-chain it reads “unzeen”.
      </p>

    </div>
  );
}

function Quote({
  side,
  token,
  quote,
  hasAmount,
  rate,
  slippage,
  nowFee,
}: {
  side: Side;
  token: Token;
  quote: ReturnType<typeof quoteBuy> | ReturnType<typeof quoteSell>;
  hasAmount: boolean;
  rate: bigint | null;
  slippage: number;
  /** Shown when exec is "now"; fee null = the pool does not publish it yet. */
  nowFee: { fee: NowFee | null } | null;
}) {
  const sym = `$${token.symbol}`;
  if (!hasAmount)
    return (
      <div className="flex items-center justify-between rounded-xl border border-dashed border-border px-3 py-3 text-sm text-faint-foreground">
        <span>{side === "buy" ? "You get" : "You receive"}</span>
        <span>—</span>
      </div>
    );
  if (!rate || !quote)
    return (
      <div className="flex gap-2 rounded-xl border border-border px-3 py-3 text-xs text-pretty text-muted-foreground">
        <Info size={14} weight="light" className="mt-px shrink-0" aria-hidden />
        <span>
          No quote yet: the pool fixes the ZEC/SOL rate when it accepts your first order, so this one has no price limit. Later
          orders get a quote and your slippage limit.
        </span>
      </div>
    );
  const rows: Array<[string, React.ReactNode]> =
    "tokensOut" in quote
      ? [
          ["You get", <span key="v" className="text-foreground">≈ {formatCompact(unitsToNumber(quote.tokensOut.toString(), token.decimals))} {sym}</span>],
          ["Trade size", `≈ ${formatSol(Number(quote.lamports) / 1e9)} SOL`],
          [`Min received · ${slippage / 100}%`, `${formatCompact(unitsToNumber(quote.minOut.toString(), token.decimals))} ${sym}`],
        ]
      : [
          ["You receive", <span key="v" className="text-foreground">≈ {formatZec(quote.zecOut.toString())} ZEC</span>],
          ["Trade size", `≈ ${formatSol(Number(quote.lamports) / 1e9)} SOL`],
          [`Min received · ${slippage / 100}%`, `${formatZec(quote.minZecOut.toString())} ZEC`],
        ];
  if (nowFee)
    rows.push([
      "Priority fee · Now",
      nowFee.fee === null ? (
        "Flat, set by the pool, from balance"
      ) : "zat" in nowFee.fee ? (
        `${formatZec(nowFee.fee.zat.toString())} ZEC from balance`
      ) : (
        <span key="fee">
          {formatSol(Number(nowFee.fee.lamports) / 1e9)} SOL
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
      <p className="pt-1 text-[11px] text-faint-foreground">At the current price and the last rate the pool fixed. Final rate locks when the pool accepts.</p>
    </dl>
  );
}

function ErrorNote({ error, minAction }: { error: ApiError; minAction: bigint | null }) {
  let text = errorText(error);
  if (error.code === "below_minimum" && minAction !== null) text = `Below the pool minimum of ${formatZec(minAction.toString())} ZEC worth. Try a larger amount.`;
  if (error.code === "slippage") text = "The price moved past your limit. Raise max slippage or try a smaller amount.";
  return (
    <div role="alert" className="flex gap-2 rounded-xl border border-sell/30 bg-sell/5 px-3 py-2.5 text-sm text-pretty">
      <WarningCircle size={16} weight="light" className="mt-0.5 shrink-0 text-sell" aria-hidden />
      <div>
        <p className="text-foreground/90">{text}</p>
        {error.code === "insufficient_balance" && (
          <Link href="/pay" className="mt-1 inline-flex items-center gap-1 text-xs text-zec underline-offset-4 hover:underline">
            <ArrowDown size={12} weight="bold" aria-hidden />
            Top up
          </Link>
        )}
      </div>
    </div>
  );
}

function Chip({
  active,
  className,
  ...props
}: React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "tabular inline-flex h-9 items-center rounded-full border px-3 text-xs sm:h-8 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40",
        active ? "border-zec/50 bg-zec/10 text-foreground" : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
        className,
      )}
    />
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
