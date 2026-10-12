import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safetyData } from "../src/intel/pg-store";
import { CreatorKeyring, CreatorPubkeyFile, MemoryCreatorIndexCounter } from "../src/keys";
import { GLOBAL_PDA, PUMP_PROGRAM_ID, bondingCurvePda, canonicalPumpPoolPda, getPumpProgram, newBondingCurve } from "@pump-fun/pump-sdk";
import { AccountLayout, MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntelIndexer, PollingCurveWatcher, type CurveWatcher } from "../src/intel/indexer";
import { MemoryIntelStore } from "../src/intel/memory-store";
import { holderStats, pct } from "../src/intel/metrics";
import type { ChainReader } from "../src/intel/reader";
import { BATCH_SIZE, SubscriptionPlanner, assembleBatch, nextTickDelay, pickWarmDue, tickBoundary } from "../src/intel/schedule";
import type { LargestAccount } from "../src/intel/metrics";
import { seededRng } from "../src/relayer/random";
import { loadParams } from "./helpers";

const { global } = loadParams();
const key = () => Keypair.generate().publicKey;
const keyS = () => key().toBase58();

function mintAccount(supply: bigint, mintAuthority: PublicKey | null = null): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: mintAuthority ? 1 : 0,
      mintAuthority: mintAuthority ?? PublicKey.default,
      supply,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
}

function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
}

async function curveAccount(creator: PublicKey): Promise<AccountInfo<Buffer>> {
  const program = getPumpProgram(new Connection("http://127.0.0.1:1"));
  const bc = { ...newBondingCurve(global), creator };
  const data = await program.coder.accounts.encode("bondingCurve", bc);
  return { data, owner: PUMP_PROGRAM_ID, executable: false, lamports: 1 };
}

/** Reader backed by a map of accounts; records every call. */
class FakeReader implements ChainReader {
  readonly hasIndex = true;
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  readonly largest = new Map<string, LargestAccount[]>();
  readonly calls: { method: string; keys: string[] }[] = [];
  recent: string[] = [];

