// Mock v0.17 (docs/API.md, final audit A1, A2, A6; quote candles; ZEC-pair launch cap; Verify digest v2).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { signRequest, signerFromSecret } from "@/lib/crypto/sign";
import { unz1MemoString } from "@/lib/crypto/unz1";
import { depositFields, depositUri, poolChainId } from "@/lib/deposit";
import type { Network } from "@/lib/network";
import { maxInitialBuyZat } from "@/lib/launch-rules";
import { rootsDigest } from "@/lib/verify/merkle-sum";
import type { ActionReceipt, ActionStatus, Candle, Portfolio, Token, VerifySnapshot } from "./types";
import { checkWithdrawUa } from "@/lib/zcash/ua";
import UA_VECTORS from "@/lib/crypto/testdata/ua-vectors.json";
import { fuzzTokenAmount, handle, mockPay, mockPool, sig3Down, splitAmount } from "./mock";

const SK = hexToBytes("7a1f3c0de4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff");
const signer = signerFromSecret(SK);
const CHAIN: Record<Network, string> = { devnet: "0202", mainnet: "0101" };

async function call<T>(network: Network, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const b = body === undefined ? undefined : JSON.stringify(body);
  const p = handle(network, method, path, b, signRequest(signer, { chainId: CHAIN[network], method, pathWithQuery: path, body: b }));
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(500);
  return (await p) as T;
}

async function fund(network: Network, zat: string) {
  const pool = mockPool(network);
  const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, poolChainId(pool, network));
  mockPay(network, depositUri(pool, zat, memo));
  vi.advanceTimersByTime(20_000);
}

describe("v0.17 rounding helpers (core fuzz_token_amount, split_amount, quantize_min_out)", () => {
  it("3 significant digits, rounded down", () => {
    expect(sig3Down(BigInt(999))).toBe(BigInt(999));
    expect(sig3Down(BigInt(123_456_789))).toBe(BigInt(123_000_000));
    expect(sig3Down(BigInt(1_009))).toBe(BigInt(1_000));
  });

  it("shave 0.5–2 % then round; never the input, dust to 0", () => {
    for (const u of [0, 0.5, 0.999]) {
      const v = fuzzTokenAmount(BigInt(1_000_000_000), u);
      expect(v < BigInt(1_000_000_000)).toBe(true);
      expect(v >= BigInt(980_000_000)).toBe(true);
      expect(sig3Down(v)).toBe(v);
    }
    expect(fuzzTokenAmount(BigInt(1), 0)).toBe(BigInt(0));
  });

  it("split keeps the sum, uneven, at least 1 each", () => {
    const parts = splitAmount(BigInt(1_000_000), 4, () => 0.9);
    expect(parts).toHaveLength(4);
    expect(parts.reduce((a, b) => a + b, BigInt(0))).toBe(BigInt(1_000_000));
    expect(new Set(parts.map(String)).size).toBeGreaterThan(1);
    expect(splitAmount(BigInt(3), 3).every((p) => p >= BigInt(1))).toBe(true);
  });
});

