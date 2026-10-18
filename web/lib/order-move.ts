// Dragging an order line on the chart. The API has no edit: a moved order is order_cancel + a new order_create
// with the same kind, amount, slippage, execution and re-arm, the new trigger, and the time it had left.

import type { Order, SignedAction } from "@/lib/api/types";

export type OrderCreate = Extract<SignedAction, { op: "order_create" }>;

/** Chart line id -> order id and bracket leg ("<id>:tp" / "<id>:sl"). */
export function parseLineId(lineId: string): { orderId: string; leg?: "tp" | "sl" } {
  const m = lineId.match(/^(.+):(tp|sl)$/);
  return m ? { orderId: m[1], leg: m[2] as "tp" | "sl" } : { orderId: lineId };
}

/** SOL price as the API takes it: decimal, <= 18 significant digits, never e-notation. */
export function priceString(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const s = n.toPrecision(6);
  if (!s.includes("e")) return String(Number(s));
  const [m, e] = s.split("e");
  const exp = Number(e);
  const digits = m.replace(".", "").replace(/0+$/, "") || "0";
  if (exp < 0) return `0.${"0".repeat(-exp - 1)}${digits}`;
  return digits.padEnd(exp + 1, "0");
}

export type MovePlan = { ok: true; create: OrderCreate; from: number; to: number } | { ok: false; reason: string };

/**
 * The order_create that replaces `order` with the line `leg` moved to `toPriceSol`. Refuses what the server would
 * (a bracket whose TP would not stay above its SL, a non-open order, less than an hour left).
 */
export function moveOrder(order: Order, leg: "tp" | "sl" | undefined, toPriceSol: number, now: number, maxTtlSecs = 72 * 3600): MovePlan {
  if (order.status !== "open") return { ok: false, reason: "This order is no longer open." };
  const to = priceString(toPriceSol);
  if (!to) return { ok: false, reason: "Not a price." };
  const left = Math.floor((order.expiresAt - now) / 1000);
  if (left < 3600) return { ok: false, reason: "Less than an hour left: cancel it and place a new one from the Orders tab." };
  const ttlSecs = Math.min(maxTtlSecs, left - (left % 3600));
  const base = {
    op: "order_create" as const,
    venue: order.venue,
    mint: order.mint,
    kind: order.kind,
    amount: order.amount,
    slippageBps: order.slippageBps,
    ttlSecs,
    exec: order.exec,
    ...(order.rearm ? { rearm: true } : {}),
  };
  if (order.kind === "bracket") {
    const tp = leg === "tp" ? Number(to) : Number(order.triggerPriceSol);
    const sl = leg === "sl" ? Number(to) : Number(order.slPriceSol);
    if (!(tp > sl)) return { ok: false, reason: "Take profit must stay above stop-loss." };
    const from = leg === "sl" ? Number(order.slPriceSol) : Number(order.triggerPriceSol);
    return {
      ok: true,
      from,
      to: Number(to),
      create: { ...base, tpPriceSol: leg === "tp" ? to : order.triggerPriceSol, slPriceSol: leg === "sl" ? to : order.slPriceSol!, ...(order.slSlippageBps ? { slSlippageBps: order.slSlippageBps } : {}) },
    };
  }
  return { ok: true, from: Number(order.triggerPriceSol), to: Number(to), create: { ...base, triggerPriceSol: to } };
}