  async getMultipleAccounts(keys: readonly PublicKey[]) {
    this.calls.push({ method: "getMultipleAccounts", keys: keys.map((k) => k.toBase58()) });
    return keys.map((k) => this.accounts.get(k.toBase58()) ?? null);
  }
  async getTokenLargestAccounts(mint: PublicKey) {
    this.calls.push({ method: "getTokenLargestAccounts", keys: [mint.toBase58()] });
    return this.largest.get(mint.toBase58()) ?? [];
  }
  async recentPumpMints() {
    this.calls.push({ method: "recentPumpMints", keys: [] });
    return this.recent;
  }
  /** Every address that reached the provider (any method). */
  touched(): Set<string> {
    return new Set(this.calls.flatMap((c) => c.keys));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("tick and decoys (docs/INTEL.md)", () => {
  it("a CA lookup reaches the provider only on the next tick (45–75 s timer), in a batch of 8", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T12:00:05Z"));
    const reader = new FakeReader();
    reader.recent = Array.from({ length: 20 }, keyS);
    const store = new MemoryIntelStore();
    const idx = new IntelIndexer({ store, reader, rng: seededRng(1) });
    const ac = new AbortController();
    const done = idx.run(ac.signal);
    await vi.advanceTimersByTimeAsync(0); // first tick
    const ca = keyS();
    store.enqueue(ca); // what core's endpoint does
    await vi.advanceTimersByTimeAsync(44_000); // < 45 s: the earliest possible next tick
    expect(reader.touched().has(ca)).toBe(false);
    await vi.advanceTimersByTimeAsync(32_000); // > 75 s: the next tick has run
    expect(reader.touched().has(ca)).toBe(true);
    const batchRead = reader.calls.find((c) => c.method === "getMultipleAccounts" && c.keys.includes(ca))!;
    expect(batchRead.keys.filter((k) => k !== GLOBAL_PDA.toBase58()).length / 4).toBe(BATCH_SIZE);
    ac.abort();
    await vi.advanceTimersByTimeAsync(100_000);
    await done;
  });

  it("the batch of 8 goes out on EVERY tick, also with an empty queue", async () => {
    const reader = new FakeReader();
    reader.recent = Array.from({ length: 20 }, keyS);
    const store = new MemoryIntelStore();
    const idx = new IntelIndexer({ store, reader, rng: seededRng(2) });
    const r = await idx.tick();
    expect(r.batch).toBe(8);
    const reads = reader.calls.filter((c) => c.method === "getMultipleAccounts");
    expect(reads[0]!.keys.length).toBe(1 + 8 * 4);
    expect(store.commits[0]!.batch).toHaveLength(8); // decoys join the warm set like requests
    expect(store.meta?.nextTickAt).toBeGreaterThan(store.meta!.lastTickAt);
  });

  it("every mint of a batch gets the same calls; at most 4 real, the rest stays queued", async () => {
    const reader = new FakeReader();
    const mints = Array.from({ length: 30 }, () => key());
    for (const m of mints) reader.accounts.set(m.toBase58(), mintAccount(1_000_000n));
    reader.recent = mints.slice(6).map((m) => m.toBase58());
    const store = new MemoryIntelStore();
    const real = mints.slice(0, 6).map((m) => m.toBase58());
    real.forEach((m) => store.enqueue(m));
    const idx = new IntelIndexer({ store, reader, rng: seededRng(7) });
    const r = await idx.tick();
    expect(r.batch).toBe(8);
    const largest = reader.calls.filter((c) => c.method === "getTokenLargestAccounts").map((c) => c.keys[0]);
    expect(largest).toHaveLength(8);
    const c = store.commits[0]!;
    expect(c.rows).toHaveLength(8);
    expect(c.consumed).toHaveLength(4);
    expect(store.lookups).toHaveLength(2);
    expect(new Set(c.rows.map((x) => x.asOf)).size).toBe(1);
    expect(c.asOf % 60_000).toBe(0);
  });

  it("the tick report carries no request/decoy split", async () => {
    const reader = new FakeReader();
    reader.recent = Array.from({ length: 20 }, keyS);
    const store = new MemoryIntelStore();
    store.enqueue(keyS());
    const r = await new IntelIndexer({ store, reader, rng: seededRng(3) }).tick();
    expect(Object.keys(r).sort()).toEqual(["batch", "errors", "missing", "ms", "nextInMs", "saved", "subsAdded", "subsRemoved", "tick", "warm"]);
  });

  it("unknown account -> missing snapshot and the request is consumed", async () => {
    const reader = new FakeReader();
    reader.recent = Array.from({ length: 20 }, keyS);
    const store = new MemoryIntelStore();
    const ca = keyS();
    store.enqueue(ca);
    await new IntelIndexer({ store, reader, rng: seededRng(4) }).tick();
    expect(store.missing.has(ca)).toBe(true);
    expect(store.lookups).toEqual([]);
  });

  it("per-mint RPC failure: no snapshot for it, the request stays queued", async () => {
    const reader = new FakeReader();
    const ca = key();
    reader.accounts.set(ca.toBase58(), mintAccount(1_000n));
    reader.recent = Array.from({ length: 20 }, keyS);
    reader.getTokenLargestAccounts = async (m: PublicKey) => {
      if (m.equals(ca)) throw new Error("429");
      return [];
    };
    const store = new MemoryIntelStore();
    store.enqueue(ca.toBase58());
    const r = await new IntelIndexer({ store, reader, rng: seededRng(5) }).tick();
    expect(r.errors).toBe(1);
    expect(store.safety.has(ca.toBase58())).toBe(false);
    expect(store.lookups).toEqual([ca.toBase58()]);
  });

  it("at most 4 real CAs per batch: at least 4 decoys", () => {
    const real = Array.from({ length: 4 }, keyS);
    const b = assembleBatch(real, Array.from({ length: 10 }, keyS), seededRng(3));
    expect(b.mints).toHaveLength(8);
    expect(b.decoys).toBe(4);
  });

  it("decoys never duplicate a real CA", () => {
    const real = [keyS()];
    const b = assembleBatch(real, [...real, ...real, keyS()], seededRng(4));
    expect(b.mints).toHaveLength(2);
    expect(new Set(b.mints).size).toBe(2);
  });

  it("tick delay is uniform 45–75 s and asOf is floored to the minute", () => {
    const rng = seededRng(5);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const d = nextTickDelay(rng);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    expect(lo).toBeGreaterThanOrEqual(45_000);
    expect(hi).toBeLessThanOrEqual(75_000);
    expect(hi - lo).toBeGreaterThan(29_000);
    expect(tickBoundary(Date.UTC(2026, 9, 12, 12, 3, 41, 500))).toBe(Date.UTC(2026, 9, 12, 12, 3, 0, 0));
  });

  it("warm set: no snapshot first, then stale by 5 / 30 min, at most 20", () => {
    const now = 10 * 3600_000;
    const fresh = { mint: keyS(), hot: true, asOf: now - 60_000 };
    const staleHot = { mint: keyS(), hot: true, asOf: now - 6 * 60_000 };
    const freshCold = { mint: keyS(), hot: false, asOf: now - 20 * 60_000 };
    const none = Array.from({ length: 25 }, () => ({ mint: keyS(), hot: false, asOf: null }));
    const due = pickWarmDue([fresh, staleHot, freshCold, ...none], now, seededRng(6));
    expect(due).toHaveLength(20);
    expect(due).not.toContain(fresh.mint);
    expect(due).not.toContain(freshCold.mint);
    expect(due).not.toContain(staleHot.mint); // 25 without snapshot come first
    expect(pickWarmDue([fresh, staleHot, freshCold], now, seededRng(6))).toEqual([staleHot.mint]);
  });
});

describe("subscriptions change only on a tick, by a fixed number", () => {
  it("adds exactly addsPerTick per tick; real ones first, decoys fill the rest", () => {
    const p = new SubscriptionPlanner(seededRng(8), 4);
    const pool = Array.from({ length: 30 }, keyS);
    const warm = new Set([keyS()]);
    const t1 = p.tick(warm, pool);
    expect(t1.add).toHaveLength(4);
    expect(t1.add).toContain([...warm][0]);
    const more = new Set([...warm, ...Array.from({ length: 6 }, keyS)]);
    expect(p.tick(more, pool).add).toHaveLength(4);
    expect(p.tick(more, pool).add).toHaveLength(4);
    for (const k of more) expect(p.current().has(k)).toBe(true);
    const t4 = p.tick(more, pool);
    expect(t4.add).toHaveLength(4);
    expect(t4.add.every((k) => p.isDecoy(k))).toBe(true);
  });

  it("hot warm curves only; updates buffered to the next tick commit; decoy updates dropped", async () => {
    const reader = new FakeReader();
    const store = new MemoryIntelStore();
    const warmMint = key();
    reader.accounts.set(warmMint.toBase58(), mintAccount(1_000_000_000_000_000n));
    reader.accounts.set(bondingCurvePda(warmMint).toBase58(), await curveAccount(key()));
    reader.recent = Array.from({ length: 20 }, keyS);
    store.pin(warmMint.toBase58(), true);
    const subs: { key: string; cb: (d: Buffer, slot: number) => void }[] = [];
    const watcher: CurveWatcher = {
      subscribe: (k, cb) => (subs.push({ key: k.toBase58(), cb }), subs.length),
      unsubscribe: async () => undefined,
    };
    const idx = new IntelIndexer({ store, reader, rng: seededRng(9), watcher });
    (idx as unknown as { global: unknown }).global = global;
    await idx.tick(); // snapshot (no asOf yet -> first), then subscribe
    const warmCurve = bondingCurvePda(warmMint).toBase58();
    expect(subs.some((s) => s.key === warmCurve)).toBe(true);
    const data = reader.accounts.get(warmCurve)!.data;
    for (const s of subs) s.cb(data, 123);
    expect(store.curves.size).toBe(0); // nothing written outside a tick
    await idx.tick();
    expect([...store.curves.keys()]).toEqual([warmMint.toBase58()]);
    expect(store.subscriptions.length).toBeGreaterThan(0);
  });

  it("polling fallback reads the whole set in one call and reports only changes", async () => {
    let calls = 0;
    const a = key();
    const b = key();
    const datas = new Map([
      [a.toBase58(), Buffer.from([1])],
      [b.toBase58(), Buffer.from([2])],
    ]);
    const conn = {
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
        calls++;
        return { context: { slot: 5 }, value: keys.map((k) => ({ data: datas.get(k.toBase58())!, owner: PUMP_PROGRAM_ID, executable: false, lamports: 1 })) };
      },
    };
    const w = new PollingCurveWatcher(conn as never, seededRng(1));
    const seen: string[] = [];
    w.subscribe(a, () => seen.push("a"));
    w.subscribe(b, () => seen.push("b"));
    w.stop();
    await w.poll();
    await w.poll();
    datas.set(a.toBase58(), Buffer.from([9]));
    await w.poll();
    expect(calls).toBe(3);
    expect(seen.sort()).toEqual(["a", "a", "b"]);
  });
});

