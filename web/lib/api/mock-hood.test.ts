// Robinhood Chain origin of the mock (API v0.18, build flag NEXT_PUBLIC_HOOD=1): chainId 0111 signatures,
// PoolInfo.chain, Pons venue, 0x EIP-55 mints, 18-decimal amounts past 2^53 as integer strings only.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionReceipt, ActionStatus, PoolInfo, Portfolio, TokenListItem } from "./types";

process.env.NEXT_PUBLIC_HOOD = "1";
type MockModule = typeof import("./mock");
let mock: MockModule;
let keys: typeof import("@/lib/crypto/keys");
let sign: typeof import("@/lib/crypto/sign");
let unz1: typeof import("@/lib/crypto/unz1");
let deposit: typeof import("@/lib/deposit");
let evm: typeof import("@/lib/evm");

beforeAll(async () => {
  vi.resetModules();
  mock = await import("./mock");
  keys = await import("@/lib/crypto/keys");
  sign = await import("@/lib/crypto/sign");
  unz1 = await import("@/lib/crypto/unz1");
  deposit = await import("@/lib/deposit");
  evm = await import("@/lib/evm");
  // Load the hood chunk once on the real clock (a dynamic import under fake timers can outlast the test).
  await mock.handle("hood", "GET", "/api/pool", undefined, {});
});

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
let secret: Uint8Array;

beforeEach(async () => {
  vi.useFakeTimers({ now: 1_791_763_200_000 });
  secret = (await keys.keypairFromMnemonic(PHRASE, "hood")).secretKey;
});
afterEach(() => vi.useRealTimers());

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, chainId = "0111"): Promise<T> {
  const b = body === undefined ? undefined : JSON.stringify(body);
  const h = sign.signRequest(sign.signerFromSecret(secret), { chainId, method, pathWithQuery: path, body: b });
  const p = mock.handle("hood", method, path, b, h);
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  // The hood chunk loads with a real dynamic import: keep the fake clock moving until the answer is in.
  for (let i = 0; i < 50 && !done; i++) await vi.advanceTimersByTimeAsync(100);
  return (await p) as T;
}

describe("mock v0.18: Robinhood Chain origin", () => {
  it("pool: chainId 0111, chain hood with ETH (18), Pons only, Zcash mainnet UA", async () => {
    const pool = await call<PoolInfo>("GET", "/api/pool");
    expect(pool.chainId).toBe("0111");
    expect(pool.network).toBe("main");
    expect(pool.chain).toEqual({ id: "hood", network: "hood", mainnet: true, native: { symbol: "ETH", decimals: 18 }, evmChainId: 4663, priceMaxAgeSecs: 300 });
    expect(pool.venues?.map((v) => v.venue)).toEqual(["pons"]);
    expect(pool.address.startsWith("u1")).toBe(true);
    expect(pool.features?.scenarios).toBeUndefined();
  });

  it("tokens: EIP-55 0x mints, 18 decimals, venue pons", async () => {
    const list = await call<TokenListItem[]>("GET", "/api/tokens");
    expect(list.length).toBeGreaterThan(3);
    for (const t of list) {
      expect(t.venue).toBe("pons");
      expect(t.decimals).toBe(18);
      expect(evm.toChecksumAddress(t.mint)).toBe(t.mint);
    }
  });

  it("signatures are bound to 0111: a Solana-signed request is refused", async () => {
    await expect(call("GET", "/api/portfolio", undefined, "0101")).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("deposit -> buy -> amounts past 2^53 as strings -> 0x withdrawal with gas in wei", async () => {
    const pool = mock.mockPool("hood");
    const memo = unz1.unz1MemoString(deposit.depositFields(Math.floor(Date.now() / 1000)), secret, deposit.poolChainId(pool, "hood"));
    mock.mockPay("hood", deposit.depositUri(pool, "50000000", memo));
    await vi.advanceTimersByTimeAsync(20_000);
    await call<Portfolio>("GET", "/api/portfolio"); // the scanner runs on requests
    expect((await call<Portfolio>("GET", "/api/portfolio")).zecBalance).toBe("50000000");

    const [t] = (await call<TokenListItem[]>("GET", "/api/tokens")).filter((x) => x.status === "curve");
    const r = await call<ActionReceipt>("POST", "/api/actions", { op: "buy", venue: "pons", mint: t.mint, zecIn: "10000000", minOut: "1", exec: "delayed" });
    await vi.advanceTimersByTimeAsync(20_000);
    const st = await call<ActionStatus>("GET", `/api/actions/${r.id}`);
    expect(st.status).toBe("executed");
    expect(BigInt(st.fill!.tokenAmount) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(st.fill!.solAmount).toMatch(/^\d{14,}$/); // wei
    const p = await call<Portfolio>("GET", "/api/portfolio");
    const h = p.holdings.find((x) => x.mint === t.mint)!;
    expect(h.amount).toBe(st.fill!.tokenAmount);
    expect(p.actions!.some((a) => a.id === r.id && a.kind === "buy")).toBe(true);

    // Base58 destination refused, a lower-case 0x one accepted.
    await expect(call("POST", "/api/actions", { op: "withdraw_token", mint: t.mint, amount: h.amount, to: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", exec: "max" })).rejects.toMatchObject({ code: "bad_request" });
    const w = await call<ActionReceipt>("POST", "/api/actions", { op: "withdraw_token", mint: t.mint, amount: h.amount, to: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", exec: "max" });
    await vi.advanceTimersByTimeAsync(60_000);
    const ws = await call<ActionStatus>("GET", `/api/actions/${w.id}`);
    expect(ws.status).toBe("executed");
    // A1: never the exact amount.
    expect(BigInt(ws.fill!.tokenAmount) < BigInt(h.amount)).toBe(true);
  });

  it("v0.22: a zero price limit is 400, a stale pool price is 503 stale_price with Retry-After 60", async () => {
    const [t] = (await call<TokenListItem[]>("GET", "/api/tokens")).filter((x) => x.status === "curve");
    await expect(call("POST", "/api/actions", { op: "buy", venue: "pons", mint: t.mint, zecIn: "10000000", minOut: "0" })).rejects.toMatchObject({ code: "bad_request", status: 400 });
    await expect(call("POST", "/api/actions", { op: "sell", venue: "pons", mint: t.mint, amount: "1", minZecOut: "0" })).rejects.toMatchObject({ code: "bad_request", status: 400 });
    // Nothing reprices while nobody listens to the feed: 10 minutes on, every pool price is past 300 s.
    vi.setSystemTime(vi.getRealSystemTime() + 10 * 60_000);
    await expect(call("POST", "/api/actions", { op: "buy", venue: "pons", mint: t.mint, zecIn: "10000000", minOut: "1" })).rejects.toMatchObject({ code: "stale_price", status: 503, retryAfter: 60 });
    // The mock reprices within the Retry-After window, so the automatic retry goes through.
    vi.setSystemTime(Date.now() + 60_000);
    await expect(call("POST", "/api/actions", { op: "buy", venue: "pons", mint: t.mint, zecIn: "10000000", minOut: "1" })).resolves.toMatchObject({ status: "queued" });
  });

  it("orders and scenarios are not on this chain yet", async () => {
    await expect(call("POST", "/api/actions", { op: "order_create", venue: "pumpfun", mint: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", kind: "limit_buy", amount: "1000000", triggerPriceSol: "1" })).rejects.toMatchObject({ code: "bad_request" });
  });
});
