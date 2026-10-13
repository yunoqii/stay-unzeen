// Mock of docs/API.md v0.8: private orders (order_create / order_cancel, Portfolio.orders, PoolInfo.orders)
// and creator fees (claim, Portfolio.claimable, kind "claim" in actions).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { signRequest, signerFromSecret } from "@/lib/crypto/sign";
import { unz1MemoString } from "@/lib/crypto/unz1";
import { depositFields, depositUri, poolChainId } from "@/lib/deposit";
import type { ActionReceipt, ActionStatus, CreatorCabinet, Order, PlatformStats, Portfolio, Token } from "./types";
import { handle, MOCK_FEE_SWEEP_MS, MOCK_ORDER_TICK_MS, mockCreditCreatorFees, mockPay, mockPool, mockResetStats, mockSetPrice } from "./mock";

// A fresh anon key per test: the mock keeps accounts for the whole file.
let SK = hexToBytes("2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db186d6e90");
let signer = signerFromSecret(SK);
beforeEach(() => {
  SK = crypto.getRandomValues(new Uint8Array(32));
  signer = signerFromSecret(SK);
});

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, headers?: ReturnType<typeof signRequest>): Promise<T> {
  const b = body === undefined ? undefined : JSON.stringify(body);
  const h = headers ?? signRequest(signer, { chainId: "0202", method, pathWithQuery: path, body: b });
  const p = handle("devnet", method, path, b, h);
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(500);
  return (await p) as T;
}
const portfolio = () => call<Portfolio>("GET", "/api/portfolio");
const post = <T = ActionReceipt>(body: unknown) => call<T>("POST", "/api/actions", body);

async function fund(zat: string) {
  const pool = mockPool("devnet");
  const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, poolChainId(pool, "devnet"));
  mockPay("devnet", depositUri(pool, zat, memo));
  vi.advanceTimersByTime(20_000);
}

/** Advance to just past the next indexer tick, then poll (the mock runs ticks on its fixed schedule). */
async function nextTick(): Promise<Portfolio> {
  vi.advanceTimersByTime(MOCK_ORDER_TICK_MS);
  return portfolio();
}

async function curveTokens(): Promise<Token[]> {
  return (await call<Token[]>("GET", "/api/tokens")).filter((t) => t.venue === "pumpfun" && t.status === "curve");
}

async function buy(mint: string, zat = "10000000"): Promise<bigint> {
  const r = await post({ op: "buy", venue: "pumpfun", mint, zecIn: zat, minOut: "0", exec: "now" });
  await vi.advanceTimersByTimeAsync(5_000);
  return BigInt((await call<ActionStatus>("GET", `/api/actions/${r.id}`)).fill!.tokenAmount);
}

const orderOf = (p: Portfolio, id: string): Order => p.orders!.find((o) => o.id === id)!;