describe("top-10 excludes the curve, the AMM pool and pool vaults", () => {
  const supply = 1_000_000_000n;
  const curve = keyS();
  const pool = keyS();
  const vault = keyS();
  const holders = Array.from({ length: 12 }, keyS);
  const acct = (owner: string, amount: bigint, address = keyS()) => ({ address, owner, amount });
  const rows = [
    acct(curve, 700_000_000n),
    acct(pool, 100_000_000n),
    acct(vault, 50_000_000n),
    ...holders.map((h, i) => acct(h, BigInt(10_000_000 - i * 100_000))),
  ];
  const owners = new Map(rows.map((r) => [r.address, r.owner]));
  const largest = rows.map(({ address, amount }) => ({ address, amount }));

  it("concentration counts only real holders, top 10 of them", () => {
    const s = holderStats({
      largest,
      owners,
      supply,
      excludedOwners: new Set([curve, pool]),
      excludedAccounts: new Set(),
      poolVaults: new Set([vault]),
      devOwners: new Set(),
      devBalance: null,
    });
    // top 10 of 10.0M, 9.9M, ... 9.1M = 95.5M of 1B
    expect(s.top10Pct).toBe("9.55");
    expect(s.unzeenPoolPct).toBe("5.00");
    expect(s.devPct).toBeNull();
  });

  it("without the exclusions the curve would dominate (sanity)", () => {
    const s = holderStats({ largest, owners, supply, excludedOwners: new Set(), excludedAccounts: new Set(), poolVaults: new Set(), devOwners: new Set(), devBalance: null });
    expect(Number(s.top10Pct)).toBeGreaterThan(90);
  });

  it("excluded token accounts (curve ATA / mayhem vault) are dropped by address too", () => {
    const curveAta = rows[0]!.address;
    const s = holderStats({
      largest,
      owners: new Map([...owners].filter(([a]) => a !== curveAta)), // owner unknown
      supply,
      excludedOwners: new Set([pool]),
      excludedAccounts: new Set([curveAta]),
      poolVaults: new Set([vault]),
      devOwners: new Set(),
      devBalance: null,
    });
    expect(s.top10Pct).toBe("9.55");
  });

  it("several accounts of one owner are summed", () => {
    const o = keyS();
    const s = holderStats({
      largest: [
        { address: keyS(), amount: 10n },
        { address: keyS(), amount: 15n },
      ],
      owners: new Map(),
      supply: 100n,
      excludedOwners: new Set(),
      excludedAccounts: new Set(),
      poolVaults: new Set(),
      devOwners: new Set([o]),
      devBalance: 25n,
    });
    expect(s.top10Pct).toBe("25.00");
    expect(s.devPct).toBe("25.00");
  });

  it("pct formatting", () => {
    expect(pct(1n, 3n)).toBe("33.33");
    expect(pct(0n, 0n)).toBe("0.00");
    expect(pct(5n, 1n)).toBe("100.00");
    expect(pct(1n, 10_000n)).toBe("0.01");
  });
});

