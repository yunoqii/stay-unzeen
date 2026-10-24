import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntelIndexer } from "../src/intel/indexer";
import { MemoryIntelStore } from "../src/intel/memory-store";
import type { LargestAccount } from "../src/intel/metrics";
import type { ChainReader } from "../src/intel/reader";
import { BATCH_SIZE, CARD_TICK_BASE_MS, CARD_TICK_JITTER_MS, nextTickDelay, pickWarmDue } from "../src/intel/schedule";
import { seededRng } from "../src/relayer/random";

const keyS = () => Keypair.generate().publicKey.toBase58();
const noSleep = async (): Promise<void> => undefined;

function mintAccount(supply: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    { mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default },
    data,
  );
  return { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
}

/** Every mint exists (an SPL mint without curve / metadata); records every call. */
class Reader implements ChainReader {
  readonly hasIndex = true;
  readonly calls: { method: string; keys: string[] }[] = [];
  readonly mints = new Set<string>();
  recent: string[] = [];
  async getMultipleAccounts(keys: readonly PublicKey[]) {
    this.calls.push({ method: "getMultipleAccounts", keys: keys.map((k) => k.toBase58()) });
    return keys.map((k) => (this.mints.has(k.toBase58()) ? mintAccount(1_000_000n) : null));
  }
  async getTokenLargestAccounts(mint: PublicKey): Promise<LargestAccount[]> {
    this.calls.push({ method: "getTokenLargestAccounts", keys: [mint.toBase58()] });
    return [];
  }
  async recentPumpMints() {
    return this.recent;
  }
  /** Mints (first key of each stride) of every batch read that contains `m`. */
  readsWith(m: string): string[][] {
    return this.calls.filter((c) => c.method === "getMultipleAccounts" && c.keys.includes(m)).map((c) => c.keys);
  }
}

function setup(seed: number, o: { discovery?: () => string[] } = {}) {
  const reader = new Reader();
  reader.recent = Array.from({ length: 40 }, keyS);
  reader.recent.forEach((m) => reader.mints.add(m));
  const store = new MemoryIntelStore();
  const idx = new IntelIndexer({ store, reader, sleep: noSleep, rng: seededRng(seed), cardLane: true, ...(o.discovery ? { discoveryMints: o.discovery } : {}) });
  return { reader, store, idx };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("card lane (docs/INTEL.md, fast token card)", () => {
  it("timer is uniform 6–10 s, independent of requests", () => {
    const rng = seededRng(11);
    for (let i = 0; i < 500; i++) {
      const d = nextTickDelay(rng, CARD_TICK_BASE_MS, CARD_TICK_JITTER_MS);
      expect(d).toBeGreaterThanOrEqual(6_000);
      expect(d).toBeLessThanOrEqual(10_000);
    }
  });

  it("waits for the first main tick (decoy pool), then always sends a batch of 8, queue or not", async () => {
    const { reader, store, idx } = setup(1);
    const r0 = await idx.cardTick();
    expect(r0.batch).toBe(0);
    expect(reader.calls).toHaveLength(0);
    await idx.tick();
    const r1 = await idx.cardTick();
    expect(r1.batch).toBe(BATCH_SIZE);
    expect(r1.cards).toBe(BATCH_SIZE);
    expect(store.nextCardAt).not.toBeNull();
  });

  it("a cold CA gets a card (no index call, no safety row), stays queued, and is carded only once", async () => {
    const { reader, store, idx } = setup(2);
    await idx.tick();
    const ca = keyS();
    reader.mints.add(ca);
    store.enqueue(ca);
    const before = reader.calls.length;
    const r = await idx.cardTick();
    expect(r.batch).toBe(BATCH_SIZE);
    const lane = reader.calls.slice(before);
    expect(lane.filter((c) => c.method === "getTokenLargestAccounts")).toHaveLength(0);
    expect(lane.filter((c) => c.method === "getMultipleAccounts")).toHaveLength(1);
    expect(store.cards.has(ca)).toBe(true);
    expect(store.safety.has(ca)).toBe(false);
    expect(store.lookups).toEqual([ca]);
    // Card batch mints stay warm briefly (core's warm sync keeps their cards), never 7 days.
    const w = store.warm.get(ca)!;
    expect(w.expiresAt! - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 1_000);
    // Not repeated in later card batches.
    for (let i = 0; i < 5; i++) await idx.cardTick();
    expect(reader.readsWith(ca)).toHaveLength(1);
  });

  it("main batch: only carded CAs, decoys from the card batches since the last main batch, full snapshot, consumed", async () => {
    const { reader, store, idx } = setup(3);
    await idx.tick();
    const ca = keyS();
    reader.mints.add(ca);
    store.enqueue(ca);
    const cardBatches: string[] = [];
    for (let i = 0; i < 3; i++) {
      const n = reader.calls.length;
      await idx.cardTick();
      for (const c of reader.calls.slice(n)) cardBatches.push(...c.keys);
    }
    const n = reader.calls.length;
    const r = await idx.tick();
    expect(r.batch).toBe(BATCH_SIZE);
    const main = store.commits.at(-1)!;
    expect(main.batch).toContain(ca);
    expect(main.consumed).toEqual([ca]);
    for (const m of main.batch) expect(cardBatches).toContain(m); // every mint of the main batch was carded
    const largest = reader.calls.slice(n).filter((c) => c.method === "getTokenLargestAccounts").map((c) => c.keys[0]);
    for (const m of main.batch) expect(largest).toContain(m);
    expect(store.safety.has(ca)).toBe(true);
    expect(store.lookups).toEqual([]);
  });

  it("a CA queued after the last card tick waits for its card before the main batch takes it", async () => {
    const { reader, store, idx } = setup(4);
    await idx.tick();
    await idx.cardTick();
    const ca = keyS();
    reader.mints.add(ca);
    store.enqueue(ca);
    await idx.tick();
    expect(store.commits.at(-1)!.batch).not.toContain(ca);
    expect(store.lookups).toEqual([ca]);
    await idx.cardTick();
    await idx.tick();
    expect(store.commits.at(-1)!.consumed).toEqual([ca]);
  });

  it("with the run loop a CA has its card within ~10 s of the request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T12:00:05Z"));
    const { reader, store, idx } = setup(5);
    const ac = new AbortController();
    const done = idx.run(ac.signal);
    await vi.advanceTimersByTimeAsync(1_000); // first main tick done
    const ca = keyS();
    reader.mints.add(ca);
    store.enqueue(ca);
    await vi.advanceTimersByTimeAsync(10_500);
    expect(store.cards.has(ca)).toBe(true);
    ac.abort();
    await vi.advanceTimersByTimeAsync(100_000);
    await done;
  });

  it("card report: counts only", async () => {
    const { idx } = setup(6);
    await idx.tick();
    const r = await idx.cardTick();
    expect(Object.keys(r).sort()).toEqual(["batch", "cards", "errors", "missing", "ms", "nextInMs", "tick"]);
  });
});

