// Private orders (docs/API.md v0.8 "Ордера", docs/analysis/orders.md): pure helpers shared by the
// token page, the portfolio and the tests. An order is a record in the pool's ledger only; when it
// triggers it becomes an ordinary buy / sell in the next batch. Anything "relative to your entry" is
// computed here in the browser: only the absolute trigger price ever reaches the server (O2).

import type { Order, OrderKind, OrdersParams, PoolInfo, Token } from "@/lib/api/types";
import { sellMirrorsBuy } from "@/lib/trade";

export const ORDER_KINDS: readonly OrderKind[] = ["limit_buy", "limit_sell", "take_profit", "stop_loss", "bracket"];

export const ORDER_LABEL: Record<OrderKind, string> = {
  limit_buy: "Limit buy",
  limit_sell: "Limit sell",
  take_profit: "Take profit",
  stop_loss: "Stop-loss",
  bracket: "Bracket",
};

/** One line on what the order does, for the form and the lists. */
export const ORDER_RULE: Record<OrderKind, string> = {
  limit_buy: "Buys when the price falls to your trigger or below.",
  limit_sell: "Sells when the price rises to your trigger or above.",
  take_profit: "Sells when the price rises to your target.",
  stop_loss: "Sells when the price stays at or below your trigger on two checks in a row.",
  bracket: "Take profit above, stop-loss below, on one position. Whichever hits first sells; the other is cancelled.",
};

/** v0.15 honest line next to the re-arm checkbox (maxRearms from PoolInfo.orders, 3 by default). */
export const rearmNote = (maxRearms = 3) =>
  `Retries after slippage up to ${maxRearms} time${maxRearms === 1 ? "" : "s"}. A stop-loss with retry may still not exit in a crash.`;

/** Default slippage of a kind (servers before v0.15 have no bracket entry: TP default 500). */
export function defaultSlippage(params: Pick<OrdersParams, "defaultSlippageBps">, kind: OrderKind): number {
  return kind === "bracket" ? (params.defaultSlippageBps.bracket ?? 500) : params.defaultSlippageBps[kind];
}

/** The leg of a bracket that fired, as the single kind it behaved like (chart markers, history). */
export function firedAs(o: Pick<Order, "kind" | "leg">): Exclude<OrderKind, "bracket"> {
  if (o.kind !== "bracket") return o.kind;
  return o.leg === "sl" ? "stop_loss" : "take_profit";
}

/** v0.15 bracket legs: both valid prices and TP strictly above SL (the server answers 400 otherwise). */
export function checkBracket(tp: string, sl: string): string | null {
  const a = checkTrigger(tp);
  if (a) return a;
  const b = checkTrigger(sl);
  if (b) return b;
  if (tp.trim() && sl.trim() && !(Number(tp) > Number(sl))) return "The take-profit price must be above the stop-loss price.";
  return null;
}

export const isSellKind = (k: OrderKind) => k !== "limit_buy";
/** Which side of the current price the condition waits for. */
export const triggersBelow = (k: OrderKind) => k === "limit_buy" || k === "stop_loss";

export const ORDERS_PRIVACY_NOTE = "Orders live only in the pool's private ledger, never on-chain.";
export const STOP_LOSS_NOTE = "Stop-loss reacts within ~1 minute and fills in the next batch — not a guaranteed exit.";

export type OrderExec = "delayed" | "max";

// ---- support ----

export type OrderSupport = { ok: true; params: OrdersParams } | { ok: false; reason: string };

/**
 * Orders only for mints the pool already trades (listed in the public GET /api/tokens), on the pump.fun
 * curve, and only if the server has orders at all (PoolInfo.orders). Otherwise the tab says why.
 */
export function orderSupport(
  token: Pick<Token, "mint" | "venue" | "status"> & { quote?: Token["quote"] },
  pool: Pick<PoolInfo, "orders"> | null,
  listed: readonly Pick<Token, "mint">[] | null,
): OrderSupport {
  const params = pool?.orders;
  if (!params) return { ok: false, reason: "Private orders aren't switched on for this pool yet." };
  // v0.13: orders (and their SOL trigger prices) exist only on SOL pairs; the server answers order_unsupported_mint.
  if (token.quote && token.quote !== "SOL")
    return {
      ok: false,
      reason: `Private orders work on SOL pairs only, and this token trades against ${token.quote}. Buy and sell it directly; limit, take-profit and stop-loss stay with SOL-paired tokens.`,
    };
  if (!params.venues.includes(token.venue as "pumpfun")) return { ok: false, reason: "Orders work only for pump.fun tokens for now." };
  if (token.status !== "curve") return { ok: false, reason: "This token left the bonding curve. Orders work only while a token is on the pump.fun curve." };
  if (listed && !listed.some((t) => t.mint === token.mint))
    return { ok: false, reason: "The pool hasn't traded this token yet. Orders open up once unzeen has bought it at least once." };
  return { ok: true, params };
}