describe("T1: no dev data for Unzeen launches", () => {
  async function setup(unzeen: boolean, creatorInLargest = true, known: "none" | "creatorList" | "vault" = "none") {
    const reader = new FakeReader();
    const store = new MemoryIntelStore();
    const mint = key();
    const creator = key();
    const holder = key();
    const vault = key();
    const supply = 1_000_000_000_000_000n;
    reader.accounts.set(mint.toBase58(), mintAccount(supply));
    reader.accounts.set(bondingCurvePda(mint).toBase58(), await curveAccount(creator));
    const creatorAta = getAssociatedTokenAddressSync(mint, creator, true, TOKEN_PROGRAM_ID);
    reader.accounts.set(creatorAta.toBase58(), tokenAccount(mint, creator, supply / 20n));
    const hAcc = key();
    const vAcc = key();
    reader.accounts.set(hAcc.toBase58(), tokenAccount(mint, holder, supply / 10n));
    reader.accounts.set(vAcc.toBase58(), tokenAccount(mint, vault, supply / 50n));
    reader.largest.set(mint.toBase58(), [
      { address: hAcc.toBase58(), amount: supply / 10n },
      ...(creatorInLargest ? [{ address: creatorAta.toBase58(), amount: supply / 20n }] : []),
      { address: vAcc.toBase58(), amount: supply / 50n },
    ]);
    if (unzeen) store.launches.add(mint.toBase58());
    if (known === "creatorList") store.creators.add(creator.toBase58());
    if (known === "vault") store.vaults.add(creator.toBase58());
    store.vaults.add(vault.toBase58());
    store.enqueue(mint.toBase58());
    const idx = new IntelIndexer({ store, reader, rng: seededRng(11) });
    await idx.tick();
    return { row: store.safety.get(mint.toBase58())!, reader, creatorAta };
  }

  it("T1 race: creator in the relayer's public creator list -> Unzeen launch before trades has it", async () => {
    const { row, reader, creatorAta } = await setup(false, false, "creatorList");
    expect(row.unzeen).toEqual({ launch: true });
    expect(row.holders?.devPct).toBeNull();
    expect(reader.touched().has(creatorAta.toBase58())).toBe(false);
  });

  it("T1 race: creator is a pool vault -> Unzeen launch", async () => {
    const { row } = await setup(false, false, "vault");
    expect(row.unzeen).toEqual({ launch: true });
    expect(row.holders?.devPct).toBeNull();
  });

  it("third-party token: dev share from BondingCurve.creator", async () => {
    const { row, reader } = await setup(false);
    const second = reader.calls.filter((c) => c.method === "getMultipleAccounts").at(-1)!;
    expect(second.keys).toHaveLength(3); // creator ATA is already among the largest: read once
    expect(row.holders?.devPct).toBe("5.00");
    expect(row.holders?.unzeenPoolPct).toBe("2.00");
    expect(row.unzeen).toBeUndefined();
  });

  it("third-party token: dev outside the largest accounts is read via its ATA", async () => {
    const { row, reader, creatorAta } = await setup(false, false);
    expect(row.holders?.devPct).toBe("5.00");
    expect(reader.touched().has(creatorAta.toBase58())).toBe(true);
  });

  it("Unzeen launch: creator ATA is never read", async () => {
    const { row, reader, creatorAta } = await setup(true, false);
    expect(row.holders?.devPct).toBeNull();
    expect(reader.touched().has(creatorAta.toBase58())).toBe(false);
  });

  it("Unzeen launch: devPct null, no dev block", async () => {
    const { row, reader, creatorAta } = await setup(true);
    expect(row.unzeen).toEqual({ launch: true });
    expect(row.holders?.devPct).toBeNull();
    expect(row.dev).toBeUndefined();
    expect(row.firstBlocks).toBeUndefined();
    // No dedicated dev-ATA read: the second batch holds only the largest accounts' owners lookup.
    const second = reader.calls.filter((c) => c.method === "getMultipleAccounts").at(-1)!;
    expect(second.keys).toHaveLength(3);
    expect(creatorAta).toBeDefined();
    expect(row.holders?.unzeenPoolPct).toBe("2.00");
  });
});