describe("discovery candidates are pre-indexed (warm set)", () => {
  it("snapshotted on the next main tick, kept warm, not taken from the request queue", async () => {
    const disc = Array.from({ length: 5 }, keyS);
    const { reader, store, idx } = setup(7, { discovery: () => disc });
    disc.forEach((m) => reader.mints.add(m));
    await idx.tick();
    for (const m of disc) {
      expect(store.safety.has(m)).toBe(true);
      expect(store.cards.has(m)).toBe(true);
      expect(store.warm.get(m)!.expiresAt).toBeGreaterThan(Date.now() + 50 * 60_000);
    }
    expect(store.commits[0]!.discovery).toEqual(disc);
    // Fresh snapshots: not re-read on the next tick.
    const n = reader.calls.length;
    await idx.tick();
    const again = reader.calls.slice(n).filter((c) => c.method === "getTokenLargestAccounts").map((c) => c.keys[0]);
    for (const m of disc) expect(again.filter((x) => x === m).length).toBeLessThanOrEqual(1); // at most as a random decoy
  });

  it("a discovery card without a mirrored image is refreshed after 10 min, not 30", () => {
    const now = 10 * 3600_000;
    const e = (o: object) => ({ mint: keyS(), hot: false, asOf: now - 11 * 60_000, ...o });
    const noImg = e({ discovery: true, noImage: true });
    const withImg = e({ discovery: true });
    const plain = e({ noImage: true });
    expect(pickWarmDue([noImg, withImg, plain], now, seededRng(9))).toEqual([noImg.mint]);
  });

  it("due discovery candidates come before older plain warm entries", () => {
    const now = 10 * 3600_000;
    const old = Array.from({ length: 30 }, () => ({ mint: keyS(), hot: false, asOf: now - 5 * 3600_000 }));
    const disc = Array.from({ length: 5 }, () => ({ mint: keyS(), hot: false, asOf: now - 31 * 60_000, discovery: true }));
    const due = pickWarmDue([...old, ...disc], now, seededRng(10));
    expect(due).toHaveLength(20);
    for (const d of disc) expect(due).toContain(d.mint);
  });

  it("a throwing / malformed source never breaks the tick", async () => {
    const { store, idx } = setup(8, {
      discovery: () => {
        throw new Error("x");
      },
    });
    const r = await idx.tick();
    expect(r.batch).toBe(BATCH_SIZE);
    expect(store.commits[0]!.discovery).toBeUndefined();
  });
});

describe("gateway token bucket", () => {
  it("burst 2, then one slot per 1/rate s; available() never waits", async () => {
    const { TokenBucket } = await import("../src/intel/indexer");
    let t = 0;
    const slept: number[] = [];
    const b = new TokenBucket(1, 2, () => t, async (ms) => {
      slept.push(ms);
      t += ms;
    });
    await b.take();
    await b.take();
    expect(slept).toEqual([]);
    expect(b.available()).toBeLessThan(1);
    await b.take();
    expect(slept).toEqual([1000]);
    t += 5_000;
    expect(b.available()).toBe(2);
  });
});