// ---- limits ----

export interface OrderLimits {
  openTotal: number;
  openHere: number;
  maxTotal: number;
  maxHere: number;
  /** null when a new order is allowed. */
  blocked: string | null;
}

export function orderLimits(orders: readonly Order[] | null | undefined, mint: string, params: Pick<OrdersParams, "maxOpenPerKey" | "maxOpenPerMint">): OrderLimits {
  const open = (orders ?? []).filter((o) => o.status === "open");
  const openHere = open.filter((o) => o.mint === mint).length;
  const blocked =
    open.length >= params.maxOpenPerKey
      ? `You have ${params.maxOpenPerKey} open orders, the maximum. Cancel one to place another.`
      : openHere >= params.maxOpenPerMint
        ? `You have ${params.maxOpenPerMint} open orders on this token, the maximum. Cancel one to place another.`
        : null;
  return { openTotal: open.length, openHere, maxTotal: params.maxOpenPerKey, maxHere: params.maxOpenPerMint, blocked };
}

// ---- prices ----

/** A positive number as a plain decimal string with `sig` significant digits (never e-notation). */
export function plainDecimal(n: number, sig = 6): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const digits = Math.min(20, Math.max(0, sig - 1 - Math.floor(Math.log10(n))));
  const s = n.toFixed(digits);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** `base` moved by `pct` percent, as a trigger string. */
export function priceAtPct(base: string | number, pct: number): string {
  const b = typeof base === "string" ? Number(base) : base;
  return plainDecimal(b * (1 + pct / 100));
}

/** Percent distance of `trigger` from `base` (null when either is not a positive number). */
export function pctFrom(base: string | number, trigger: string | number): number | null {
  const b = Number(base);
  const t = Number(trigger);
  if (!(b > 0) || !(t > 0)) return null;
  return (t / b - 1) * 100;
}

/** Validation of the trigger field, mirroring the server (positive decimal, at most 18 significant digits). */
export function checkTrigger(v: string): string | null {
  const s = v.trim();
  if (s === "") return null;
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(s)) return "Use a plain decimal price in SOL, like 0.00000034.";
  if (!(Number(s) > 0)) return "The trigger price must be above zero.";
  const sig = s.replace(".", "").replace(/^0+/, "").replace(/0+$/, "").length;
  if (sig > 18) return "At most 18 significant digits.";
  return null;
}

/**
 * Honest notes on where the trigger sits against the current price: a limit buy above the price (or
 * a stop-loss above it) fires on the next check, a sell trigger below the price likewise.
 */
export function triggerNote(kind: OrderKind, current: string, trigger: string): string | null {
  const d = pctFrom(current, trigger);
  if (d === null) return null;
  if (triggersBelow(kind) && d >= 0)
    return kind === "stop_loss"
      ? "This is at or above the current price: the stop-loss would sell after the next two checks."
      : "This is at or above the current price: it would buy on the next check.";
  if (!triggersBelow(kind) && d <= 0) return "This is at or below the current price: it would sell on the next check.";
  return null;
}

/** Preset distances (percent) offered next to the trigger field. */
export const TRIGGER_PRESETS: Record<OrderKind, number[]> = {
  limit_buy: [-5, -10, -25],
  limit_sell: [10, 25, 50],
  take_profit: [25, 50, 100],
  stop_loss: [-5, -10, -20],
  bracket: [25, 50, 100],
};
/** Presets of a bracket's SL leg. */
export const SL_LEG_PRESETS = [-5, -10, -20];

// ---- ttl ----

export const TTL_PRESETS_H = [1, 6, 24, 72];

export function clampTtlHours(h: number, params: Pick<OrdersParams, "maxTtlSecs">): number {
  const max = Math.floor(params.maxTtlSecs / 3600);
  return Math.min(max, Math.max(1, Math.round(h)));
}

// ---- privacy warning ----

/**
 * v0.17 (A5, A6): a sell order sized like one of your buys of the last 48 h, their sum, or the whole
 * position: the pool shaves 0.5–2 % and rounds it when it triggers (Order.amount may shrink, the rest
 * returns to the balance). The UI shows "≈" instead of a warning.
 */
export function sellMatchesBuy(amount: bigint, buys: readonly bigint[], position: bigint | null): "buy" | "position" | null {
  return sellMirrorsBuy(amount, buys, position);
}

// ---- lists ----

export const ORDER_STATUS_LABEL: Record<Order["status"], string> = {
  open: "Open",
  triggered: "Triggered",
  filled: "Filled",
  cancelled: "Cancelled",
  expired: "Expired",
  failed: "Failed",
};

export const isLive = (o: Pick<Order, "status">) => o.status === "open" || o.status === "triggered";

/** "in 23h", "in 40m" until expiry. */
export function expiresIn(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "expiring";
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `in ${h}h` : `in ${Math.floor(h / 24)}d ${h % 24}h`;
}