describe("pool PDA helpers used for exclusions", () => {
  it("canonical pool PDA is deterministic", () => {
    const m = key();
    expect(canonicalPumpPoolPda(m).equals(canonicalPumpPoolPda(m))).toBe(true);
  });
});

describe("token_safety.data shape (INTEL.md)", () => {
  it("drops mint / asOf / unzeen and holders.asOf; maps unknown venue; T1 devPct null", async () => {
    const d = safetyData({
      mint: "M",
      asOf: 60_000,
      program: "spl-token",
      authorities: { mintRevoked: true, freezeRevoked: true, metadataImmutable: null, riskyExtensions: [] },
      holders: { top10Pct: "1.00", devPct: "2.00", unzeenPoolPct: "0.00", asOf: 60_000 },
      dev: { address: "D", launchesSeen: 1, rugsSeen: 0, since: 0 },
      market: { venue: null, status: "unknown" },
      unzeen: { launch: true },
      name: "n",
    });
    expect(d).toEqual({
      program: "spl-token",
      authorities: { mintRevoked: true, freezeRevoked: true, metadataImmutable: null, riskyExtensions: [] },
      holders: { top10Pct: "1.00", devPct: null, unzeenPoolPct: "0.00" },
      market: { venue: "jupiter", status: "graduated" },
    });
  });
});

describe("public creator list (T1 race)", () => {
  it("the relayer records a creator address when it derives it, before any create is signed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unzeen-creators-"));
    const file = CreatorPubkeyFile.inDir(dir);
    const ring = new CreatorKeyring(Buffer.alloc(64, 7), new MemoryCreatorIndexCounter(), file);
    const i = await ring.allocate();
    const pk = ring.publicKey(i).toBase58();
    expect(new CreatorPubkeyFile(file.file).read().has(pk)).toBe(true);
    const text = fs.readFileSync(file.file, "utf8");
    expect(text).not.toMatch(/seed|secret/i);
    expect(JSON.parse(text)).toEqual({ pubkeys: [pk] });
    fs.rmSync(dir, { recursive: true });
  });
});
