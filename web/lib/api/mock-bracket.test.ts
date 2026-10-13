// Mock of docs/API.md v0.15: bracket orders (TP + SL on one hold, OCO) and rearm after slippage.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signRequest, signerFromSecret } from "@/lib/crypto/sign";
import { unz1MemoString } from "@/lib/crypto/unz1";
import { depositFields, depositUri, poolChainId } from "@/lib/deposit";
import type { ActionReceipt, ActionStatus, Order, Portfolio, Token } from "./types";
import { handle, MOCK_ORDER_TICK_MS, mockPay, mockPool, mockSetPrice } from "./mock";

let SK = crypto.getRandomValues(new Uint8Array(32));
let signer = signerFromSecret(SK);
beforeEach(() => {
  SK = crypto.getRandomValues(new Uint8Array(32));
  signer = signerFromSecret(SK);
  vi.useFakeTimers({ now: 1_760_800_000_000 });
});
afterEach(() => vi.useRealTimers());

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const b = body === undefined ? undefined : JSON.stringify(body);
  const h = signRequest(signer, { chainId: "0202", method, pathWithQuery: path, body: b });
  const p = handle("devnet", method, path, b, h);
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(500);
  return (await p) as T;
}
const portfolio = () => call<Portfolio>("GET", "/api/portfolio");
const post = <T = ActionReceipt>(body: unknown) => call<T>("POST", "/api/actions", body);
const orderOf = (p: Portfolio, id: string): Order => p.orders!.find((o) => o.id === id)!;
async function nextTick() {
  vi.advanceTimersByTime(MOCK_ORDER_TICK_MS);
  return portfolio();
}
async function fund(zat: string) {
  const pool = mockPool("devnet");
  const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, poolChainId(pool, "devnet"));
  mockPay("devnet", depositUri(pool, zat, memo));
  vi.advanceTimersByTime(20_000);
}
/** A SOL-paired pump.fun token on the curve, bought once so there is something to sell. */
async function position(i = 0): Promise<{ t: Token; got: bigint }> {
  await fund("100000000");
  const t = (await call<Token[]>("GET", "/api/tokens")).filter((x) => x.venue === "pumpfun" && x.status === "curve" && x.quote === "SOL")[i];
  const r = await post({ op: "buy", venue: "pumpfun", mint: t.mint, zecIn: "10000000", minOut: "0", exec: "now" });
  await vi.advanceTimersByTimeAsync(5_000);
  const got = BigInt((await call<ActionStatus>("GET", `/api/actions/${r.id}`)).fill!.tokenAmount);
  return { t, got };
}
const px = (n: number) => n.toFixed(15);

describe("mock v0.15: PoolInfo.orders", () => {
  it("lists bracket, its default slippage and maxRearms", () => {
    const o = mockPool("devnet").orders!;
    expect(o.kinds).toContain("bracket");
    expect(o.defaultSlippageBps.bracket).toBe(500);
    expect(o.maxRearms).toBe(3);
  });
});

