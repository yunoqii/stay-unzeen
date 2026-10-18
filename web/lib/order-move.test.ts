import { describe, expect, it } from "vitest";
import type { Order } from "@/lib/api/types";
import { moveOrder, parseLineId, priceString } from "./order-move";

const now = 1_792_000_000_000;
const order = (o: Partial<Order>): Order =>
  ({ id: "o1", venue: "pumpfun", mint: "M", kind: "stop_loss", triggerPriceSol: "0.0000000003", amount: "1000000", slippageBps: 1500, exec: "delayed", status: "open", createdAt: now - 60_000, expiresAt: now + 6 * 3600_000 + 120_000, ...o }) as Order;

describe("moving an order line = cancel + the same order at the new price", () => {
  it("line ids and price strings", () => {
    expect(parseLineId("abc:sl")).toEqual({ orderId: "abc", leg: "sl" });
    expect(parseLineId("abc")).toEqual({ orderId: "abc" });
    expect(priceString(2.85e-10)).toBe("0.000000000285");
    expect(priceString(0.0123456789)).toBe("0.0123457");
    expect(priceString(0)).toBeNull();
  });
  it("keeps kind, amount, slippage, exec, re-arm and the hours left", () => {
    const r = moveOrder(order({ rearm: true }), undefined, 2.85e-10, now);
    expect(r).toEqual({ ok: true, from: 3e-10, to: 2.85e-10, create: { op: "order_create", venue: "pumpfun", mint: "M", kind: "stop_loss", amount: "1000000", slippageBps: 1500, ttlSecs: 6 * 3600, exec: "delayed", rearm: true, triggerPriceSol: "0.000000000285" } });
  });
  it("brackets move one leg and keep TP above SL", () => {
    const b = order({ kind: "bracket", triggerPriceSol: "0.0000000005", slPriceSol: "0.0000000002", slSlippageBps: 1500 });
    const r = moveOrder(b, "sl", 2.5e-10, now);
    expect(r.ok && r.create).toMatchObject({ tpPriceSol: "0.0000000005", slPriceSol: "0.00000000025", slSlippageBps: 1500 });
    expect(r.ok && "triggerPriceSol" in r.create).toBe(false);
    expect(moveOrder(b, "sl", 6e-10, now)).toMatchObject({ ok: false });
    expect(moveOrder(b, "tp", 1e-10, now)).toMatchObject({ ok: false });
  });
  it("refuses closed orders and orders with less than an hour left", () => {
    expect(moveOrder(order({ status: "triggered" }), undefined, 1e-10, now)).toMatchObject({ ok: false });
    expect(moveOrder(order({ expiresAt: now + 30 * 60_000 }), undefined, 1e-10, now)).toMatchObject({ ok: false });
  });
});