describe("mock v0.8: private orders", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_760_500_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("PoolInfo.orders carries the limits", () => {
    expect(mockPool("devnet").orders).toMatchObject({ maxOpenPerKey: 10, maxOpenPerMint: 4, maxTtlSecs: 259_200, defaultTtlSecs: 86_400, slConfirmTicks: 2, venues: ["pumpfun"] });
  });

  it("create holds, retry is idempotent, cancel releases, second cancel is order_not_open", async () => {
    await fund("100000000");
    const [t] = await curveTokens();
    const before = await portfolio();
    const body = { op: "order_create", venue: "pumpfun", mint: t.mint, kind: "limit_buy", triggerPriceSol: "0.0000000001", amount: "2000000", ttlSecs: 7200, exec: "max" };
    const headers = signRequest(signer, { chainId: "0202", method: "POST", pathWithQuery: "/api/actions", body: JSON.stringify(body) });
    const r = await call<ActionReceipt>("POST", "/api/actions", body, headers);
    expect(r).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), status: "open" });
    expect((await call<ActionReceipt>("POST", "/api/actions", body, headers)).id).toBe(r.id);

    const p = await portfolio();
    expect(p.orders).toHaveLength(1);
    const o = orderOf(p, r.id);
    expect(o).toMatchObject({ kind: "limit_buy", amount: "2000000", exec: "max", status: "open", slippageBps: 500 });
    expect(o.expiresAt % 3_600_000).toBe(0); // rounded up to the hour
    expect(o.expiresAt).toBeGreaterThanOrEqual(Date.now() + 7_000_000);
    expect(BigInt(p.zecBalance)).toBe(BigInt(before.zecBalance) - BigInt(2_000_000));
    expect(p.zecHeld).toBe("2000000");
    // orders never show up as actions
    expect(p.actions!.some((a) => a.id === r.id)).toBe(false);

    expect(await post({ op: "order_cancel", orderId: r.id })).toEqual({ id: r.id, status: "cancelled" });
    const after = await portfolio();
    expect(after.zecBalance).toBe(before.zecBalance);
    expect(after.zecHeld).toBe("0");
    expect(orderOf(after, r.id).status).toBe("cancelled");
    await expect(post({ op: "order_cancel", orderId: r.id })).rejects.toMatchObject({ code: "order_not_open", status: 409 });
    await expect(post({ op: "order_cancel", orderId: "00".repeat(16) })).rejects.toMatchObject({ code: "not_found" });
  });

  it("validation: unsupported mints, exec now, ttl, trigger format, balance", async () => {
    await fund("50000000");
    const all = await call<Token[]>("GET", "/api/tokens");
    const graduated = all.find((t) => t.venue === "pumpfun" && t.status === "graduated")!;
    const meteora = all.find((t) => t.venue === "meteora-dbc" && t.status === "curve")!;
    const [t] = await curveTokens();
    const base = { op: "order_create", venue: "pumpfun", mint: t.mint, kind: "limit_buy", triggerPriceSol: "0.0000001", amount: "1000000" };
    await expect(post({ ...base, mint: graduated.mint })).rejects.toMatchObject({ code: "order_unsupported_mint", status: 422 });
    await expect(post({ ...base, mint: meteora.mint })).rejects.toMatchObject({ code: "order_unsupported_mint" });
    await expect(post({ ...base, exec: "now" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(post({ ...base, ttlSecs: 600 })).rejects.toMatchObject({ code: "bad_request" });
    await expect(post({ ...base, ttlSecs: 300_000 })).rejects.toMatchObject({ code: "bad_request" });
    await expect(post({ ...base, triggerPriceSol: "1e-7" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(post({ ...base, triggerPriceSol: "0" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(post({ ...base, slippageBps: 10 })).rejects.toMatchObject({ code: "bad_request" });
    await expect(post({ ...base, amount: "1000" })).rejects.toMatchObject({ code: "below_minimum" });
    await expect(post({ ...base, amount: "900000000000" })).rejects.toMatchObject({ code: "insufficient_balance" });
    await expect(post({ ...base, kind: "limit_sell", amount: "999999999999999" })).rejects.toMatchObject({ code: "insufficient_balance" });
    expect((await portfolio()).zecHeld).toBe("0"); // nothing held by refused orders
  });

  it("limits: 4 open per mint, 10 open per key (order_limit), cancelled ones free a slot", async () => {
    await fund("500000000");
    const toks = await curveTokens();
    expect(toks.length).toBeGreaterThanOrEqual(3);
    const make = (mint: string) => post({ op: "order_create", venue: "pumpfun", mint, kind: "limit_buy", triggerPriceSol: "0.0000000001", amount: "100000" });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await make(toks[0].mint)).id);
    await expect(make(toks[0].mint)).rejects.toMatchObject({ code: "order_limit", status: 422 });
    for (let i = 0; i < 4; i++) await make(toks[1].mint);
    for (let i = 0; i < 2; i++) await make(toks[2].mint);
    await expect(make(toks[2].mint)).rejects.toMatchObject({ code: "order_limit" }); // 10 per key
    await post({ op: "order_cancel", orderId: ids[0] });
    await expect(make(toks[2].mint)).resolves.toMatchObject({ status: "open" });
  });

  it("stop-loss arms on the first tick at or below the trigger and fires on the second", async () => {
    await fund("100000000");
    const [t] = await curveTokens();
    const got = await buy(t.mint);
    const p0 = Number(t.priceSol);
    const amount = (got / BigInt(2)).toString();
    const r = await post({ op: "order_create", venue: "pumpfun", mint: t.mint, kind: "stop_loss", triggerPriceSol: (p0 * 0.9).toFixed(15), amount });
    let p = await portfolio();
    expect(p.holdings.find((h) => h.mint === t.mint)!.held).toBe(amount);
    expect(orderOf(p, r.id).slippageBps).toBe(1500);

    // A dip on one tick only: armed, then disarmed when the price recovers.
    mockSetPrice(t.mint, p0 * 0.8);
    p = await nextTick();
    expect(orderOf(p, r.id)).toMatchObject({ status: "open", armed: true });
    mockSetPrice(t.mint, p0);
    p = await nextTick();
    expect(orderOf(p, r.id).status).toBe("open");
    expect(orderOf(p, r.id).armed).toBeUndefined();

    // Two ticks in a row: triggered into an ordinary batched sell.
    mockSetPrice(t.mint, p0 * 0.8);
    p = await nextTick();
    expect(orderOf(p, r.id).armed).toBe(true);
    p = await nextTick();
    const o = orderOf(p, r.id);
    expect(o.status).toBe("triggered");
    expect(o.actionId).toMatch(/^[0-9a-f]{32}$/);
    const act = p.actions!.find((a) => a.id === o.actionId)!;
    expect(act).toMatchObject({ kind: "sell", status: "queued" });

    await vi.advanceTimersByTimeAsync(20_000);
    p = await portfolio();
    expect(orderOf(p, r.id).status).toBe("filled");
    expect(p.actions!.find((a) => a.id === o.actionId)).toMatchObject({ status: "executed", fill: { tokenAmount: amount } });
    expect(p.holdings.find((h) => h.mint === t.mint)!.held).toBe("0");
  });

  it("limit buy triggers when the price falls to it and fills; take-profit sells above", async () => {
    await fund("100000000");
    const [, t] = await curveTokens();
    const got = await buy(t.mint);
    const p0 = Number(t.priceSol);
    const lb = await post({ op: "order_create", venue: "pumpfun", mint: t.mint, kind: "limit_buy", triggerPriceSol: (p0 * 0.95).toFixed(15), amount: "5000000" });
    const tp = await post({ op: "order_create", venue: "pumpfun", mint: t.mint, kind: "take_profit", triggerPriceSol: (p0 * 1.5).toFixed(15), amount: got.toString() });
    let p = await nextTick();
    expect(orderOf(p, lb.id).status).toBe("open");
    mockSetPrice(t.mint, p0 * 0.9);
    p = await nextTick();
    expect(orderOf(p, lb.id).status).toBe("triggered");
    expect(orderOf(p, tp.id).status).toBe("open");
    await vi.advanceTimersByTimeAsync(20_000);
    p = await portfolio();
    expect(orderOf(p, lb.id).status).toBe("filled");

    mockSetPrice(t.mint, p0 * 1.6);
    p = await nextTick();
    expect(orderOf(p, tp.id).status).toBe("triggered");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(orderOf(await portfolio(), tp.id).status).toBe("filled");
  });

  it("expires after its TTL and the hold returns", async () => {
    await fund("50000000");
    const [t] = await curveTokens();
    const before = await portfolio();
    const r = await post({ op: "order_create", venue: "pumpfun", mint: t.mint, kind: "limit_buy", triggerPriceSol: "0.0000000001", amount: "3000000", ttlSecs: 3600 });
    vi.advanceTimersByTime(2 * 3_600_000);
    const p = await nextTick();
    expect(orderOf(p, r.id).status).toBe("expired");
    expect(p.zecBalance).toBe(before.zecBalance);
    expect(p.zecHeld).toBe("0");
    // erased from the list 24 h after closing
    vi.advanceTimersByTime(25 * 3_600_000);
    expect((await portfolio()).orders!.some((o) => o.id === r.id)).toBe(false);
  });
});

describe("mock v0.7/v0.8: creator fees claim", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_760_600_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("claimable -> claim credits ZEC at the sell rate, ledger only, kind claim", async () => {
    await fund("10000000");
    const [t, u] = await curveTokens();
    await expect(post({ op: "claim" })).rejects.toMatchObject({ code: "below_minimum" });
    mockCreditCreatorFees("devnet", signer.pubkey, t.mint, BigInt(50_000_000));
    mockCreditCreatorFees("devnet", signer.pubkey, u.mint, BigInt(100)); // dust
    let p = await portfolio();
    expect(p.claimable).toEqual(expect.arrayContaining([
        { mint: t.mint, solAmount: "50000000", zecAmount: "0" },
        { mint: u.mint, solAmount: "100", zecAmount: "0" },
      ]));
    await expect(post({ op: "claim", mint: u.mint })).rejects.toMatchObject({ code: "below_minimum" });

    const rate = BigInt(mockPool("devnet").rate!.lamportsPerZecSell);
    const r = await post({ op: "claim", mint: t.mint });
    expect(r).toMatchObject({ status: "executed", rate: { source: "fixed" } });
    const credited = (BigInt(50_000_000) * BigInt(100_000_000)) / rate;
    p = await portfolio();
    expect(BigInt(p.zecBalance)).toBe(BigInt(10_000_000) + credited);
    expect(p.claimable).toEqual([{ mint: u.mint, solAmount: "100", zecAmount: "0" }]);
    expect(p.actions!.find((a) => a.id === r.id)).toMatchObject({ kind: "claim", status: "executed" });
    expect((await call<ActionStatus>("GET", `/api/actions/${r.id}`)).status).toBe("executed");
  });

  it("fees from trades on your launch reach claimable on the collector's schedule", async () => {
    await fund("100000000");
    const c = await post({ op: "create", venue: "pumpfun", meta: { name: "Fee Test", symbol: "FEE" }, initialBuyZec: "5000000", exec: "now" });
    await vi.advanceTimersByTimeAsync(5_000);
    const mint = (await call<ActionStatus>("GET", `/api/actions/${c.id}`)).fill!.mint!;
    await buy(mint, "20000000");
    expect((await portfolio()).claimable).toEqual([]); // not before the collector runs
    vi.advanceTimersByTime(MOCK_FEE_SWEEP_MS);
    const p = await portfolio();
    expect(p.claimable).toHaveLength(1);
    expect(p.claimable[0].mint).toBe(mint);
    expect(BigInt(p.claimable[0].solAmount) > BigInt(0)).toBe(true);
  });
});

describe("mock v0.9: creator cabinet and daily stats", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_760_800_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("GET /api/creator: own launches only, padded to 4096 bytes, lock / cap / fees after claim", async () => {
    const empty = await call<CreatorCabinet>("GET", "/api/creator");
    expect(empty.tokens).toEqual([]);
    expect(JSON.stringify(empty).length).toBe(4096);
    await expect(call("GET", "/api/creator", undefined, {} as ReturnType<typeof signRequest>)).rejects.toMatchObject({ code: "unauthorized" });

    await fund("100000000");
    const c = await post({ op: "create", venue: "pumpfun", meta: { name: "Cabinet", symbol: "CAB" }, initialBuyZec: "5000000", exec: "now" });
    await vi.advanceTimersByTimeAsync(5_000);
    const st = await call<ActionStatus>("GET", `/api/actions/${c.id}`);
    const mint = st.fill!.mint!;
    mockCreditCreatorFees("devnet", signer.pubkey, mint, BigInt(40_000_000));
    const cab = await call<CreatorCabinet>("GET", "/api/creator");
    expect(JSON.stringify(cab).length % 4096).toBe(0);
    expect(cab.tokens).toHaveLength(1);
    const t = cab.tokens[0];
    expect(t).toMatchObject({ mint, symbol: "CAB", venue: "pumpfun", status: "curve", fees: { claimableLamports: "40000000", claimedLamports: "0", claimableZat: "0", claimedZat: "0" } });
    expect(t.lock.lockedAmount).toBe(st.fill!.tokenAmount);
    expect(t.lock.until! % 3_600_000).toBe(0);
    expect(t.cap.capBps).toBe(500);
    expect(BigInt(t.cap.positionTokens)).toBe(BigInt(st.fill!.tokenAmount));

    await post({ op: "claim", mint });
    const after = (await call<CreatorCabinet>("GET", "/api/creator")).tokens[0];
    expect(after.fees).toEqual({ claimableLamports: "0", claimedLamports: "40000000", claimableZat: "0", claimedZat: "0" });
    // the lock ends after 24 h
    vi.advanceTimersByTime(25 * 3_600_000);
    expect((await call<CreatorCabinet>("GET", "/api/creator")).tokens[0].lock).toEqual({ lockedAmount: "0", until: null });

    // another key sees nothing of it
    signer = signerFromSecret(crypto.getRandomValues(new Uint8Array(32)));
    expect((await call<CreatorCabinet>("GET", "/api/creator")).tokens).toEqual([]);
  });

  it("GET /api/stats: daily, frozen, k-anonymous", async () => {
    mockResetStats();
    const s = await call<PlatformStats>("GET", "/api/stats");
    expect(s.asOf % 86_400_000).toBe(0);
    expect(s.asOf).toBeLessThanOrEqual(Date.now());
    expect(s.topWindowDays).toBe(7);
    expect(Object.keys(s.byVenue).sort()).toEqual(["jupiter", "meteora-dbc", "pumpfun"]);
    expect(s.byVenue.jupiter).toEqual({ volumeSol: "<5", trades: "<5", launches: "<5" });
    for (const t of s.topTokens) expect(t.trades).toBeGreaterThanOrEqual(5);
    expect(typeof s.trades === "number" || s.trades === "<5").toBe(true);
    // a trade later the same day changes nothing
    await fund("50000000");
    const [t] = await curveTokens();
    await buy(t.mint);
    expect(await call<PlatformStats>("GET", "/api/stats")).toEqual(s);
    // next UTC day: a new snapshot
    vi.advanceTimersByTime(86_400_000);
    expect((await call<PlatformStats>("GET", "/api/stats")).asOf).toBe(s.asOf + 86_400_000);
  });
});
