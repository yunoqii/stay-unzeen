import { describe, expect, it } from "vitest";
import type { Order, OrdersParams } from "@/lib/api/types";
import { checkTrigger, clampTtlHours, orderLimits, orderSupport, pctFrom, plainDecimal, priceAtPct, sellMatchesBuy, triggerNote } from "./orders";

const params: OrdersParams = {
  kinds: ["limit_buy", "limit_sell", "take_profit", "stop_loss"],
  venues: ["pumpfun"],
  maxOpenPerKey: 10,
  maxOpenPerMint: 4,
  maxTtlSecs: 259_200,
  defaultTtlSecs: 86_400,
  defaultSlippageBps: { limit_buy: 500, limit_sell: 500, take_profit: 500, stop_loss: 1500 },
  slConfirmTicks: 2,
  priceTick: { minSecs: 45, maxSecs: 75 },
};
const order = (mint: string, status: Order["status"] = "open"): Order => ({
  id: Math.random().toString(16).slice(2),
  venue: "pumpfun",
  mint,
  kind: "limit_buy",
  triggerPriceSol: "0.0000001",
  amount: "100000",
  slippageBps: 500,
  exec: "delayed",
  status,
  createdAt: 0,
  expiresAt: 3_600_000,
});

describe("orders: support", () => {
  const token = { mint: "M1", venue: "pumpfun" as const, status: "curve" as const };
  it("needs PoolInfo.orders, pump.fun, the curve and a pool-traded mint", () => {
    expect(orderSupport(token, { orders: params }, [{ mint: "M1" }])).toMatchObject({ ok: true });
    expect(orderSupport(token, {}, [{ mint: "M1" }])).toMatchObject({ ok: false });
    expect(orderSupport({ ...token, venue: "meteora-dbc" as never }, { orders: params }, [{ mint: "M1" }])).toMatchObject({ ok: false, reason: expect.stringContaining("pump.fun") });
    expect(orderSupport({ ...token, status: "graduated" as const }, { orders: params }, [{ mint: "M1" }])).toMatchObject({ ok: false, reason: expect.stringContaining("bonding curve") });
    expect(orderSupport(token, { orders: params }, [{ mint: "OTHER" }])).toMatchObject({ ok: false, reason: expect.stringContaining("hasn't traded") });
    // list not loaded yet: don't block on it, the server answers order_unsupported_mint anyway
    expect(orderSupport(token, { orders: params }, null)).toMatchObject({ ok: true });
  });
});

describe("orders: limits", () => {
  it("4 per mint and 10 per key, only open ones count", () => {
    const four = [order("A"), order("A"), order("A"), order("A"), order("B", "filled")];
    expect(orderLimits(four, "A", params)).toMatchObject({ openHere: 4, openTotal: 4, blocked: expect.stringContaining("on this token") });
    expect(orderLimits(four, "B", params).blocked).toBeNull();
    const ten = Array.from({ length: 10 }, (_, i) => order(`M${i}`));
    expect(orderLimits(ten, "X", params).blocked).toContain("10 open orders");
    expect(orderLimits(undefined, "X", params)).toMatchObject({ openTotal: 0, blocked: null });
  });
});

describe("orders: prices", () => {
  it("plain decimals, never e-notation", () => {
    expect(plainDecimal(3.4e-7)).toBe("0.00000034");
    expect(priceAtPct("0.00000034", -10)).toBe("0.000000306");
    expect(priceAtPct(0.000001, 50)).toBe("0.0000015");
    expect(plainDecimal(0)).toBe("");
    expect(pctFrom("0.000001", "0.0000015")).toBeCloseTo(50);
  });
  it("trigger validation mirrors the server", () => {
    expect(checkTrigger("0.00000034")).toBeNull();
    expect(checkTrigger("")).toBeNull();
    expect(checkTrigger("1e-7")).toMatch(/plain decimal/);
    expect(checkTrigger("0")).toMatch(/above zero/);
    expect(checkTrigger("-1")).toMatch(/plain decimal/);
    expect(checkTrigger("0.1234567890123456789")).toMatch(/18 significant/);
  });
  it("notes a trigger on the wrong side of the price", () => {
    expect(triggerNote("limit_buy", "0.000001", "0.0000011")).toMatch(/next check/);
    expect(triggerNote("limit_buy", "0.000001", "0.0000009")).toBeNull();
    expect(triggerNote("stop_loss", "0.000001", "0.000001")).toMatch(/two checks/);
    expect(triggerNote("take_profit", "0.000001", "0.0000009")).toMatch(/sell on the next check/);
    expect(triggerNote("limit_sell", "0.000001", "0.000002")).toBeNull();
  });
  it("ttl is 1..72 h", () => {
    expect(clampTtlHours(0, params)).toBe(1);
    expect(clampTtlHours(100, params)).toBe(72);
    expect(clampTtlHours(24, params)).toBe(24);
  });
});

describe("orders: same amount as a buy", () => {
  it("warns on a sell size matching a buy, or the whole position from one buy", () => {
    const buys = [BigInt(1_000_000), BigInt(5_000_000)];
    expect(sellMatchesBuy(BigInt(1_000_000), buys, BigInt(6_000_000))).toBe("buy");
    expect(sellMatchesBuy(BigInt(1_010_000), buys, null)).toBe("buy"); // within 1 % (A6)
    expect(sellMatchesBuy(BigInt(1_030_000), buys, null)).toBeNull(); // 3 % off: sent as signed
    expect(sellMatchesBuy(BigInt(3_000_000), buys, BigInt(6_000_000))).toBeNull();
    expect(sellMatchesBuy(BigInt(0), buys, null)).toBeNull();
    expect(sellMatchesBuy(BigInt(7_000_000), [BigInt(7_000_000)], BigInt(7_000_000))).toBe("position");
    // v0.17: the whole position (available + held) is rounded even with no buy of that size.
    expect(sellMatchesBuy(BigInt(6_000_000), [], BigInt(6_000_000))).toBe("position");
  });
});