describe("mock v0.15: bracket", () => {
  it("validates: no triggerPriceSol, both legs, tp above sl", async () => {
    const { t, got } = await position();
    const base = { op: "order_create", venue: "pumpfun", mint: t.mint, kind: "bracket", amount: (got / BigInt(2)).toString() };
    const p0 = Number(t.priceSol);
    await expect(post({ ...base, triggerPriceSol: px(p0 * 2), tpPriceSol: px(p0 * 2), slPriceSol: px(p0 / 2) })).rejects.toMatchObject({ code: "bad_request" });
    await expect(post({ ...base, tpPriceSol: px(p0 * 2) })).rejects.toMatchObject({ code: "bad_request" });
    await expect(post({ ...base, tpPriceSol: px(p0 / 2), slPriceSol: px(p0 * 2) })).rejects.toMatchObject({ code: "bad_request" });
    await expect(post({ op: "order_create", venue: "pumpfun", mint: t.mint, kind: "take_profit", amount: "1", triggerPriceSol: px(p0 * 2), slPriceSol: px(p0) })).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("one hold for both legs; TP fires first and cancels SL (leg tp); counts as one order", async () => {
    const { t, got } = await position();
    const p0 = Number(t.priceSol);
    const amount = (got / BigInt(2)).toString();
    const r = await post({ op: "order_create", venue: "pumpfun", mint: t.mint, kind: "bracket", tpPriceSol: px(p0 * 1.5), slPriceSol: px(p0 * 0.8), amount });
    let p = await portfolio();
    expect(p.holdings.find((h) => h.mint === t.mint)!.held).toBe(amount);
    expect(orderOf(p, r.id)).toMatchObject({ kind: "bracket", slippageBps: 500, slSlippageBps: 1500, rearms: 0, status: "open", triggerPriceSol: px(p0 * 1.5) });
    expect(p.orders!.filter((o) => o.status === "open")).toHaveLength(1);

    // SL arms on a dip, a TP hit on the next tick resets the arming and fires the TP leg.
    mockSetPrice(t.mint, p0 * 0.75);
    p = await nextTick();
    expect(orderOf(p, r.id).armed).toBe(true);
    mockSetPrice(t.mint, p0 * 1.6);
    p = await nextTick();
    expect(orderOf(p, r.id)).toMatchObject({ status: "triggered", leg: "tp" });
    await vi.advanceTimersByTimeAsync(20_000);
    p = await portfolio();
    expect(orderOf(p, r.id)).toMatchObject({ status: "filled", leg: "tp" });
    expect(p.holdings.find((h) => h.mint === t.mint)!.held).toBe("0");
  });

  it("SL leg fires after two ticks at or below sl (leg sl)", async () => {
    const { t, got } = await position(1);
    const p0 = Number(t.priceSol);
    const r = await post({ op: "order_create", venue: "pumpfun", mint: t.mint, kind: "bracket", tpPriceSol: px(p0 * 2), slPriceSol: px(p0 * 0.9), amount: (got / BigInt(2)).toString() });
    mockSetPrice(t.mint, p0 * 0.85);
    let p = await nextTick();
    expect(orderOf(p, r.id)).toMatchObject({ status: "open", armed: true });
    p = await nextTick();
    expect(orderOf(p, r.id)).toMatchObject({ status: "triggered", leg: "sl" });
  });
});

describe("mock v0.15: rearm after slippage", () => {
  it("a stop-loss whose guard misses goes back to open with the same hold, up to maxRearms, then fails", async () => {
    const { t, got } = await position(2);
    const p0 = Number(t.priceSol);
    const amount = (got / BigInt(2)).toString();
    const r = await post({ op: "order_create", venue: "pumpfun", mint: t.mint, kind: "stop_loss", triggerPriceSol: px(p0 * 0.9), slippageBps: 100, amount, rearm: true });
    let p = await portfolio();
    expect(orderOf(p, r.id)).toMatchObject({ rearm: true, rearms: 0 });
    // A crash far below trigger · (1 − 1 %): the guard refuses to sell.
    mockSetPrice(t.mint, p0 * 0.5);
    for (let i = 1; i <= 3; i++) {
      p = await nextTick(); // arm
      p = await nextTick(); // fire -> guard miss -> re-armed
      expect(orderOf(p, r.id)).toMatchObject({ status: "open", rearms: i });
      expect(orderOf(p, r.id).actionId).toBeUndefined();
      expect(p.holdings.find((h) => h.mint === t.mint)!.held).toBe(amount);
    }
    p = await nextTick();
    p = await nextTick();
    expect(orderOf(p, r.id)).toMatchObject({ status: "failed", error: "slippage", rearms: 3 });
    expect(p.holdings.find((h) => h.mint === t.mint)!.held).toBe("0");
  });

  it("without rearm a guard miss fails at once and releases the hold", async () => {
    const { t, got } = await position(0);
    const p0 = Number(t.priceSol);
    const r = await post({ op: "order_create", venue: "pumpfun", mint: t.mint, kind: "stop_loss", triggerPriceSol: px(p0 * 0.9), slippageBps: 100, amount: (got / BigInt(2)).toString() });
    mockSetPrice(t.mint, p0 * 0.5);
    await nextTick();
    const p = await nextTick();
    expect(orderOf(p, r.id)).toMatchObject({ status: "failed", error: "slippage", rearms: 0 });
    expect(p.holdings.find((h) => h.mint === t.mint)!.held).toBe("0");
  });
});
