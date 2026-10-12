import { describe, expect, it, vi } from "vitest";
import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import {
  DEFAULT_FEE_LEVELS,
  HeliusPriorityFeeSource,
  PriorityFeeCache,
  RpcRecentFeesSource,
  heliusRequest,
  quantizeFee,
  type PriorityFeeSource,
} from "../src/fees";
import { loadConfig } from "../src/config";

class CountingSource implements PriorityFeeSource {
  readonly name = "counting";
  calls = 0;
  constructor(public value: number | null | Error) {}
  async estimate(): Promise<number | null> {
    this.calls++;
    if (this.value instanceof Error) throw this.value;
    return this.value;
  }
}

describe("quantizeFee", () => {
  it("has 10 levels and rounds UP to the next level", () => {
    expect(DEFAULT_FEE_LEVELS).toHaveLength(10);
    expect(quantizeFee(null)).toBe(1_000);
    expect(quantizeFee(0)).toBe(1_000);
    expect(quantizeFee(1_000)).toBe(1_000);
    expect(quantizeFee(1_001)).toBe(2_000);
    expect(quantizeFee(12_345)).toBe(20_000);
    expect(quantizeFee(123_457)).toBe(200_000);
  });
  it("clamps to the max (and to the highest level <= max)", () => {
    expect(quantizeFee(9e9)).toBe(1_000_000);
    expect(quantizeFee(9e9, DEFAULT_FEE_LEVELS, 300_000)).toBe(200_000);
    expect(quantizeFee(Number.NaN)).toBe(1_000);
    expect(() => quantizeFee(5, [1_000], 10)).toThrow();
  });
  it("any raw input maps to one of the levels (no fingerprint values)", () => {
    for (let i = 0; i < 2_000; i++) {
      const raw = Math.floor(Math.random() * 3_000_000);
      expect(DEFAULT_FEE_LEVELS).toContain(quantizeFee(raw));
    }
  });
});

describe("PriorityFeeCache", () => {
  it("reading the price never calls the estimator (R-relayer-5)", async () => {
    const src = new CountingSource(12_345);
    const cache = new PriorityFeeCache(src);
    expect(cache.microLamports()).toBe(1_000); // before the first refresh: lowest level
    expect(src.calls).toBe(0);
    await cache.refresh();
    expect(src.calls).toBe(1);
    for (let i = 0; i < 100; i++) expect(cache.microLamports()).toBe(20_000);
    expect(src.calls).toBe(1);
  });

  it("stale (> 60 s): last estimate x1.5, quantized; failures keep the last value", async () => {
    let now = 1_000_000;
    const src = new CountingSource(15_000);
    const cache = new PriorityFeeCache(src, { now: () => now });
    await cache.refresh();
    expect(cache.microLamports()).toBe(20_000);
    src.value = new Error("rpc down");
    await cache.refresh();
    expect(cache.failures).toBe(1);
    now += 60_001;
    expect(cache.microLamports()).toBe(50_000); // 15 000 x 1.5 = 22 500 -> 50 000
    src.value = 3_000;
    await cache.refresh();
    expect(cache.microLamports()).toBe(5_000);
  });

  it("refreshes in the background every 10–20 s, independent of requests", async () => {
    vi.useFakeTimers();
    try {
      const src = new CountingSource(1);
      const waits: number[] = [];
      const cache = new PriorityFeeCache(src, {
        randomInt: (a, b) => {
          const v = a + Math.floor(Math.random() * (b - a + 1));
          waits.push(v);
          return v;
        },
      });
      cache.start();
      await vi.advanceTimersByTimeAsync(200_000);
      cache.stop();
      expect(src.calls).toBeGreaterThanOrEqual(10);
      expect(src.calls).toBeLessThanOrEqual(20);
      expect(waits.every((w) => w >= 10_000 && w <= 20_000)).toBe(true);
      const calls = src.calls;
      await vi.advanceTimersByTimeAsync(100_000);
      expect(src.calls).toBe(calls); // stopped
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("estimate sources", () => {
  it("Helius: accountKeys = venue programs only, no serialized transaction", async () => {
    const program = PUMP_PROGRAM_ID.toBase58();
    const body = heliusRequest([program], "Medium") as { method: string; params: [Record<string, unknown>] };
    expect(body.method).toBe("getPriorityFeeEstimate");
    expect(Object.keys(body.params[0]).sort()).toEqual(["accountKeys", "options"]);
    expect(body.params[0].accountKeys).toEqual([program]);

    const seen: unknown[] = [];
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { priorityFeeEstimate: 7_777.5 } }));
    }) as unknown as typeof fetch;
    const src = new HeliusPriorityFeeSource("https://example.invalid/?api-key=x", [program], "Medium", fakeFetch);
    expect(await src.estimate()).toBe(7_777.5);
    expect(seen).toEqual([heliusRequest([program], "Medium")]);

    const errFetch = (async () => new Response(JSON.stringify({ error: { code: -32601, message: "Method not found" } }))) as unknown as typeof fetch;
    expect(await new HeliusPriorityFeeSource("https://example.invalid", [program], "Medium", errFetch).estimate()).toBeNull();
  });

  it("RPC getRecentPrioritizationFees: programs only, percentile", async () => {
    const asked: string[][] = [];
    const conn = {
      getRecentPrioritizationFees: async (c?: { lockedWritableAccounts?: { toBase58(): string }[] }) => {
        asked.push((c?.lockedWritableAccounts ?? []).map((k) => k.toBase58()));
        return [0, 0, 10, 20, 30, 40, 50, 60].map((f, i) => ({ slot: i, prioritizationFee: f }));
      },
    };
    const src = new RpcRecentFeesSource(conn as never, [PUMP_PROGRAM_ID.toBase58()], 0.75);
    expect(await src.estimate()).toBe(50);
    expect(asked).toEqual([[PUMP_PROGRAM_ID.toBase58()]]);
  });

  it("config: Helius on mainnet Helius RPC, standard RPC elsewhere, explicit override", () => {
    const base = { UNZEEN_ALLOW_MAINNET: "yes", SOLANA_KEYS_DIR: "/tmp/x" };
    expect(loadConfig({ ...base, SOLANA_CLUSTER: "mainnet-beta", SOLANA_RPC_URL_MAINNET: "https://mainnet.helius-rpc.com/?api-key=k" }).priorityFeeSource).toBe("helius");
    expect(loadConfig({ ...base, SOLANA_CLUSTER: "devnet", SOLANA_RPC_URL_DEVNET: "https://devnet.helius-rpc.com/?api-key=k" }).priorityFeeSource).toBe("rpc");
    expect(loadConfig({ ...base, SOLANA_CLUSTER: "devnet", SOLANA_PRIORITY_FEE_SOURCE: "fixed" }).priorityFeeSource).toBe("fixed");
    expect(() => loadConfig({ ...base, SOLANA_CLUSTER: "devnet", SOLANA_PRIORITY_FEE_SOURCE: "jito" })).toThrow();
    expect(loadConfig({ ...base, SOLANA_CLUSTER: "devnet" }).priorityMaxMicroLamports).toBe(1_000_000);
  });
});
