"use client";

import { useId, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Info, LockSimple, ShieldCheck, Timer, WarningCircle } from "@phosphor-icons/react";
import { ApiError } from "@/lib/api/client";
import type { Order, OrderKind, Token } from "@/lib/api/types";
import { recentBuyAmounts } from "@/lib/activity";
import { useKeyState } from "@/lib/crypto/session";
import { EXEC_COPY, useDefaultExec } from "@/lib/exec";
import { formatCompact, formatPrice, formatUnits, formatZec, parseUnits, unitsToNumber, ZEC_DECIMALS } from "@/lib/format";
import { fillsOf } from "@/lib/history/reduce";
import { useHistory } from "@/lib/history/store";
import { useNetwork } from "@/lib/network";
import { cancelOrder, placeOrder, useSessionOrders } from "@/lib/order-session";
import {
  checkTrigger,
  clampTtlHours,
  expiresIn,
  isLive,
  isSellKind,
  ORDER_KINDS,
  ORDER_LABEL,
  ORDER_RULE,
  ORDER_STATUS_LABEL,
  orderLimits,
  ORDERS_PRIVACY_NOTE,
  pctFrom,
  priceAtPct,
  sellMatchesBuy,
  STOP_LOSS_NOTE,
  TRIGGER_PRESETS,
  triggerNote,
  TTL_PRESETS_H,
  type OrderExec,
  type OrderSupport,
} from "@/lib/orders";
import { avgEntrySol, computePosition } from "@/lib/pnl";
import { cn } from "@/lib/utils";
import { usePool } from "@/hooks/use-pool";
import { usePortfolio } from "@/hooks/use-portfolio";
import { useNow } from "@/hooks/use-now";
import { Button } from "@/components/ui/button";
import { Chip, ErrorNote } from "./parts";

const EASE = [0.16, 1, 0.3, 1] as const;
const SLIPPAGE_CHOICES = [100, 300, 500, 1000, 1500, 2500];

/** Shown in place of the form when this mint can't take orders: the tab stays visible, with the reason. */
export function OrdersUnavailable({ reason }: { reason: string }) {
  return (
    <div className="mt-5 rounded-2xl border border-dashed border-border p-4 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <LockSimple size={15} weight="light" className="text-muted-foreground" aria-hidden />
        Orders unavailable here
      </p>
      <p className="mt-1.5 text-pretty text-muted-foreground">{reason}</p>
      <p className="mt-3 text-xs text-pretty text-faint-foreground">
        Limit buys, take-profit and stop-loss work on pump.fun tokens the pool already trades. {ORDERS_PRIVACY_NOTE}
      </p>
    </div>
  );
}

/**
 * Private orders: limit buy / limit sell / take-profit / stop-loss, held in the pool's ledger and
 * turned into an ordinary batched trade when the price tick meets the trigger. "% from entry" is
 * worked out here from the local history; the server only ever gets the absolute price.
 */
