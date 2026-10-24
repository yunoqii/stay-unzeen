import fs from "node:fs";
import path from "node:path";
import { GLOBAL_PDA, PUMP_PROGRAM_ID, bondingCurvePda, canonicalPumpPoolPda } from "@pump-fun/pump-sdk";
import { ammPriceAndCap } from "../src/intel/metrics";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  DBC_CREATE_IX,
  DbcStreamSource,
  Discovery,
  MemoryDiscoveryStore,
  PUMP_MINT_AUTHORITY,
  PumpPollSource,
  dbcCreatesFromNotification,
  dbcStreamRequest,
  loadDiscoveryConfig,
  pumpCreateFromLogs,
  dammV2PoolOf,
  type CreateSeen,
  type CreateSource,
  type DiscoveryChain,
} from "../src/intel/discovery";
import { DBC_PROGRAM_ID } from "../src/meteora";
import BN from "bn.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { LaunchpadPool, getPdaLaunchpadPoolId } from "@raydium-io/raydium-sdk-v2";
import { LAUNCHLAB_PROGRAM } from "../src/launchlab";
import { seededRng } from "../src/relayer/random";

/* Fixtures: public devnet data. pump create 13.10 (scripts: captured once), DBC pool 12.10 (intel-dbc.test). */
const PUMP = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "pump-create-devnet.json"), "utf8")) as {
  signature: string; slot: number; blockTime: number; mint: string; name: string; symbol: string; logs: string[]; curve: { owner: string; data: string };
};
const PARAMS = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "pump-params.json"), "utf8")) as { global: { owner: string; data: string } };
interface FxAcc { address: string; owner: string; lamports: number; data: string }
const DBC = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "dbc-devnet-accounts.json"), "utf8")) as Record<"config" | "pool" | "mint", FxAcc>;
const acc = (owner: string, data: string): AccountInfo<Buffer> => ({ data: Buffer.from(data, "base64"), owner: new PublicKey(owner), lamports: 1, executable: false });

class Chain implements DiscoveryChain {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  readonly txs = new Map<string, string[]>();
  calls = 0;
  keysRead: string[][] = [];
  async getMultipleAccounts(keys: readonly PublicKey[]) {
    this.calls++;
    this.keysRead.push(keys.map((k) => k.toBase58()));
    return keys.map((k) => this.accounts.get(k.toBase58()) ?? null);
  }
  async getLogs(sig: string) {
    this.calls++;
    return this.txs.get(sig) ?? null;
  }
}

/** Every pump curve PDA resolves to the fixture curve (synthetic mints in admission tests). */
class AnyCurveChain extends Chain {
  override async getMultipleAccounts(keys: readonly PublicKey[]) {
    this.calls++;
    return keys.map((k) => (k.equals(GLOBAL_PDA) ? acc(PARAMS.global.owner, PARAMS.global.data) : acc(PUMP.curve.owner, PUMP.curve.data)));
  }
}

class ListSource implements CreateSource {
  readonly name = "list";
  queue: CreateSeen[] = [];
  async drain() {
    const q = this.queue;
    this.queue = [];
    return q;
  }
}

function pumpChain(): Chain {
  const c = new Chain();
  c.accounts.set(GLOBAL_PDA.toBase58(), acc(PARAMS.global.owner, PARAMS.global.data));
  c.accounts.set(bondingCurvePda(new PublicKey(PUMP.mint)).toBase58(), acc(PUMP.curve.owner, PUMP.curve.data));
  for (const f of [DBC.config, DBC.pool, DBC.mint]) c.accounts.set(f.address, acc(f.owner, f.data));
  return c;
}

const T0 = 1_791_900_000_000;
const fakeCreate = (i: number, at = T0): CreateSeen => ({ venue: "pumpfun", signature: `s${i}`, slot: i, createdAt: at + i, mint: Keypair.generate().publicKey.toBase58(), name: `N${i}`, symbol: `S${i}` });

