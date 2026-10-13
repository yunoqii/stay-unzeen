import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { signRequest, signerFromSecret } from "@/lib/crypto/sign";
import { unz1MemoString } from "@/lib/crypto/unz1";
import { depositFields, depositUri, poolChainId } from "@/lib/deposit";
import type { ActionReceipt, ActionStatus, FeedEvent, Portfolio, Token } from "./types";
import { handle, mockDepositPhase, mockPay, mockPool, subscribeFeed } from "./mock";

const SK = hexToBytes("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
const signer = signerFromSecret(SK);

async function portfolio(): Promise<Portfolio> {
  const path = "/api/portfolio";
  const p = handle("devnet", "GET", path, undefined, signRequest(signer, { chainId: "0202", method: "GET", pathWithQuery: path }));
  await vi.advanceTimersByTimeAsync(500);
  return (await p) as Portfolio;
}

describe("mock: Top up full cycle", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_760_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("GET /api/pool is public and per network", async () => {
    const p = handle("mainnet", "GET", "/api/pool", undefined, {});
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toEqual(mockPool("mainnet"));
  });

  it("portfolio needs a signature", async () => {
    const p = handle("devnet", "GET", "/api/portfolio", undefined, {});
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("waiting -> mempool -> confirming -> credited, balance grows", async () => {
    const pool = mockPool("devnet");
    const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, poolChainId(pool, "devnet"));
    const before = await portfolio();
    expect(before.zecBalance).toBe("0");

    mockPay("devnet", depositUri(pool, "25000000", memo));
    expect(mockDepositPhase("devnet", memo).phase).toBe("none");
    vi.advanceTimersByTime(2_000);
    expect(mockDepositPhase("devnet", memo).phase).toBe("mempool");
    vi.advanceTimersByTime(4_000);
    expect(mockDepositPhase("devnet", memo).phase).toBe("confirming");
    vi.advanceTimersByTime(10_000);
    expect(mockDepositPhase("devnet", memo).phase).toBe("credited");

    const after = await portfolio();
    expect(after.zecBalance).toBe("25000000");
    expect(after.deposits[0]).toMatchObject({ amountZat: "25000000", status: "credited" });
  });

  it("below minimum stays with the pool as dust", async () => {
    const pool = mockPool("devnet");
    const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, poolChainId(pool, "devnet"));
    const start = (await portfolio()).zecBalance;
    mockPay("devnet", depositUri(pool, "999999", memo));
    vi.advanceTimersByTime(20_000);
    expect(mockDepositPhase("devnet", memo).phase).toBe("dust");
    expect((await portfolio()).zecBalance).toBe(start);
  });

  it("a devnet memo paid on mainnet is frozen, not credited", async () => {
    const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, [2, 2]);
    mockPay("mainnet", depositUri(mockPool("mainnet"), "50000000", memo));
    vi.advanceTimersByTime(20_000);
    expect(mockDepositPhase("mainnet", memo).phase).toBe("frozen");
  });
});