describe("mock v0.17 actions", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_760_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("A6: selling exactly what you bought is shaved and rounded, minZecOut in proportion", async () => {
    await fund("devnet", "50000000");
    const t = (await call<Token[]>("devnet", "GET", "/api/tokens")).find((x) => x.status === "curve" && (x.quote ?? "SOL") === "SOL")!;
    const r = await call<ActionReceipt>("devnet", "POST", "/api/actions", { op: "buy", venue: t.venue, mint: t.mint, zecIn: "5000000", minOut: "0" });
    await vi.advanceTimersByTimeAsync(10_000);
    const got = BigInt((await call<ActionStatus>("devnet", "GET", `/api/actions/${r.id}`)).fill!.tokenAmount);
    const before = (await call<Portfolio>("devnet", "GET", "/api/portfolio")).holdings.find((h) => h.mint === t.mint)!;
    const s = await call<ActionReceipt>("devnet", "POST", "/api/actions", { op: "sell", venue: t.venue, mint: t.mint, amount: got.toString(), minZecOut: "0" });
    const mid = (await call<Portfolio>("devnet", "GET", "/api/portfolio")).holdings.find((h) => h.mint === t.mint)!;
    const held = BigInt(mid.held);
    expect(held < got).toBe(true);
    expect(sig3Down(held)).toBe(held);
    expect(BigInt(mid.amount)).toBe(BigInt(before.amount) - held);
    await vi.advanceTimersByTimeAsync(10_000);
    const done = await call<ActionStatus>("devnet", "GET", `/api/actions/${s.id}`);
    expect(done.status).toBe("executed");
    expect(done.fill!.tokenAmount).toBe(held.toString());
  });

  it("A6: a size far from any buy is sold as signed", async () => {
    await fund("devnet", "50000000");
    const t = (await call<Token[]>("devnet", "GET", "/api/tokens")).find((x) => x.status === "curve" && (x.quote ?? "SOL") === "SOL")!;
    const r = await call<ActionReceipt>("devnet", "POST", "/api/actions", { op: "buy", venue: t.venue, mint: t.mint, zecIn: "5000000", minOut: "0" });
    await vi.advanceTimersByTimeAsync(10_000);
    const got = BigInt((await call<ActionStatus>("devnet", "GET", `/api/actions/${r.id}`)).fill!.tokenAmount);
    const half = got / BigInt(2);
    await call<ActionReceipt>("devnet", "POST", "/api/actions", { op: "sell", venue: t.venue, mint: t.mint, amount: half.toString(), minZecOut: "0" });
    const mid = (await call<Portfolio>("devnet", "GET", "/api/portfolio")).holdings.find((h) => h.mint === t.mint)!;
    expect(mid.held).toBe(half.toString());
  });

  it("A2: a mainnet ZEC payout above 1 ZEC stays queued for the operator; small ones go out", async () => {
    await fund("mainnet", "500000000");
    const big = await call<ActionReceipt>("mainnet", "POST", "/api/actions", { op: "withdraw_zec", to: MAINNET_UA, amount: "150000000" });
    const small = await call<ActionReceipt>("mainnet", "POST", "/api/actions", { op: "withdraw_zec", to: MAINNET_UA, amount: "50000000" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await call<ActionStatus>("mainnet", "GET", `/api/actions/${big.id}`)).status).toBe("queued");
    expect((await call<ActionStatus>("mainnet", "GET", `/api/actions/${small.id}`)).status).toBe("executed");
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await call<ActionStatus>("mainnet", "GET", `/api/actions/${big.id}`)).status).toBe("executed");
  });

  it("A1: a withdrawal too small to round is refused", async () => {
    await fund("devnet", "50000000");
    const t = (await call<Token[]>("devnet", "GET", "/api/tokens")).find((x) => x.status === "curve")!;
    const r = await call<ActionReceipt>("devnet", "POST", "/api/actions", { op: "buy", venue: t.venue, mint: t.mint, zecIn: "5000000", minOut: "0" });
    await vi.advanceTimersByTimeAsync(10_000);
    void r;
    await expect(call("devnet", "POST", "/api/actions", { op: "withdraw_token", mint: t.mint, amount: "1", to: "So11111111111111111111111111111111111111112" })).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("mock v0.17 public data", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_760_000_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("candles?quote=1: a pair in its own units, volume as a base-unit string; SOL pairs unchanged; bad value 400", async () => {
    const tokens = await call<Token[]>("mainnet", "GET", "/api/tokens");
    const zec = tokens.find((x) => x.quote === "ZEC");
    const sol = tokens.find((x) => (x.quote ?? "SOL") === "SOL")!;
    const a = await call<Candle[]>("mainnet", "GET", `/api/tokens/${sol.mint}/candles?tf=5m`);
    const b = await call<Candle[]>("mainnet", "GET", `/api/tokens/${sol.mint}/candles?tf=5m&quote=1`);
    // Same bars (the mock's volume is random per call; prices are seeded).
    const prices = (l: Candle[]) => l.map((c) => [c.time, c.open, c.high, c.low, c.close]);
    expect(prices(b)).toEqual(prices(a));
    for (const c of a) expect(c.volume).toMatch(/^\d+$/);
    if (zec) {
      const inSol = await call<Candle[]>("mainnet", "GET", `/api/tokens/${zec.mint}/candles?tf=5m`);
      const inZec = await call<Candle[]>("mainnet", "GET", `/api/tokens/${zec.mint}/candles?tf=5m&quote=1`);
      expect(inZec.length).toBe(inSol.length);
      expect(Number(inZec.at(-1)!.close)).not.toBe(Number(inSol.at(-1)!.close));
    }
    await expect(call("mainnet", "GET", `/api/tokens/${sol.mint}/candles?quote=2`)).rejects.toMatchObject({ code: "bad_request" });
  });

  it("launchRules.maxInitialBuyZecUnitsByVenue: only venues with the ZEC pair, step 0.0001 ZEC, enforced like the client", async () => {
    const pool = mockPool("mainnet");
    const zecVenues = pool.quotes?.find((q) => q.quote === "ZEC")?.venues ?? [];
    const by = pool.launchRules!.maxInitialBuyZecUnitsByVenue!;
    expect(Object.keys(by).sort()).toEqual([...zecVenues].sort());
    for (const v of Object.values(by)) expect(BigInt(v) % BigInt(10_000)).toBe(BigInt(0));
    if (!zecVenues.length) return;
    const venue = zecVenues[0];
    const max = maxInitialBuyZat(pool, venue, "ZEC")!;
    await fund("mainnet", (max * BigInt(3)).toString());
    const meta = { name: "Cap Test", symbol: "CAP" };
    await expect(call("mainnet", "POST", "/api/actions", { op: "create", venue, quote: "ZEC", meta, initialBuyZec: (max + BigInt(20_000)).toString() })).rejects.toMatchObject({ code: "creator_cap" });
    const ok = await call<ActionReceipt>("mainnet", "POST", "/api/actions", { op: "create", venue, quote: "ZEC", meta, initialBuyZec: max.toString() });
    expect(ok.status).toBe("queued");
  });

  it("Verify snapshots are digest v2 and hash with their quoteAssets", async () => {
    const s = await call<VerifySnapshot>("devnet", "GET", "/api/verify");
    expect(s.digestVersion).toBe(2);
    expect(rootsDigest(s)).toBe(s.rootsDigest);
    if (s.quoteAssets?.length) expect(rootsDigest({ ...s, quoteAssets: [] })).not.toBe(s.rootsDigest);
  });
});

// A mainnet UA with an Orchard receiver from the ZIP-316 vectors, accepted by the same check as the form.
const MAINNET_UA = JSON.stringify(UA_VECTORS)
  .match(/u1[02-9ac-hj-np-z]{100,}/g)!
  .find((x) => checkWithdrawUa(x, "mainnet").ok)!;
