// Mock of docs/API.md v0.13–v0.14: non-SOL pairs (ZEC SPL parity, USDC / USD1), LaunchLab platforms,
// creator fees of ZEC pairs in zatoshis, Verify quoteAssets.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signRequest, signerFromSecret } from "@/lib/crypto/sign";
import { unz1MemoString } from "@/lib/crypto/unz1";
import { depositFields, depositUri, poolChainId } from "@/lib/deposit";
import { ZEC_SPL_MINT } from "@/lib/quotes";
import { checkSnapshot, quoteHoldings, solvency } from "@/lib/verify/merkle-sum";
import type { ActionReceipt, ActionStatus, CreatorCabinet, FeedEvent, Portfolio, TokenListItem, VerifySnapshot } from "./types";
import { handle, mockCreditCreatorFees, mockCreditCreatorFeesZat, mockPay, mockPool, mockTakeSnapshot } from "./mock";

let SK = crypto.getRandomValues(new Uint8Array(32));
let signer = signerFromSecret(SK);
beforeEach(() => {
  SK = crypto.getRandomValues(new Uint8Array(32));
  signer = signerFromSecret(SK);
  vi.useFakeTimers({ now: 1_760_700_000_000 });
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
const status = (id: string) => call<ActionStatus>("GET", `/api/actions/${id}`);

async function fund(zat: string) {
  const pool = mockPool("devnet");
  const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, poolChainId(pool, "devnet"));
  mockPay("devnet", depositUri(pool, zat, memo));
  vi.advanceTimersByTime(20_000);
}
const tokenBy = async (symbol: string) => (await call<TokenListItem[]>("GET", "/api/tokens")).find((t) => t.symbol === symbol)!;

describe("mock v0.13: pairs and venues", () => {
  it("PoolInfo.quotes lists ZEC (bridged, spread), USDC per venue family, USD1; LaunchLab has a creator cap", () => {
    const pool = mockPool("devnet");
    const zec = pool.quotes!.find((q) => q.quote === "ZEC")!;
    expect(zec).toMatchObject({ mint: ZEC_SPL_MINT, decimals: 8, bridged: true, spreadBps: 30, venues: ["pumpfun", "raydium-launchlab"] });
    expect(pool.quotes!.filter((q) => q.quote === "USDC")).toHaveLength(2);
    expect(pool.minClaimZat).toBe("10000");
    expect(pool.launchRules!.maxInitialBuyLamportsByVenue!["raydium-launchlab"]).toMatch(/^\d+$/);
  });

  it("tokens carry quote, quoteMint, priceQuote and the LaunchLab platform", async () => {
    const shield = await tokenBy("SHIELD");
    expect(shield).toMatchObject({ quote: "ZEC", quoteMint: ZEC_SPL_MINT, venue: "pumpfun" });
    expect(Number(shield.priceQuote)).toBeGreaterThan(0);
    expect(await tokenBy("DARK")).toMatchObject({ quote: "ZEC", venue: "raydium-launchlab", platform: "unzeen", marketCapSol: "0" });
    expect(await tokenBy("BONKSHADE")).toMatchObject({ quote: "SOL", platform: "bonk" });
    expect((await tokenBy("PEPE")).quote).toBe("SOL");
    const feed = await call<FeedEvent[]>("GET", "/api/feed?limit=200");
    for (const e of feed.filter((x) => x.mint === shield.mint)) expect(e).toMatchObject({ quoteMint: ZEC_SPL_MINT, quoteAmount: expect.stringMatching(/^\d+$/) });
    for (const e of feed.filter((x) => x.symbol === "PEPE")) expect(e.quoteMint).toBeUndefined();
  });
});

describe("mock v0.13: trading a ZEC pair at 1:1 parity", () => {
  it("buy spends zecIn × (1 − s) of ZEC SPL, rate is parity, fill has quoteAmount; sell credits / (1 + s)", async () => {
    await fund("100000000");
    const t = await tokenBy("SHIELD");
    const r = await post({ op: "buy", venue: "pumpfun", mint: t.mint, zecIn: "10000000", minOut: "0", exec: "now" });
    expect(r.rate).toMatchObject({ quote: "ZEC", quotePerZec: "99700000", source: "parity" });
    expect(r.rate!.lamportsPerZec).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    const st = await status(r.id);
    expect(st.status).toBe("executed");
    expect(st.fill).toMatchObject({ quoteAmount: "9970000", quoteMint: ZEC_SPL_MINT, zecSpent: "10000000" });
    expect(st.fill!.solAmount).toBeUndefined();

    const s = await post({ op: "sell", venue: "pumpfun", mint: t.mint, amount: st.fill!.tokenAmount, minZecOut: "0", exec: "now" });
    expect(s.rate).toMatchObject({ quote: "ZEC", quotePerZec: "100300000" });
    await vi.advanceTimersByTimeAsync(5_000);
    const ss = await status(s.id);
    expect(BigInt(ss.fill!.zecCredited!)).toBe((BigInt(ss.fill!.quoteAmount!) * BigInt(100_000_000)) / BigInt(100_300_000));
  });

  it("jupiter is refused on a ZEC pair; a big trade on a non-SOL pair answers pool_liquidity and holds nothing", async () => {
    await fund("1000000000");
    const t = await tokenBy("SHIELD");
    await expect(post({ op: "buy", venue: "jupiter", mint: t.mint, zecIn: "1000000", minOut: "1" })).rejects.toMatchObject({ code: "bad_request" });
    const before = await portfolio();
    await expect(post({ op: "buy", venue: "pumpfun", mint: t.mint, zecIn: "600000000", minOut: "0" })).rejects.toMatchObject({ code: "pool_liquidity", status: 503 });
    expect((await portfolio()).zecBalance).toBe(before.zecBalance);
  });

  it("orders on a non-SOL pair: order_unsupported_mint", async () => {
    await fund("100000000");
    const t = await tokenBy("SHIELD");
    await expect(
      post({ op: "order_create", venue: "pumpfun", mint: t.mint, kind: "limit_buy", triggerPriceSol: "0.0000001", amount: "2000000" }),
    ).rejects.toMatchObject({ code: "order_unsupported_mint" });
  });
});

describe("mock v0.13: create with a pair and a platform", () => {
  it("validates the pair against the venue and the platform against LaunchLab", async () => {
    await fund("100000000");
    const meta = { name: "Pair Test", symbol: "PAIR" };
    await expect(post({ op: "create", venue: "meteora-dbc", meta, quote: "ZEC" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(post({ op: "create", venue: "pumpfun", meta, platform: "bonk" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(post({ op: "create", venue: "bags", meta })).rejects.toMatchObject({ code: "venue_unavailable" });
    // ZEC curve cap: about 0.133 ZEC SPL of launch buy within 5 %.
    await expect(post({ op: "create", venue: "pumpfun", meta, quote: "ZEC", initialBuyZec: "20000000" })).rejects.toMatchObject({ code: "creator_cap" });
  });

  it("a ZEC launch on LaunchLab mints a ZEC-paired token under the platform; the feed reads in ZEC", async () => {
    await fund("100000000");
    const r = await post({ op: "create", venue: "raydium-launchlab", platform: "stonk", quote: "ZEC", meta: { name: "Zec Launch", symbol: "ZL" }, initialBuyZec: "10000000", exec: "now" });
    expect(r.rate).toMatchObject({ quote: "ZEC", source: "parity" });
    await vi.advanceTimersByTimeAsync(5_000);
    const st = await status(r.id);
    const mint = st.fill!.mint!;
    expect(st.fill).toMatchObject({ quoteMint: ZEC_SPL_MINT, quoteAmount: "9970000" });
    expect(await tokenBy("ZL")).toMatchObject({ mint, quote: "ZEC", venue: "raydium-launchlab", platform: "stonk" });
    const ev = (await call<FeedEvent[]>("GET", "/api/feed?limit=50")).find((e) => e.mint === mint && e.kind === "create")!;
    expect(ev).toMatchObject({ quoteMint: ZEC_SPL_MINT, quoteAmount: "9970000" });
  });
});

describe("mock v0.14: creator fees of ZEC pairs", () => {
  it("claimable zecAmount + lamports: claim credits both, minClaimZat on the sum; cabinet shows claimableZat / claimedZat", async () => {
    await fund("100000000");
    const r = await post({ op: "create", venue: "pumpfun", quote: "ZEC", meta: { name: "Fee Zec", symbol: "FZ" }, exec: "now" });
    await vi.advanceTimersByTimeAsync(5_000);
    const mint = (await status(r.id)).fill!.mint!;
    mockCreditCreatorFeesZat("devnet", signer.pubkey, mint, BigInt(6_000));
    // 6 000 zat < minClaimZat 10 000
    await expect(post({ op: "claim", mint })).rejects.toMatchObject({ code: "below_minimum" });
    mockCreditCreatorFees("devnet", signer.pubkey, mint, BigInt(9_000_000)); // 0.009 SOL ≈ 0.00497 ZEC at sell
    let p = await portfolio();
    expect(p.claimable).toEqual([{ mint, solAmount: "9000000", zecAmount: "6000" }]);
    const before = BigInt(p.zecBalance);
    const rate = BigInt(mockPool("devnet").rate!.lamportsPerZecSell);
    await post({ op: "claim", mint });
    p = await portfolio();
    expect(BigInt(p.zecBalance) - before).toBe((BigInt(9_000_000) * BigInt(100_000_000)) / rate + BigInt(6_000));
    expect(p.claimable).toEqual([]);
    const cab = await call<CreatorCabinet>("GET", "/api/creator");
    expect(cab.tokens[0].fees).toEqual({ claimableLamports: "0", claimedLamports: "9000000", claimableZat: "0", claimedZat: "6000" });
  });
});

describe("mock v0.13: Verify quoteAssets", () => {
  it("snapshot lists quote assets; only ZEC SPL above dust counts (bridged), USDC / USD1 never", async () => {
    const id = await mockTakeSnapshot("devnet");
    const s = await call<VerifySnapshot>("GET", `/api/verify/${id}`);
    expect(s.quoteAssets!.map((q) => [q.quote, q.counted])).toEqual(expect.arrayContaining([["ZEC", true], ["USDC", false], ["USD1", false]]));
    const check = checkSnapshot(s, null);
    const qh = quoteHoldings(s, check);
    const zec = qh.find((q) => q.quote === "ZEC")!;
    expect(zec.total).toBeGreaterThan(zec.countedAmount); // the dust vault is shown, not counted
    for (const q of qh.filter((x) => x.quote !== "ZEC")) expect(q.countedZat).toBe(BigInt(0));
    const row = solvency(s, check).find((r) => r.asset === "ZEC");
    if (row) {
      expect(row.bridgedZat).toBe(zec.countedZat);
      expect(row.assets).toBe(row.provenZat! + row.attestedZat! + row.bridgedZat!);
    }
  });
});

describe("mock v0.16: PoolInfo.venues and Bags", () => {
  it("devnet: bags and jupiter listed but off; launchpads take their pairs", () => {
    const v = mockPool("devnet").venues!;
    expect(v.find((x) => x.venue === "bags")).toMatchObject({ trade: false, create: false, quotes: [], atomicFirstBuy: false, creatorFees: false, mainnetOnly: true });
    expect(v.find((x) => x.venue === "jupiter")).toMatchObject({ create: false, mainnetOnly: true });
    expect(v.find((x) => x.venue === "pumpfun")!.quotes).toEqual(["SOL", "ZEC", "USDC"]);
  });
  it("mainnet: bags creates SOL pairs only; devnet answers 503", async () => {
    expect(mockPool("mainnet").venues!.find((x) => x.venue === "bags")).toMatchObject({ create: true, quotes: ["SOL"] });
    await fund("100000000");
    await expect(post({ op: "create", venue: "bags", meta: { name: "Bag", symbol: "BAG" } })).rejects.toMatchObject({ code: "venue_unavailable" });
  });
});