describe("create sources", () => {
  it("pump CreateEvent straight from logs (no extra request)", () => {
    const c = pumpCreateFromLogs({ signature: PUMP.signature, err: null, logs: PUMP.logs })!;
    expect(c).toMatchObject({ venue: "pumpfun", mint: PUMP.mint, name: PUMP.name, symbol: PUMP.symbol });
    expect(Math.abs(c.createdAt! - PUMP.blockTime * 1000)).toBeLessThan(120_000);
    expect(pumpCreateFromLogs({ signature: "x", err: { e: 1 }, logs: PUMP.logs })).toBeNull();
    expect(pumpCreateFromLogs({ signature: "x", err: null, logs: ["Program log: Instruction: Buy"] })).toBeNull();
  });

  it("pump poll: only the mint-authority PDA, cursor via `until`, failed txs dropped", async () => {
    const calls: unknown[][] = [];
    const conn = {
      getSignaturesForAddress: async (...a: unknown[]) => {
        calls.push(a);
        return calls.length === 1
          ? [{ signature: "new", slot: 2, err: null, blockTime: 10 }, { signature: "bad", slot: 1, err: { x: 1 }, blockTime: 9 }]
          : [];
      },
    };
    const s = new PumpPollSource(conn as never, 50);
    expect(await s.drain()).toEqual([{ venue: "pumpfun", signature: "new", slot: 2, createdAt: 10_000 }]);
    await s.drain();
    expect((calls[0]![0] as PublicKey).equals(PUMP_MINT_AUTHORITY)).toBe(true);
    expect(calls[0]![1]).toEqual({ limit: 50 });
    expect(calls[1]![1]).toEqual({ limit: 50, until: "new" });
    // the PDA is create-only: seeds ["mint-authority"] of the pump program
    expect(PUMP_MINT_AUTHORITY.equals(PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PUMP_PROGRAM_ID)[0])).toBe(true);
  });

  it("DBC Parsed Streams: request filters creates; notification -> base_mint / pool / config", () => {
    expect(dbcStreamRequest()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "parsedTransactionSubscribe",
      params: [
        { programs: [DBC_PROGRAM_ID.toBase58()], instructionNames: [...DBC_CREATE_IX], includeFailed: false, includeCpi: true },
        { commitment: "confirmed", details: "matched" },
      ],
    });
    const note = (name: string, status = "ok") => ({
      jsonrpc: "2.0",
      method: "parsedTransactionNotification",
      params: {
        subscription: 1,
        result: {
          context: { slot: 5 },
          value: {
            transaction: { signature: "dsig", slot: 5, blockTime: 1_700_000_000, status },
            instructions: [
              {
                programId: DBC_PROGRAM_ID.toBase58(),
                instructionName: name,
                decoded: {
                  args: { params: { name: "Dee\u0007", symbol: "DBC" } },
                  accounts: [
                    { name: "config", pubkey: DBC.config.address },
                    { name: "base_mint", pubkey: DBC.mint.address },
                    { name: "pool", pubkey: DBC.pool.address },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    expect(dbcCreatesFromNotification(note("initializeVirtualPoolWithToken2022"))).toEqual([
      { venue: "meteora-dbc", signature: "dsig", slot: 5, createdAt: 1_700_000_000_000, mint: DBC.mint.address, name: "Dee\u0007", symbol: "DBC", pool: DBC.pool.address, config: DBC.config.address },
    ]);
    expect(dbcCreatesFromNotification(note("swap"))).toEqual([]);
    expect(dbcCreatesFromNotification(note("initialize_virtual_pool_with_spl_token", "failed"))).toEqual([]);
    expect(dbcCreatesFromNotification({ method: "other" })).toEqual([]);
  });

  it("DBC stream: subscribes on open, budget guard closes it for the rest of the hour, reconnects otherwise", async () => {
    const sockets: { sent: string[]; closed: boolean; fire: Record<string, (e: { data?: unknown }) => void> }[] = [];
    const connect = () => {
      const s = { sent: [] as string[], closed: false, fire: {} as Record<string, (e: { data?: unknown }) => void> };
      sockets.push(s);
      return {
        send: (d: string) => s.sent.push(d),
        close: () => {
          s.closed = true;
        },
        addEventListener: (t: string, f: (e: { data?: unknown }) => void) => {
          s.fire[t] = f;
        },
      };
    };
    const now = T0;
    const src = new DbcStreamSource("wss://example.invalid/?api-key=k", { maxPerHour: 2, connect, now: () => now });
    sockets[0]!.fire.open!({});
    expect(JSON.parse(sockets[0]!.sent[0]!).method).toBe("parsedTransactionSubscribe");
    const msg = (i: number) =>
      JSON.stringify({
        method: "parsedTransactionNotification",
        params: { result: { value: { transaction: { signature: `d${i}`, slot: i, status: "ok" }, instructions: [{ programId: DBC_PROGRAM_ID.toBase58(), instructionName: "initialize_virtual_pool_with_spl_token", decoded: { accounts: [{ name: "base_mint", pubkey: Keypair.generate().publicKey.toBase58() }] } }] } } },
      });
    src.onMessage(msg(1));
    expect(sockets[0]!.closed).toBe(false);
    src.onMessage(msg(2));
    expect(sockets[0]!.closed).toBe(true); // 2 events = hourly cap
    expect((await src.drain()).map((c) => c.signature)).toEqual(["d1", "d2"]);
    expect(await src.drain()).toEqual([]);
    src.stop();
  });
});

describe("Discovery tick", () => {
  it("admission: burst first, then max/window per tick; newest first; never above max", async () => {
    const chain = new AnyCurveChain();
    const src = new ListSource();
    const store = new MemoryDiscoveryStore();
    let now = T0;
    const d = new Discovery({ store, chain, sources: [src], rng: seededRng(1), now: () => now, max: 12, windowMs: 3_600_000, burst: 5 });
    src.queue = Array.from({ length: 20 }, (_, i) => fakeCreate(i));
    let r = await d.tick();
    expect(r.admitted).toBe(5);
    expect(store.list().map((c) => c.name)).toEqual(["N19", "N18", "N17", "N16", "N15"]);
    // 1 h window, max 12 -> one admission per 5 min
    now += 60_000;
    src.queue = Array.from({ length: 5 }, (_, i) => fakeCreate(100 + i, now));
    r = await d.tick();
    expect(r.admitted).toBe(0);
    now += 5 * 60_000;
    src.queue = Array.from({ length: 5 }, (_, i) => fakeCreate(200 + i, now));
    r = await d.tick();
    expect(r.admitted).toBe(1);
    // cap
    now += 10 * 3_600_000; // window passed: everything above is removed, bucket full again (burst 5)
    for (let k = 0; k < 4; k++) {
      src.queue = Array.from({ length: 10 }, (_, i) => fakeCreate(1000 + k * 10 + i, now));
      await d.tick();
      now += 3_600_000 / 2;
    }
    expect(store.list().length).toBeLessThanOrEqual(12);
  });

  it("window: candidates older than the window are removed; dedupe across ticks", async () => {
    const chain = new AnyCurveChain();
    const src = new ListSource();
    const store = new MemoryDiscoveryStore();
    let now = T0;
    const d = new Discovery({ store, chain, sources: [src], rng: seededRng(1), now: () => now, max: 50, windowMs: 3_600_000, burst: 50 });
    const c = fakeCreate(1, now);
    src.queue = [c, { ...c }];
    expect((await d.tick()).admitted).toBe(1);
    src.queue = [{ ...c }];
    expect((await d.tick()).admitted).toBe(0);
    now += 3_600_001 + 10;
    const r = await d.tick();
    expect(r.removed).toBe(1);
    expect(store.rows.size).toBe(0);
  });

  it("pump poll creates are resolved only when admitted; metrics from the curve on the tick", async () => {
    const chain = pumpChain();
    chain.txs.set(PUMP.signature, PUMP.logs);
    const src = new ListSource();
    src.queue = [
      { venue: "pumpfun", signature: PUMP.signature, slot: PUMP.slot, createdAt: PUMP.blockTime * 1000 },
      { venue: "pumpfun", signature: "unreadable", slot: 1, createdAt: PUMP.blockTime * 1000 - 1 },
    ];
    const store = new MemoryDiscoveryStore();
    const d = new Discovery({ store, chain, sources: [src], rng: seededRng(2), now: () => PUMP.blockTime * 1000 + 60_000, burst: 1 });
    const r = await d.tick();
    expect(r.admitted).toBe(1); // the readable one (newest); the other one never fetched (no allowance left)
    const row = store.rows.get(PUMP.mint)!;
    expect(row).toMatchObject({ venue: "pumpfun", name: PUMP.name, symbol: PUMP.symbol, status: "curve" });
    expect(Number(row.priceSol)).toBeGreaterThan(0);
    expect(Number(row.marketCapSol)).toBeGreaterThan(0);
    expect(row.progressPct).toMatch(/^\d{1,3}\.\d{2}$/);
    expect(row.asOf % 60_000).toBe(0);
    // one getTransaction (admitted only) + one getMultipleAccounts
    expect(chain.calls).toBe(2);
    expect(chain.keysRead[0]).toEqual([GLOBAL_PDA.toBase58(), bondingCurvePda(new PublicKey(PUMP.mint)).toBase58()]);
  });

  it("an unreadable create costs no allowance; a non-curve mint is dropped", async () => {
    const chain = pumpChain();
    const src = new ListSource();
    src.queue = [
      { venue: "pumpfun", signature: "unreadable", slot: 9, createdAt: T0 + 9 },
      { venue: "pumpfun", signature: "nocurve", slot: 8, createdAt: T0 + 8, mint: Keypair.generate().publicKey.toBase58() },
    ];
    const store = new MemoryDiscoveryStore();
    const d = new Discovery({ store, chain, sources: [src], rng: seededRng(2), now: () => T0 + 60_000, burst: 1 });
    const r = await d.tick();
    expect(r.errors).toBeGreaterThanOrEqual(1);
    expect(r.admitted).toBe(1);
    expect(store.rows.size).toBe(0); // admitted, then no pump curve -> removed in the same tick
  });

  it("DBC: pool + config + mint read on the tick; price, progress, name from on-mint metadata", async () => {
    const chain = pumpChain();
    const src = new ListSource();
    src.queue = [{ venue: "meteora-dbc", signature: "d", slot: 1, createdAt: T0, mint: DBC.mint.address, pool: DBC.pool.address, config: DBC.config.address }];
    const store = new MemoryDiscoveryStore();
    let now = T0 + 60_000;
    const d = new Discovery({ store, chain, sources: [src], rng: seededRng(3), now: () => now });
    await d.tick();
    const row = store.rows.get(DBC.mint.address)!;
    expect(row).toMatchObject({ venue: "meteora-dbc", status: "curve", pool: DBC.pool.address });
    expect(Number(row.priceSol)).toBeGreaterThan(0);
    expect(row.progressPct).toMatch(/^\d{1,3}\.\d{2}$/);
    expect(row.symbol).not.toBeNull();
    // next tick: config and mint are cached, only Global + pool are read
    now += 60_000;
    await d.tick();
    expect(chain.keysRead.at(-1)).toEqual([GLOBAL_PDA.toBase58(), DBC.pool.address]);
  });

  it("LaunchLab (API v0.28, with launchLabProgram): SOL pool PDA + mint read; price, progress; non-SOL pool dropped", async () => {
    const program = LAUNCHLAB_PROGRAM["mainnet-beta"];
    const mint = new PublicKey(DBC.mint.address);
    const chain = pumpChain();
    const pool = LaunchpadPool.decode(Buffer.alloc(LaunchpadPool.span));
    const s0 = 30_000_000_000n;
    const t0 = 1_073_000_000_000_000n;
    Object.assign(pool, {
      mintA: mint, mintB: NATIVE_MINT, status: 0, virtualA: new BN(t0.toString()), virtualB: new BN(s0.toString()),
      realA: new BN(100_000_000_000_000), realB: new BN(8_500_000_000), totalFundRaisingB: new BN(85_000_000_000), supply: new BN(10n ** 15n + ""),
    });
    const buf = Buffer.alloc(LaunchpadPool.span);
    LaunchpadPool.encode(pool, buf);
    chain.accounts.set(getPdaLaunchpadPoolId(program, mint, NATIVE_MINT).publicKey.toBase58(), { data: buf, owner: program, lamports: 1, executable: false });
    const src = new ListSource();
    const other = Keypair.generate().publicKey.toBase58();
    src.queue = [
      { venue: "raydium-launchlab", signature: "l1", slot: 1, createdAt: T0, mint: mint.toBase58() },
      { venue: "raydium-launchlab", signature: "l2", slot: 2, createdAt: T0, mint: other }, // no SOL pool
    ];
    const store = new MemoryDiscoveryStore();
    const d = new Discovery({ store, chain, sources: [src], rng: seededRng(3), now: () => T0 + 60_000, launchLabProgram: program });
    await d.tick();
    const row = store.rows.get(mint.toBase58())!;
    expect(row).toMatchObject({ venue: "raydium-launchlab", status: "curve", progressPct: "10.00" });
    // price = (vB + rB) / (vA − rA) lamports per base unit
    const want = Number(s0 + 8_500_000_000n) / Number(t0 - 100_000_000_000_000n) * 1e6 / 1e9;
    expect(Number(row.priceSol)).toBeCloseTo(want, 12);
    expect(store.rows.has(other)).toBe(false);
    // without the program: LaunchLab creates are dev index only (as before)
    const src2 = new ListSource();
    src2.queue = [{ venue: "raydium-launchlab", signature: "l3", slot: 3, createdAt: T0, mint: mint.toBase58() }];
    const store2 = new MemoryDiscoveryStore();
    await new Discovery({ store: store2, chain, sources: [src2], rng: seededRng(3), now: () => T0 + 60_000 }).tick();
    expect(store2.rows.size).toBe(0);
  });

  it("nothing is read outside a tick (no on-demand requests)", async () => {
    const chain = pumpChain();
    const d = new Discovery({ store: new MemoryDiscoveryStore(), chain, sources: [new ListSource()], rng: seededRng(4), now: () => T0 });
    expect(chain.calls).toBe(0);
    await d.tick();
    expect(chain.calls).toBe(1); // only the metrics batch (Global)
    expect(d).not.toHaveProperty("lookup");
  });

  it("restart: candidates come back from the store", async () => {
    const store = new MemoryDiscoveryStore();
    const chain = pumpChain();
    const src = new ListSource();
    src.queue = [{ venue: "pumpfun", signature: "a", slot: 1, createdAt: T0, mint: PUMP.mint, name: "X", symbol: "Y" }];
    await new Discovery({ store, chain, sources: [src], rng: seededRng(1), now: () => T0 + 60_000 }).tick();
    const d2 = new Discovery({ store, chain, sources: [new ListSource()], rng: seededRng(1), now: () => T0 + 120_000 });
    const r = await d2.tick();
    expect(r.active).toBe(1);
    expect(store.rows.get(PUMP.mint)!.asOf).toBe(T0 + 120_000 - ((T0 + 120_000) % 60_000));
  });
});

describe("Discovery fast pass (INTEL_DISCOVERY_TICK_SECS)", () => {
  it("collect: a new create is committed in the same pass with its metrics; only the admitted are read", async () => {
    const chain = pumpChain();
    chain.txs.set(PUMP.signature, PUMP.logs);
    const src = new ListSource();
    const store = new MemoryDiscoveryStore();
    let now = PUMP.blockTime * 1000 + 3_000;
    const d = new Discovery({ store, chain, sources: [src], rng: seededRng(5), now: () => now });
    await d.refresh(); // an earlier metrics pass (nothing active)
    chain.keysRead = [];
    src.queue = [{ venue: "pumpfun", signature: PUMP.signature, slot: PUMP.slot, createdAt: PUMP.blockTime * 1000 }];
    const r = await d.collect();
    expect(r.admitted).toBe(1);
    expect(r.nextInMs).toBeGreaterThanOrEqual(3_000);
    expect(r.nextInMs).toBeLessThanOrEqual(5_000);
    expect(r.lagMaxMs).toBe(3_000);
    const row = store.rows.get(PUMP.mint)!;
    expect(Number(row.marketCapSol)).toBeGreaterThan(0);
    expect(chain.keysRead).toEqual([[GLOBAL_PDA.toBase58(), bondingCurvePda(new PublicKey(PUMP.mint)).toBase58()]]);
    expect(d.activeMints()).toEqual([PUMP.mint]);
    // an empty pass reads nothing but the pump poll (none here) and commits nothing
    const commits = store.commits;
    now += 4_000;
    const e = await d.collect();
    expect(e.reads).toBe(0);
    expect(store.commits).toBe(commits);
  });

  it("collect: a create whose curve is not there is never published (not in the store, not in the warm set)", async () => {
    const chain = pumpChain();
    const src = new ListSource();
    const store = new MemoryDiscoveryStore();
    const d = new Discovery({ store, chain, sources: [src], rng: seededRng(6), now: () => T0 });
    src.queue = [{ venue: "pumpfun", signature: "x", slot: 1, createdAt: T0 - 1_000, mint: Keypair.generate().publicKey.toBase58() }];
    const r = await d.collect();
    expect(r.admitted).toBe(1);
    expect(store.rows.size).toBe(0);
    expect(d.activeMints()).toEqual([]);
    expect(r.active).toBe(0);
  });

  it("collect does not apply the window; refresh does (and reads every candidate in one batch)", async () => {
    const chain = new AnyCurveChain();
    const src = new ListSource();
    const store = new MemoryDiscoveryStore();
    let now = T0;
    const d = new Discovery({ store, chain, sources: [src], rng: seededRng(7), now: () => now, windowMs: 3_600_000, burst: 50, max: 50 });
    src.queue = Array.from({ length: 3 }, (_, i) => fakeCreate(i, now));
    await d.collect();
    expect(store.rows.size).toBe(3);
    now += 3_600_000 + 100;
    await d.collect();
    expect(store.rows.size).toBe(3);
    const r = await d.refresh();
    expect(r.removed).toBe(3);
    expect(store.rows.size).toBe(0);
  });

  it("run: fast passes every ~passMs, ONE aggregated report per metrics pass", async () => {
    const chain = new AnyCurveChain();
    const src = new ListSource();
    const store = new MemoryDiscoveryStore();
    const d = new Discovery({ store, chain, sources: [src], rng: seededRng(8), passMs: 1_000, burst: 50, max: 50 });
    const reports: Array<{ passes?: number; admitted: number }> = [];
    const ac = new AbortController();
    src.queue = [fakeCreate(1, Date.now())];
    const done = d.run(ac.signal, (r) => reports.push(r));
    await new Promise((r) => setTimeout(r, 2_600));
    src.queue = [fakeCreate(2, Date.now())];
    await new Promise((r) => setTimeout(r, 1_400));
    ac.abort();
    await done;
    // the metrics pass is 45–75 s: only its first run reported, the rest are folded fast passes
    expect(reports.length).toBe(1);
    expect(store.rows.size).toBe(2); // the second create landed through a fast pass, no metrics pass in between
  }, 10_000);
});

describe("graduated prices (AMM)", () => {
  it("ammPriceAndCap: SOL per whole token from the reserves, cap = price x supply", () => {
    // 85 SOL against 200M tokens (6 decimals), 1B supply
    const r = ammPriceAndCap(200_000_000n * 10n ** 6n, 85n * 10n ** 9n, 6, 1_000_000_000n * 10n ** 6n)!;
    expect(r.priceSol).toBe("0.000000425");
    expect(r.marketCapSol).toBe("425");
    expect(ammPriceAndCap(0n, 1n, 6, null)).toBeNull();
  });

  it("dammV2PoolOf: the pool a DBC launch migrated to (mainnet 24.10: RCws.. -> EtZu..)", () => {
    const cfg = { migrationOption: 1, migrationFeeOption: 6, quoteMint: NATIVE_MINT };
    expect(dammV2PoolOf(cfg, new PublicKey("RCwsR2zbS8h9CLg6uGjqB2BVBZ2zpdEHRaVFdA5FeEP"))!.toBase58()).toBe("EtZurYTvvLVc2zGrTf75ivpvs52H163WyDKNt3mpeUo");
    expect(dammV2PoolOf({ ...cfg, migrationOption: 0 }, NATIVE_MINT)).toBeNull(); // DAMM v1
  });

  it("graduated pump coin: PumpSwap pool, then its vaults (same pass), price from the reserves", async () => {
    const chain = pumpChain();
    const mint = new PublicKey(PUMP.mint);
    const curve = Buffer.from(PUMP.curve.data, "base64");
    curve[48] = 1; // complete
    chain.accounts.set(bondingCurvePda(mint).toBase58(), { data: curve, owner: new PublicKey(PUMP.curve.owner), lamports: 1, executable: false });
    const baseVault = Keypair.generate().publicKey;
    const quoteVault = Keypair.generate().publicKey;
    const pool = Buffer.alloc(8 + 1 + 2 + 32 * 6 + 8);
    NATIVE_MINT.toBuffer().copy(pool, 8 + 1 + 2 + 64);
    baseVault.toBuffer().copy(pool, 8 + 1 + 2 + 32 * 4);
    quoteVault.toBuffer().copy(pool, 8 + 1 + 2 + 32 * 5);
    chain.accounts.set(canonicalPumpPoolPda(mint).toBase58(), { data: pool, owner: PUMP_PROGRAM_ID, lamports: 1, executable: false });
    const ta = (amount: bigint) => {
      const b = Buffer.alloc(165);
      b.writeBigUInt64LE(amount, 64);
      return { data: b, owner: PUMP_PROGRAM_ID, lamports: 1, executable: false };
    };
    chain.accounts.set(baseVault.toBase58(), ta(200_000_000n * 10n ** 6n));
    chain.accounts.set(quoteVault.toBase58(), ta(85n * 10n ** 9n));
    const src = new ListSource();
    src.queue = [{ venue: "pumpfun", signature: "g", slot: 1, createdAt: T0, mint: PUMP.mint, name: "G", symbol: "G" }];
    const store = new MemoryDiscoveryStore();
    let now = T0 + 60_000;
    const d = new Discovery({ store, chain, sources: [src], rng: seededRng(9), now: () => now });
    await d.tick(); // learns "graduated" from the curve
    expect(store.rows.get(PUMP.mint)!.status).toBe("graduated");
    now += 60_000;
    await d.refresh(); // pool account -> vaults -> price
    expect(store.rows.get(PUMP.mint)).toMatchObject({ priceSol: "0.000000425", marketCapSol: "425", progressPct: null });
    now += 60_000;
    chain.keysRead = [];
    await d.refresh(); // vaults known: read directly in the batch
    expect(chain.keysRead).toEqual([[GLOBAL_PDA.toBase58(), bondingCurvePda(mint).toBase58(), baseVault.toBase58(), quoteVault.toBase58()]]);
  });
});

describe("config", () => {
  it("fast pass period: INTEL_DISCOVERY_TICK_SECS (default 4 s, 1..60)", () => {
    expect(loadDiscoveryConfig("mainnet-beta", {}).passMs).toBe(4_000);
    expect(loadDiscoveryConfig("mainnet-beta", { INTEL_DISCOVERY_TICK_SECS: "3" }).passMs).toBe(3_000);
    expect(() => loadDiscoveryConfig("mainnet-beta", { INTEL_DISCOVERY_TICK_SECS: "0.5" })).toThrow();
  });

  it("OFF by default; mainnet DBC stream URL from the Helius key; DBC can be switched off", () => {
    expect(loadDiscoveryConfig("devnet", {}).enabled).toBe(false);
    const m = loadDiscoveryConfig("mainnet-beta", { INTEL_DISCOVERY: "1", SOLANA_RPC_URL_MAINNET: "https://mainnet.helius-rpc.com/?api-key=abc" });
    expect(m).toMatchObject({ enabled: true, max: 200, windowMs: 6 * 3_600_000, burst: 10, pump: "poll", rpcSource: "SOLANA_RPC_URL_MAINNET" });
    expect(m.dbcStreamUrl).toBe("wss://beta.helius-rpc.com/?api-key=abc");
    expect(m.wsUrl).toBe("wss://mainnet.helius-rpc.com/?api-key=abc");
    expect(loadDiscoveryConfig("mainnet-beta", { INTEL_DISCOVERY_DBC: "0", SOLANA_RPC_URL_MAINNET: "https://x/?api-key=abc" }).dbcStreamUrl).toBeNull();
    expect(loadDiscoveryConfig("devnet", { SOLANA_RPC_URL_DEVNET: "https://devnet.helius-rpc.com/?api-key=abc" }).dbcStreamUrl).toBeNull();
    expect(() => loadDiscoveryConfig("devnet", { INTEL_DISCOVERY_PUMP: "x" })).toThrow();
    expect(() => loadDiscoveryConfig("devnet", { INTEL_DISCOVERY_MAX: "0" })).toThrow();
  });
});