describe("mock: actions from the balance", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_760_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, headers?: ReturnType<typeof signRequest>): Promise<T> {
    const b = body === undefined ? undefined : JSON.stringify(body);
    const h = headers ?? signRequest(signer, { chainId: "0202", method, pathWithQuery: path, body: b });
    const p = handle("devnet", method, path, b, h);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    return (await p) as T;
  }

  async function fund(zat: string) {
    const pool = mockPool("devnet");
    const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, poolChainId(pool, "devnet"));
    mockPay("devnet", depositUri(pool, zat, memo));
    vi.advanceTimersByTime(20_000);
  }

  it("top up -> buy -> trade in the feed and holdings -> withdraw tokens", async () => {
    await fund("50000000");
    const tokens = await call<Token[]>("GET", "/api/tokens");
    const t = tokens.find((x) => x.status === "curve" && x.venue === "pumpfun")!;
    const seen: FeedEvent[] = [];
    const unsub = subscribeFeed((e) => seen.push(e), t.mint);

    const before = await call<Portfolio>("GET", "/api/portfolio");
    const prevAmount = BigInt(before.holdings.find((h) => h.mint === t.mint)?.amount ?? "0");

    // below the minimum and more than the balance are refused without holding anything
    await expect(call("POST", "/api/actions", { op: "buy", venue: "pumpfun", mint: t.mint, zecIn: "1000", minOut: "0" })).rejects.toMatchObject({ code: "below_minimum" });
    await expect(call("POST", "/api/actions", { op: "buy", venue: "pumpfun", mint: t.mint, zecIn: "900000000000", minOut: "0" })).rejects.toMatchObject({ code: "insufficient_balance" });

    const buy = { op: "buy", venue: "pumpfun", mint: t.mint, zecIn: "10000000", minOut: "1" };
    const headers = signRequest(signer, { chainId: "0202", method: "POST", pathWithQuery: "/api/actions", body: JSON.stringify(buy) });
    const receipt = await call<ActionReceipt>("POST", "/api/actions", buy, headers);
    expect(receipt).toMatchObject({ status: "queued", rate: { source: "fixed" } });
    // retry with the same signed bytes -> same receipt, nothing held twice
    expect((await call<ActionReceipt>("POST", "/api/actions", buy, headers)).id).toBe(receipt.id);
    const held = await call<Portfolio>("GET", "/api/portfolio");
    expect(BigInt(held.zecBalance)).toBe(BigInt(before.zecBalance) - BigInt(10_000_000));
    expect(held.zecHeld).toBe("10000000");

    await vi.advanceTimersByTimeAsync(10_000);
    const st = await call<ActionStatus>("GET", `/api/actions/${receipt.id}`);
    expect(st.status).toBe("executed");
    expect(st.solanaTx).toBeTruthy();
    const got = BigInt(st.fill!.tokenAmount);
    expect(got > BigInt(0)).toBe(true);
    expect(seen.some((e) => e.kind === "buy" && e.solanaTx === st.solanaTx)).toBe(true);

    const after = await call<Portfolio>("GET", "/api/portfolio");
    expect(after.zecHeld).toBe("0");
    expect(BigInt(after.holdings.find((h) => h.mint === t.mint)!.amount)).toBe(prevAmount + got);

    // withdraw: bad address refused; then all of it to a fresh address
    await expect(call("POST", "/api/actions", { op: "withdraw_token", mint: t.mint, amount: got.toString(), to: "nope" })).rejects.toMatchObject({ code: "bad_request" });
    const total = (prevAmount + got).toString();
    const w = await call<ActionReceipt>("POST", "/api/actions", {
      op: "withdraw_token",
      mint: t.mint,
      amount: total,
      to: ["So11111111111111111111111111111111111111112", "11111111111111111111111111111111"],
      smart: { parts: 2, maxDelayMin: 5 },
    });
    const mid = await call<Portfolio>("GET", "/api/portfolio");
    // v0.17 (A1): shaved 0.5–2 %, split, each part rounded to 3 significant digits; the rest stays available.
    const ws = await call<ActionStatus>("GET", `/api/actions/${w.id}`);
    expect(ws.parts).toHaveLength(2);
    const sent = ws.parts!.reduce((n, p) => n + BigInt(p.amount), BigInt(0));
    for (const p of ws.parts!) {
      expect(p.status).toBe("queued");
      expect(p.notBefore % 1000).toBe(0);
      expect(BigInt(p.amount).toString().replace(/0+$/, "").length).toBeLessThanOrEqual(3);
    }
    expect(sent < BigInt(total)).toBe(true);
    expect(sent * BigInt(1000) >= BigInt(total) * BigInt(975)).toBe(true); // at most ~2 % + rounding
    const h = mid.holdings.find((x) => x.mint === t.mint)!;
    expect(h).toMatchObject({ held: sent.toString(), amount: (BigInt(total) - sent).toString() });
    expect(BigInt(mid.zecBalance) < BigInt(after.zecBalance)).toBe(true); // gas paid in ZEC
    // Parts are owner-only on GET /api/actions/:id, never in the portfolio.
    expect(JSON.stringify(mid.actions ?? [])).not.toContain("notBefore");

    await vi.advanceTimersByTimeAsync(40_000);
    const done = await call<ActionStatus>("GET", `/api/actions/${w.id}`);
    expect(done.status).toBe("executed");
    expect(done.fill!.tokenAmount).toBe(sent.toString());
    expect(done.parts!.every((p) => p.status === "confirmed")).toBe(true);
    expect((await call<Portfolio>("GET", "/api/portfolio")).holdings.find((x) => x.mint === t.mint)).toMatchObject({ amount: (BigInt(total) - sent).toString(), held: "0" });
    unsub();
  });

  it("sell below the slippage limit fails and returns the tokens", async () => {
    await fund("50000000");
    const t = (await call<Token[]>("GET", "/api/tokens")).find((x) => x.status === "curve")!;
    const r = await call<ActionReceipt>("POST", "/api/actions", { op: "buy", venue: t.venue, mint: t.mint, zecIn: "5000000", minOut: "0" });
    await vi.advanceTimersByTimeAsync(10_000);
    const got = (await call<ActionStatus>("GET", `/api/actions/${r.id}`)).fill!.tokenAmount;
    const s = await call<ActionReceipt>("POST", "/api/actions", { op: "sell", venue: t.venue, mint: t.mint, amount: got, minZecOut: "999999999" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await call<ActionStatus>("GET", `/api/actions/${s.id}`)).toMatchObject({ status: "failed", error: "slippage" });
    const p = await call<Portfolio>("GET", "/api/portfolio");
    expect(BigInt(p.holdings.find((h) => h.mint === t.mint)!.amount) >= BigInt(got)).toBe(true);
  });

  it("graduated tokens are refused on their curve venue", async () => {
    await fund("50000000");
    const g = (await call<Token[]>("GET", "/api/tokens")).find((x) => x.status === "graduated")!;
    await expect(call("POST", "/api/actions", { op: "buy", venue: g.venue, mint: g.mint, zecIn: "1000000", minOut: "0" })).rejects.toMatchObject({ code: "graduated" });
  });

  it("withdraw_zec accepts only a shielded UA of this network", async () => {
    await fund("50000000");
    await expect(call("POST", "/api/actions", { op: "withdraw_zec", to: "tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU", amount: "1000000" })).rejects.toMatchObject({ code: "bad_request" });
  });
});
