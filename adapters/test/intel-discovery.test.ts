import fs from "node:fs";
import path from "node:path";
import { GLOBAL_PDA, PUMP_PROGRAM_ID, bondingCurvePda } from "@pump-fun/pump-sdk";
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
  type CreateSeen,
  type CreateSource,
  type DiscoveryChain,
} from "../src/intel/discovery";
import { DBC_PROGRAM_ID } from "../src/meteora";
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

describe("config", () => {
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