export function OrdersPanel({ token, priceSol, support }: { token: Token; priceSol: string; support: Extract<OrderSupport, { ok: true }> }) {
  const params = support.params;
  const network = useNetwork();
  const key = useKeyState();
  const pubkey = key.status === "unlocked" ? key.pubkey : null;
  const { portfolio } = usePortfolio();
  const { pool } = usePool();
  const history = useHistory();
  const profileExec = useDefaultExec(network);
  const ids = useId();

  const [kind, setKind] = useState<OrderKind>("limit_buy");
  const [trigger, setTrigger] = useState("");
  const [amount, setAmount] = useState("");
  const [ttlH, setTtlH] = useState(() => Math.round(params.defaultTtlSecs / 3600));
  const [exec, setExec] = useState<OrderExec>(profileExec === "max" ? "max" : "delayed");
  const [slipOverride, setSlipOverride] = useState<Partial<Record<OrderKind, number>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);

  const sell = isSellKind(kind);
  const decimals = sell ? token.decimals : ZEC_DECIMALS;
  const unit = sell ? `$${token.symbol}` : "ZEC";
  const slippage = slipOverride[kind] ?? params.defaultSlippageBps[kind];

  const fills = useMemo(() => fillsOf(history.entries, token.mint), [history.entries, token.mint]);
  const entry = useMemo(() => avgEntrySol(computePosition(fills), token.decimals), [fills, token.decimals]);
  const buys = useMemo(() => {
    const local = fills.filter((f) => f.kind === "buy" || f.kind === "create").map((f) => BigInt(f.tokenAmount));
    return pubkey ? [...local, ...recentBuyAmounts(network, pubkey, token.mint)] : local;
  }, [fills, network, pubkey, token.mint]);

  const zecBalance = portfolio ? BigInt(portfolio.zecBalance) : null;
  const holding = portfolio ? BigInt(portfolio.holdings.find((h) => h.mint === token.mint)?.amount ?? "0") : null;
  const available = sell ? holding : zecBalance;
  const minAction = pool ? BigInt(pool.minActionZat) : null;
  const limits = orderLimits(portfolio?.orders, token.mint, params);

  // ---- validation ----
  const triggerError = checkTrigger(trigger);
  let parsed: bigint | null = null;
  let amountError: string | null = null;
  if (amount.trim() !== "") {
    try {
      parsed = BigInt(parseUnits(amount, decimals));
      if (parsed === BigInt(0)) amountError = "Enter an amount above zero.";
    } catch {
      amountError = `Use a number with up to ${decimals} decimals.`;
    }
  }
  if (parsed !== null && !amountError) {
    if (available !== null && parsed > available)
      amountError = sell ? `You hold ${formatCompact(unitsToNumber(available.toString(), decimals))} ${unit} free to sell.` : "More than your ZEC balance.";
    else if (!sell && minAction !== null && parsed < minAction) amountError = `The pool minimum is ${formatZec(minAction.toString())} ZEC.`;
  }
  const note = trigger && !triggerError ? triggerNote(kind, priceSol, trigger) : null;
  const dist = trigger && !triggerError ? pctFrom(priceSol, trigger) : null;
  const sameAsBuy = sell && parsed !== null && !amountError ? sellMatchesBuy(parsed, buys, holding) : null;
  const frozen = portfolio?.frozen ?? false;
  const ready = !busy && !frozen && portfolio !== null && !limits.blocked && trigger.trim() !== "" && !triggerError && parsed !== null && !amountError;

  const pickKind = (k: OrderKind) => {
    if (k === kind) return;
    setKind(k);
    setTrigger("");
    setAmount("");
    setError(null);
  };

  const submit = async () => {
    if (!ready || parsed === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await placeOrder(
        network,
        {
          venue: "pumpfun",
          mint: token.mint,
          kind,
          triggerPriceSol: trigger.trim(),
          amount: parsed.toString(),
          slippageBps: slippage,
          ttlSecs: clampTtlHours(ttlH, params) * 3600,
          exec,
        },
        token.symbol,
      );
      setPlaced(r.id);
      setTrigger("");
      setAmount("");
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError("internal", String(e)));
    } finally {
      setBusy(false);
    }
  };

  const presetBase = kind === "take_profit" && entry !== null ? entry : Number(priceSol);
  const presetFromEntry = kind === "take_profit" && entry !== null;

  return (
    <div className="mt-5 space-y-4">
      <div role="radiogroup" aria-label="Order type" className="grid grid-cols-2 gap-1.5">
        {ORDER_KINDS.filter((k) => params.kinds.includes(k)).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => pickKind(k)}
            className={cn(
              "h-9 rounded-xl border text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              kind === k ? "border-zec/50 bg-zec/10 text-foreground" : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
            )}
          >
            {ORDER_LABEL[k]}
          </button>
        ))}
      </div>
      <p className="-mt-1 text-xs text-pretty text-faint-foreground">{ORDER_RULE[kind]}</p>

      {/* trigger */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between text-xs">
          <label htmlFor={`${ids}-trigger`} className="text-muted-foreground">
            {kind === "take_profit" ? "Target price" : "Trigger price"}
          </label>
          <button
            type="button"
            onClick={() => setTrigger(priceAtPct(priceSol, 0))}
            className="rounded text-faint-foreground underline-offset-4 hover:text-muted-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Now <span className="tabular text-muted-foreground">{formatPrice(priceSol)}</span> SOL
          </button>
        </div>
        <div
          className={cn(
            "flex h-12 items-center rounded-2xl border bg-surface-1 px-4 transition-colors duration-150 focus-within:border-ring",
            triggerError ? "border-destructive/60" : "border-border",
          )}
        >
          <input
            id={`${ids}-trigger`}
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder={priceAtPct(priceSol, TRIGGER_PRESETS[kind][1]) || "0.0000001"}
            value={trigger}
            onChange={(e) => {
              setError(null);
              setTrigger(e.target.value.replace(",", ".").trim());
            }}
            aria-invalid={!!triggerError}
            aria-describedby={`${ids}-trigger-hint`}
            className="tabular min-w-0 flex-1 bg-transparent text-lg font-medium tracking-tight outline-none placeholder:text-faint-foreground"
          />
          <span className="ml-3 shrink-0 text-xs text-muted-foreground">SOL / token</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {TRIGGER_PRESETS[kind].map((pct) => (
            <Chip key={pct} onClick={() => setTrigger(priceAtPct(presetBase, pct))} active={trigger === priceAtPct(presetBase, pct)}>
              {pct > 0 ? "+" : "−"}
              {Math.abs(pct)}%
            </Chip>
          ))}
          <span className="text-[11px] text-faint-foreground">{presetFromEntry ? "from your entry" : "from now"}</span>
        </div>
        <p id={`${ids}-trigger-hint`} className={cn("text-xs text-pretty", triggerError ? "text-sell" : note ? "text-zec/85" : "text-faint-foreground")}>
          {triggerError ??
            note ??
            (dist !== null
              ? `${dist >= 0 ? "+" : "−"}${Math.abs(dist).toFixed(1)}% from the current price${entry !== null && sell ? ` · ${fmtPct(pctFrom(entry, trigger))} from your entry` : ""}.`
              : entry !== null && sell
                ? `Your average entry is ${formatPrice(entry)} SOL, worked out in this browser only.`
                : "Checked against the pool's price tick, about once a minute.")}
        </p>
      </div>

      {/* amount */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between text-xs">
          <label htmlFor={`${ids}-amount`} className="text-muted-foreground">
            {sell ? "Amount to sell" : "Amount to spend"}
          </label>
          <span className="text-faint-foreground">
            {sell ? "Holding " : "Balance "}
            <span className="tabular text-muted-foreground">
              {available === null ? "…" : sell ? `${formatCompact(unitsToNumber(available.toString(), decimals))} ${unit}` : `${formatZec(available.toString())} ZEC`}
            </span>
          </span>
        </div>
        <div
          className={cn(
            "flex h-12 items-center rounded-2xl border bg-surface-1 px-4 transition-colors duration-150 focus-within:border-ring",
            amountError ? "border-destructive/60" : "border-border",
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
              setAmount(e.target.value.replace(",", ".").trim());
            }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            aria-invalid={!!amountError}
            aria-describedby={`${ids}-amount-hint`}
            className="tabular min-w-0 flex-1 bg-transparent text-lg font-medium tracking-tight outline-none placeholder:text-faint-foreground"
          />
          <span className="ml-3 shrink-0 text-sm text-muted-foreground">{unit}</span>
        </div>
        {sell && (
          <div className="flex flex-wrap gap-1.5">
            {[25, 50, 100].map((p) => (
              <Chip
                key={p}
                disabled={!holding}
                onClick={() => holding && setAmount(formatUnits(((holding * BigInt(p)) / BigInt(100)).toString(), token.decimals))}
              >
                {p}%
              </Chip>
            ))}
          </div>
        )}
        {(amountError || (!sell && zecBalance === BigInt(0))) && (
          <p id={`${ids}-amount-hint`} className={cn("text-xs", amountError ? "text-sell" : "text-faint-foreground")}>
            {amountError ?? "Your balance is empty. Top up with shielded ZEC first."}
          </p>
        )}
        {sameAsBuy && (
          <p role="note" className="flex gap-2 rounded-xl border border-zec/30 bg-zec-soft px-3 py-2.5 text-xs text-pretty text-zec">
            <WarningCircle size={14} weight="light" className="mt-px shrink-0" aria-hidden />
            <span>
              {sameAsBuy === "position" ? "This sells your whole position, the same amount as one of your buys." : "Same amount as one of your recent buys."} On-chain a
              sale of exactly that size can be matched to the buy. Sell a slightly different amount, or split it.
            </span>
          </p>
        )}
      </div>

      {/* lifetime, mode, slippage */}
      <div className="space-y-3 rounded-xl border border-border p-3">
        <div>
          <p className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Expires after</span>
            <span className="tabular text-faint-foreground">1–{Math.floor(params.maxTtlSecs / 3600)} h</span>
          </p>
          <div role="radiogroup" aria-label="Order lifetime" className="mt-2 flex flex-wrap items-center gap-1.5">
            {TTL_PRESETS_H.filter((h) => h * 3600 <= params.maxTtlSecs).map((h) => (
              <Chip key={h} role="radio" aria-checked={ttlH === h} active={ttlH === h} onClick={() => setTtlH(h)}>
                {h} h
              </Chip>
            ))}
            <input
              aria-label="Custom lifetime, hours"
              inputMode="numeric"
              value={TTL_PRESETS_H.includes(ttlH) ? "" : String(ttlH)}
              placeholder="h"
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ""));
                if (n > 0) setTtlH(clampTtlHours(n, params));
              }}
              className="tabular h-9 w-14 rounded-full border border-border bg-transparent text-center text-xs outline-none focus:border-ring sm:h-8"
            />
          </div>
        </div>

        <div className="border-t border-border/60 pt-3">
          <p className="text-xs text-muted-foreground">Execution when it triggers</p>
          <div role="radiogroup" aria-label="Execution mode" className="mt-2 grid grid-cols-2 gap-1 rounded-full border border-border p-1">
            {(["delayed", "max"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={exec === m}
                onClick={() => setExec(m)}
                className={cn(
                  "relative inline-flex items-center justify-center gap-1.5 rounded-full py-1.5 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  exec === m ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {exec === m && <motion.span layoutId={`${ids}-oexec`} className="absolute inset-0 rounded-full bg-surface-3" transition={{ type: "spring", bounce: 0, duration: 0.3 }} />}
                <Timer size={12} weight={exec === m ? "duotone" : "light"} className={cn("relative", exec === m && "text-zec")} aria-hidden />
                <span className="relative">{m === "delayed" ? "Delayed" : "Max privacy"}</span>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-faint-foreground">{EXEC_COPY[exec].hint}. Orders never use Now.</p>
        </div>

        <div className="border-t border-border/60 pt-3">
          <p className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Max slippage from the trigger</span>
            <span className="tabular text-foreground">{slippage / 100}%</span>
          </p>
          <div role="radiogroup" aria-label="Max slippage from the trigger" className="mt-2 grid grid-cols-6 gap-1">
            {SLIPPAGE_CHOICES.map((b) => (
              <Chip key={b} role="radio" aria-checked={slippage === b} active={slippage === b} onClick={() => setSlipOverride((o) => ({ ...o, [kind]: b }))} className="w-full justify-center px-0">
                {b / 100}%
              </Chip>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-pretty text-faint-foreground">
            {sell ? "Never sells below the trigger minus this." : "Never pays above the trigger plus this."} If the batch can’t fill inside it, the order fails and the hold
            returns.
          </p>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {kind === "stop_loss" && (
          <motion.p
            key="sl"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            style={{ overflow: "hidden" }}
            className="text-xs text-pretty text-zec/85"
          >
            <span className="flex gap-2 rounded-xl border border-zec/25 bg-zec-soft px-3 py-2.5">
              <WarningCircle size={14} weight="light" className="mt-px shrink-0 text-zec" aria-hidden />
              <span>{STOP_LOSS_NOTE}</span>
            </span>
          </motion.p>
        )}
      </AnimatePresence>

      {frozen && (
        <p role="alert" className="rounded-xl bg-zec-soft p-3 text-xs text-zec">
          Your balance is on hold while a deposit is reviewed. Orders resume when the review ends.
        </p>
      )}
      {limits.blocked && (
        <p role="alert" className="flex gap-2 text-xs text-pretty text-muted-foreground">
          <Info size={14} weight="light" className="mt-px shrink-0" aria-hidden />
          {limits.blocked}
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

      <Button onClick={submit} disabled={!ready} aria-busy={busy} className={cn("h-12 w-full rounded-full text-[15px]", busy && "busy-hatch disabled:opacity-90")}>
        {busy ? "Signing…" : `Place ${ORDER_LABEL[kind].toLowerCase()}`}
      </Button>
      <div className="space-y-1 text-center text-[11px] text-faint-foreground">
        <p className="flex items-center justify-center gap-1.5">
          <ShieldCheck size={12} weight="light" aria-hidden />
          {ORDERS_PRIVACY_NOTE}
        </p>
        <p className="tabular">
          {limits.openHere} of {limits.maxHere} open on this token · {limits.openTotal} of {limits.maxTotal} in total
        </p>
      </div>

      <OwnOrders token={token} placed={placed} />
    </div>
  );
}

const fmtPct = (v: number | null) => (v === null ? "" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`);

/** Your orders on this mint: open ones with Cancel, then what closed during this session. */
function OwnOrders({ token, placed }: { token: Token; placed: string | null }) {
  const network = useNetwork();
  const key = useKeyState();
  const { portfolio } = usePortfolio();
  const session = useSessionOrders(network, key.status === "unlocked" ? key.pubkey : null);
  const id = useId();
  // Server list first (fresh after every poll), then anything this session saw that the server erased.
  const list = useMemo(() => {
    const server = (portfolio?.orders ?? []).filter((o) => o.mint === token.mint);
    const ids = new Set(server.map((o) => o.id));
    const extra = session.filter((s) => s.order.mint === token.mint && !ids.has(s.order.id)).map((s) => s.order);
    return [...server, ...extra].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.createdAt - a.createdAt);
  }, [portfolio?.orders, session, token.mint]);

  return (
    <section aria-labelledby={`${id}-t`} className="border-t border-border/60 pt-4">
      <h3 id={`${id}-t`} className="flex items-baseline justify-between text-sm font-medium">
        Your orders here
        <span className="text-[11px] font-normal text-faint-foreground">Visible only to your key</span>
      </h3>
      {list.length === 0 ? (
        <p className="mt-2 text-xs text-faint-foreground">No orders on ${token.symbol} yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border/60">
          <AnimatePresence initial={false}>
            {list.map((o) => (
              <motion.li
                key={o.id}
                layout="position"
                initial={o.id === placed ? { opacity: 0, y: -6, filter: "blur(6px)" } : false}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: EASE }}
              >
                <OrderRow order={o} token={token} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}

/** One order line with Cancel (open only). Shared with the portfolio. */
export function OrderRow({ order, token, compact = false }: { order: Order; token: Pick<Token, "symbol" | "decimals"> | null; compact?: boolean }) {
  const network = useNetwork();
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sym = token ? `$${token.symbol}` : "token";
  const amount = isSellKind(order.kind)
    ? `${token ? formatCompact(unitsToNumber(order.amount, token.decimals)) : "—"} ${sym}`
    : `${formatZec(order.amount)} ZEC`;
  const status =
    order.status === "open" && order.armed
      ? "Armed · confirming"
      : order.status === "triggered"
        ? "Triggered · next batch"
        : order.status === "open"
          ? now === null
            ? "Open"
            : `Open · expires ${expiresIn(order.expiresAt, now)}`
          : ORDER_STATUS_LABEL[order.status];

  const cancel = async () => {
    setBusy(true);
    setErr(null);
    try {
      await cancelOrder(network, order.id);
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "order_not_open" ? "It already triggered or closed." : "Couldn't cancel. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("flex items-center gap-3", compact ? "py-2" : "py-2.5")}>
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          order.status === "open" && (order.armed ? "live-dot bg-sell" : "bg-zec"),
          order.status === "triggered" && "live-dot bg-zec",
          order.status === "filled" && "bg-muted-foreground",
          (order.status === "cancelled" || order.status === "expired") && "bg-border-strong",
          order.status === "failed" && "bg-sell",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          {ORDER_LABEL[order.kind]}
          {compact && <span className="text-muted-foreground"> {sym}</span>}
          <span className="text-faint-foreground"> at </span>
          <span className="tabular">{formatPrice(order.triggerPriceSol)}</span>
          <span className="text-faint-foreground"> SOL</span>
        </p>
        <p className="tabular truncate text-xs text-faint-foreground">
          {amount} · <span className={cn(order.status === "failed" && "text-sell", order.armed && "text-sell")}>{status}</span>
          {order.exec === "max" && " · max privacy"}
        </p>
        {err && <p className="text-xs text-sell">{err}</p>}
      </div>
      {order.status === "open" && (
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          className="h-8 shrink-0 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:border-sell/50 hover:text-sell focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
        >
          {busy ? "Cancelling…" : "Cancel"}
        </button>
      )}
    </div>
  );
}
