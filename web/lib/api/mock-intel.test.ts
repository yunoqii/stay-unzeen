import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base58 } from "@scure/base";
import { handle, nextTick } from "./mock";
import { isPending, type PendingResponse, type Token, type TokenSafety, type TokenTrade, type TokenWithTrades } from "./types";

async function get<T>(path: string): Promise<T> {
  const p = handle("devnet", "GET", path, undefined, {});
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(500);
  return (await p) as T;
}

const coldMint = () => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  b[0] |= 1;
  return base58.encode(b);
};

describe("mock token intel (DRAFT contract)", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_760_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("a cold mint is 202 pending until the fixed tick, the same for every caller, then resolves", async () => {
    const mint = coldMint();
    const a = await get<PendingResponse>(`/api/tokens/${mint}`);
    expect(isPending(a)).toBe(true);
    const b = await get<PendingResponse>(`/api/tokens/${mint}/safety`);
    expect(isPending(b)).toBe(true);
    // both answers point at the same tick boundary, which does not depend on the request time
    const tick = nextTick(Date.now() - 1);
    expect(Math.abs(Date.now() + b.retryAfterMs - tick)).toBeLessThan(1_500);
    await vi.advanceTimersByTimeAsync(a.retryAfterMs + 10);
    const t = await get<TokenWithTrades>(`/api/tokens/${mint}`);
    expect(t.mint).toBe(mint);
    expect(t.trades).toEqual([]);
    const s = await get<TokenSafety>(`/api/tokens/${mint}/safety`);
    expect(s.mint).toBe(mint);
    expect(s.asOf % 60_000).toBe(0); // rounded to the tick, not the moment of the first request
  });

  it("a searched mint never shows up in the public token list", async () => {
    const mint = coldMint();
    const p = await get<PendingResponse>(`/api/tokens/${mint}`);
    await vi.advanceTimersByTimeAsync(p.retryAfterMs + 10);
    await get(`/api/tokens/${mint}`);
    const list = await get<Token[]>("/api/tokens");
    expect(list.some((t) => t.mint === mint)).toBe(false);
  });

  it("bad base58 is 400", async () => {
    await expect(get("/api/tokens/not-a-mint/safety")).rejects.toMatchObject({ code: "bad_request" });
  });

  it("an Unzeen launch: rules badge, no dev, no dev share (T1)", async () => {
    const list = await get<Token[]>("/api/tokens");
    const ghost = list.find((t) => t.symbol === "GHOST")!;
    const s = await get<TokenSafety>(`/api/tokens/${ghost.mint}/safety`);
    expect(s.unzeen?.launch).toBe(true);
    expect(s.unzeen?.rules).toContain("creator_initial_buy_locked_24h");
    expect(s.dev).toBeUndefined();
    expect(s.holders?.devPct).toBeNull();
    expect(s.image).toBeUndefined();
  });

  it("trades with filter: unzeen trades carry trader 'unzeen'; whales / dev need the full feed", async () => {
    const list = await get<Token[]>("/api/tokens");
    const pepe = list.find((t) => t.symbol === "PEPE")!;
    const trades = await get<TokenTrade[]>(`/api/tokens/${pepe.mint}/trades?filter=all&limit=20`);
    expect(trades.every((t) => t.trader === "unzeen" && Array.isArray(t.tags) && !t.tags.includes("dev"))).toBe(true);
    await expect(get(`/api/tokens/${pepe.mint}/trades?filter=whales`)).rejects.toMatchObject({ code: "feature_disabled" });
  });
});
