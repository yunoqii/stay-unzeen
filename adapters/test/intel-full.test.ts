import fs from "node:fs";
import path from "node:path";
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, type AccountInfo, type VersionedTransactionResponse } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { DevIndex, MemoryCreateIndex, RpcRugChecker, RUG_WINDOW_MS, createRecords, isRug } from "../src/intel/dev-index";
import { Discovery, MemoryDiscoveryStore, launchLabCreatesFromNotification, type CreateSeen, type CreateSource } from "../src/intel/discovery";
import { firstBlockFacts } from "../src/intel/full";
import { IntelIndexer } from "../src/intel/indexer";
import { MemoryIntelStore } from "../src/intel/memory-store";
import type { ChainReader } from "../src/intel/reader";
import { ParsedTradeStream, tagTrade, tradeStreamRequest, tradesFromParsedTx, type MarketTrade, type TradeSource } from "../src/intel/trades";
import { seededRng } from "../src/relayer/random";

/*
 * Full intel tier (INTEL_FULL / UNZEEN_INTEL_FULL_TRADES). Fixtures: Helius Parsed Streams
 * notifications captured on mainnet 13.10 (parsed-streams-trades.json: pump.fun SOL buys, DBC SOL
 * swaps, a DBC USDC swap, LaunchLab trades in non-SOL quotes, a LaunchLab create), and the DBC
 * devnet e2e txs (dbc-devnet-txs.json). Public chain data only.
 */
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "parsed-streams-trades.json"), "utf8")) as Record<"pump" | "dbc" | "dbcUsdc" | "ll" | "llCreate", { value: unknown }[]>;
const WSOL = "So11111111111111111111111111111111111111112";
const T = 1_791_900_000_000;

describe("trade feed: Parsed Streams notifications -> market trades", () => {
  it("pump.fun: TradeEvent amounts, user, timestamp (SOL curves)", () => {
    const [t] = tradesFromParsedTx(FX.pump[1]!.value, T);
    expect(t).toMatchObject({ venue: "pumpfun", kind: "buy", mint: "6B2BVDjWQmDUaQRULKAKzAUnnB8D9JYYJXp1Czdspump", trader: "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s", solAmount: 289_021_922n, tokenAmount: 27_982_210_097_837n, ts: 1_791_892_627_000 });
    expect(t!.ix).toBeGreaterThan(0);
  });
  it("Meteora DBC: EvtSwap2 + swap2 payer / base mint; sell and buy directions; USDC pools skipped", () => {
    const all = FX.dbc.flatMap((n) => tradesFromParsedTx(n.value, T));
    expect(all).toHaveLength(2);
    for (const t of all) {
      expect(t.venue).toBe("meteora-dbc");
      expect(t.solAmount).toBeGreaterThan(0n);
      expect(t.tokenAmount).toBeGreaterThan(0n);
    }
    expect(new Set(all.map((t) => t.kind))).toEqual(new Set(["sell", "buy"]));
    expect(tradesFromParsedTx(FX.dbcUsdc[0]!.value, T)).toEqual([]);
  });
  it("LaunchLab: non-SOL quotes skipped; the same notification with WSOL as quote parses (amount_in / amount_out, receipt time)", () => {
    expect(FX.ll.flatMap((n) => tradesFromParsedTx(n.value, T))).toEqual([]);
    const v = structuredClone(FX.ll[0]!.value) as { instructions: { decoded?: { accounts?: { name: string; pubkey: string }[] } }[] };
    for (const ix of v.instructions) for (const a of ix.decoded?.accounts ?? []) if (a.name === "quote_token_mint") a.pubkey = WSOL; // synthetic: SOL pair
    const [t] = tradesFromParsedTx(v, T);
    const ev = (v.instructions as { instructionName?: string; decoded?: { args?: Record<string, string> } }[]).find((i) => i.instructionName === "TradeEvent")!.decoded!.args!;
    expect(ev.trade_direction).toBe("Sell");
    expect(t).toMatchObject({ venue: "raydium-launchlab", kind: "sell", tokenAmount: BigInt(ev.amount_in!), solAmount: BigInt(ev.amount_out!), trader: "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD", ts: T });
  });
  it("failed or unknown transactions give nothing", () => {
    const v = structuredClone(FX.pump[0]!.value) as { transaction: { status: string } };
    v.transaction.status = "failed";
    expect(tradesFromParsedTx(v, T)).toEqual([]);
    expect(tradesFromParsedTx(null, T)).toEqual([]);
  });
  it("subscription: three programs, their trade instructions, accounts = the mints, failed excluded", () => {
    const r = tradeStreamRequest(["M1", "M2"]) as { method: string; params: [{ programs: string[]; accounts: { include: string[] }; includeFailed: boolean; instructionNames: string[] }, { details: string }] };
    expect(r.method).toBe("parsedTransactionSubscribe");
    expect(r.params[0].programs).toHaveLength(3);
    expect(r.params[0].accounts.include).toEqual(["M1", "M2"]);
    expect(r.params[0].includeFailed).toBe(false);
    expect(r.params[0].instructionNames).toEqual(expect.arrayContaining(["buy", "sell", "swap2", "buy_exact_in", "sell_exact_in"]));
    expect(r.params[1].details).toBe("full");
  });
});

describe("tags: whale / dev / sniper (T1)", () => {
  const base: MarketTrade = { mint: "M", kind: "buy", venue: "pumpfun", trader: "U", tokenAmount: 1n, solAmount: 1n, signature: "s", ix: 1, slot: 100, ts: T };
  const ctx = { poolVaults: new Set(["V"]), unzeenLaunches: new Set(["UNZ"]), devOf: (m: string) => (m === "M" || m === "UNZ" ? "D" : undefined), createSlotOf: () => 98, whaleLamports: 1_000_000_000n, sniperSlots: 4 };
  it("whale by size; sniper = buy within the window; dev = the create signer", () => {
    expect(tagTrade({ ...base, solAmount: 2_000_000_000n }, ctx).tags).toEqual(["whale", "sniper"]);
    expect(tagTrade({ ...base, slot: 110 }, ctx).tags).toEqual([]);
    expect(tagTrade({ ...base, kind: "sell" }, ctx).tags).toEqual([]);
    expect(tagTrade({ ...base, trader: "D" }, ctx).tags).toEqual(["dev"]); // the dev is not a sniper of its own token
  });
  it("T1: Unzeen launches never get a dev tag; pool vault trades are `unzeen`, never dev / sniper", () => {
    expect(tagTrade({ ...base, mint: "UNZ", trader: "D" }, ctx).tags).not.toContain("dev");
    const v = tagTrade({ ...base, trader: "V", solAmount: 5_000_000_000n }, { ...ctx, devOf: () => "V" });
    expect(v).toEqual({ unzeen: true, tags: ["whale"] });
  });
});

// ---------------------------------------------------------------------------
// stream client
// ---------------------------------------------------------------------------

class FakeWs {
  readonly sent: unknown[] = [];
  closed = false;
  private readonly h: Record<string, ((e: { data?: unknown }) => void)[]> = {};
  addEventListener(t: string, f: (e: { data?: unknown }) => void) {
    (this.h[t] ??= []).push(f);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.closed = true;
    for (const f of this.h.close ?? []) f({});
  }
  emit(t: string, data?: unknown) {
    for (const f of this.h[t] ?? []) f({ data });
  }
}

describe("ParsedTradeStream", () => {
  it("connects only when there are mints; set changes re-subscribe; notifications kept for current mints only", () => {
    const sockets: FakeWs[] = [];
    let now = T;
    const s = new ParsedTradeStream("wss://x", { now: () => now, connect: () => (sockets.push(new FakeWs()), sockets.at(-1)! as never) });
    s.setMints([]);
    expect(sockets).toHaveLength(0);
    s.setMints(["6B2BVDjWQmDUaQRULKAKzAUnnB8D9JYYJXp1Czdspump"]);
    const ws = sockets[0]!;
    ws.emit("open");
    const sub = ws.sent[0] as { id: number; method: string };
    expect(sub.method).toBe("parsedTransactionSubscribe");
    ws.emit("message", JSON.stringify({ id: sub.id, result: 77 }));
    for (const n of FX.pump) ws.emit("message", JSON.stringify({ method: "parsedTransactionNotification", params: { result: n } }));
    expect(s.drain().map((t) => t.mint)).toEqual(["6B2BVDjWQmDUaQRULKAKzAUnnB8D9JYYJXp1Czdspump"]); // the other mint is not subscribed
    s.setMints(["6B2BVDjWQmDUaQRULKAKzAUnnB8D9JYYJXp1Czdspump"]); // same set: nothing sent
    expect(ws.sent).toHaveLength(1);
    s.setMints(["A", "B"]);
    expect(ws.sent.slice(1).map((m) => (m as { method: string }).method)).toEqual(["parsedTransactionUnsubscribe", "parsedTransactionSubscribe"]);
    expect((ws.sent[1] as { params: number[] }).params).toEqual([77]);
    now += 1;
  });
  it("budget guard: past maxPerHour the stream is closed until the hour ends", () => {
    const sockets: FakeWs[] = [];
    const s = new ParsedTradeStream("wss://x", { maxPerHour: 2, now: () => T, connect: () => (sockets.push(new FakeWs()), sockets.at(-1)! as never) });
    s.setMints(["6B2BVDjWQmDUaQRULKAKzAUnnB8D9JYYJXp1Czdspump"]);
    sockets[0]!.emit("open");
    for (const n of FX.pump) sockets[0]!.emit("message", JSON.stringify({ method: "parsedTransactionNotification", params: { result: n } }));
    expect(s.events).toBe(2);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets).toHaveLength(1); // no immediate reconnect
    s.stop();
  });
});

// ---------------------------------------------------------------------------
// indexer integration: subscription set on the tick, decoys dropped, rows tagged
// ---------------------------------------------------------------------------

function mintAccount(): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1_000_000_000_000_000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  return { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
}

class Reader implements ChainReader {
  readonly hasIndex = false;
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  recent: string[] = [];
  async getMultipleAccounts(keys: readonly PublicKey[]) {
    return keys.map((k) => this.accounts.get(k.toBase58()) ?? null);
  }
  async getTokenLargestAccounts() {
    return null;
  }
  async recentPumpMints() {
    return this.recent;
  }
}

class FakeTrades implements TradeSource {
  readonly sets: string[][] = [];
  queue: MarketTrade[] = [];
  setMints(m: readonly string[]) {
    this.sets.push([...m]);
  }
  drain() {
    const q = this.queue;
    this.queue = [];
    return q;
  }
  stop() {}
}

describe("indexer + trade feed (UNZEEN_INTEL_FULL_TRADES=1)", () => {
  it("hot warm mints (+ decoys) are subscribed on the tick; their trades land tagged with symbol / decimals; decoy trades never", async () => {
    const store = new MemoryIntelStore();
    const reader = new Reader();
    const hot = Keypair.generate().publicKey.toBase58();
    reader.accounts.set(hot, mintAccount());
    reader.recent = Array.from({ length: 20 }, () => Keypair.generate().publicKey.toBase58());
    for (const m of reader.recent) reader.accounts.set(m, mintAccount());
    store.warm.set(hot, { hot: true, pinned: true, expiresAt: null });
    const trades = new FakeTrades();
    const idx = new IntelIndexer({ store, reader, rng: seededRng(4), sleep: async () => undefined, trades: { source: trades, whaleLamports: 1_000_000_000n, sniperSlots: 4 } });
    await idx.tick();
    const set = trades.sets.at(-1)!;
    expect(set).toContain(hot);
    expect(set.length).toBeGreaterThan(1); // decoys ride along
    const decoy = set.find((m) => m !== hot)!;
    const t = (mint: string, sig: string, sol: bigint): MarketTrade => ({ mint, kind: "buy", venue: "pumpfun", trader: "T", tokenAmount: 5n, solAmount: sol, signature: sig, ix: 3, slot: 1, ts: T });
    trades.queue = [t(hot, "s1", 2_000_000_000n), t(decoy, "s2", 1n), t(hot, "s1", 2_000_000_000n)];
    const r = await idx.tick();
    expect(r.trades).toBe(2); // the replay is de-duplicated by the store (UNIQUE signature, ix)
    expect([...store.marketTrades.values()]).toEqual([expect.objectContaining({ mint: hot, decimals: 6, tags: ["whale"], unzeen: false })]);
  });
});

// ---------------------------------------------------------------------------
// first blocks, any venue (DBC devnet e2e 13.10)
// ---------------------------------------------------------------------------

interface FxTx { signature: string; slot: number; blockTime: number; accountKeys: string[]; meta: Record<string, unknown> }
const DBC = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "dbc-devnet-txs.json"), "utf8")) as Record<"create" | "buy" | "sell", FxTx>;
function txOf(f: FxTx): VersionedTransactionResponse {
  const keys = f.accountKeys.map((k) => new PublicKey(k));
  return {
    slot: f.slot,
    blockTime: f.blockTime,
    meta: { ...f.meta, err: null, loadedAddresses: undefined },
    transaction: { message: { staticAccountKeys: keys, getAccountKeys: () => ({ get: (i: number) => keys[i], length: keys.length }) }, signatures: [f.signature] },
  } as unknown as VersionedTransactionResponse;
}
const DBC_MINT = new PublicKey("55JhCAf4F6rNnXDq2WiU9z96RZ6YM9KHEckBkYEh8CtY");

describe("first blocks: DBC create and trades from the mint's own transactions", () => {
  it("create: the pool, the creator; buy / sell: trader = fee payer, pool-matched", () => {
    const c = firstBlockFacts(txOf(DBC.create), DBC_MINT);
    expect(c.createUser).not.toBeNull();
    expect(c.pools).toHaveLength(1);
    const b = firstBlockFacts(txOf(DBC.buy), DBC_MINT);
    const s = firstBlockFacts(txOf(DBC.sell), DBC_MINT);
    expect(b.trades[0]).toMatchObject({ isBuy: true, user: DBC.buy.accountKeys[0], pool: c.pools[0] });
    expect(s.trades[0]).toMatchObject({ isBuy: false, user: DBC.sell.accountKeys[0] });
    expect(b.trades[0]!.tokenAmount).toBeGreaterThan(0n);
  });
});

// ---------------------------------------------------------------------------
// dev index
// ---------------------------------------------------------------------------

describe("dev index: launches seen by our create streams, rugs checked lazily", () => {
  it("LaunchLab create notification -> creator, mint, name (mainnet sample 13.10)", () => {
    const [c] = launchLabCreatesFromNotification({ method: "parsedTransactionNotification", params: { result: FX.llCreate[0] } });
    expect(c).toMatchObject({ venue: "raydium-launchlab", name: "Pengu CNY", symbol: "PenguCNY" });
    expect(c!.creator).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(c!.mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
  it("rug rule: sold >= 50 % of what it bought", () => {
    expect(isRug(100n, 50n)).toBe(true);
    expect(isRug(100n, 49n)).toBe(false);
    expect(isRug(0n, 10n)).toBe(false);
  });
  it("counts launches, evaluates at most N old launches per lookup, caches the answer, never young ones", async () => {
    const store = new MemoryCreateIndex();
    const now = T;
    const old = (i: number) => ({ venue: "pumpfun" as const, signature: `s${i}`, slot: i, createdAt: now - RUG_WINDOW_MS - i * 1000, mint: `M${i}`, creator: "D" });
    await store.record(createRecords([old(1), old(2), old(3), old(4), { ...old(5), createdAt: now - 1_000 }, { ...old(6), creator: "X" }], now));
    const asked: string[] = [];
    const idx = new DevIndex(store, { rugged: async (r) => (asked.push(r.mint), r.mint === "M1" || r.mint === "M2") }, { maxChecks: 3, now: () => now });
    expect(await idx.launchesBy("D")).toEqual({ launches: 5, rugs: 2, since: now - RUG_WINDOW_MS - 4000 });
    expect(asked).toHaveLength(3); // budget per lookup
    await idx.launchesBy("D");
    expect(asked).toHaveLength(4); // only the remaining old one; M5 is younger than 60 min
    expect(await idx.launchesBy("nobody")).toBeNull();
  });
  it("rug checker: young -> no claim; no dev token account activity -> not a rug; too many tx -> no claim", async () => {
    const r = { mint: Keypair.generate().publicKey.toBase58(), creator: Keypair.generate().publicKey.toBase58(), createdAt: T - 2 * RUG_WINDOW_MS };
    const read = (n: number) => ({
      getSignaturesForAddress: async () => Array.from({ length: n }, (_, i) => ({ signature: `x${i}`, slot: 1, err: null, blockTime: Math.floor((T - 2 * RUG_WINDOW_MS) / 1000) + 10, memo: null })),
      getTransaction: async () => null,
    });
    expect(await new RpcRugChecker(read(0) as never).rugged({ ...r, createdAt: T }, T)).toBeNull();
    expect(await new RpcRugChecker(read(0) as never).rugged(r, T)).toBe(false);
    expect(await new RpcRugChecker(read(20) as never, 15).rugged(r, T)).toBeNull();
  });
  it("discovery hands every drained create (LaunchLab too) to the dev index; LaunchLab never becomes a candidate", async () => {
    const seen: CreateSeen[][] = [];
    const ll = launchLabCreatesFromNotification({ method: "parsedTransactionNotification", params: { result: FX.llCreate[0] } });
    const src: CreateSource = { name: "ll", drain: async () => ll };
    const store = new MemoryDiscoveryStore();
    const d = new Discovery({ store, chain: {} as never, sources: [src], rng: seededRng(1), onCreates: (c) => void seen.push([...c]) });
    const r = await d.tick();
    expect(seen[0]).toHaveLength(1);
    expect(r.admitted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// market_trades in the tick transaction (live Postgres, temp schema copy of core's table)
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { PgIntelStore } from "../src/intel/pg-store";
import { loadRepoEnv } from "../src/env";

loadRepoEnv();
const DB = process.env.DATABASE_URL;
describe.skipIf(!DB)("market_trades rows (live Postgres, temp schema)", () => {
  const schema = `intel_mt_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DB, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const t of ["token_safety", "intel_tokens", "intel_warm", "intel_requests", "intel_subscriptions", "intel_meta", "tokens", "market_trades"]) {
      await admin.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    }
    await admin.query(`CREATE SEQUENCE ${schema}.mt_seq`);
    await admin.query(`ALTER TABLE ${schema}.market_trades ALTER COLUMN id SET DEFAULT nextval('${schema}.mt_seq')`);
    pool = new pg.Pool({ connectionString: DB, max: 2, options: `-c search_path=${schema}` });
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });
  it("inserted with tags (empty -> '{}'), replays ignored, CHECKs satisfied (unzeen without dev)", async () => {
    const store = new PgIntelStore(pool, "mainnet-beta");
    const row = (sig: string, tags: ("whale" | "dev" | "sniper")[], unzeen = false) => ({
      mint: "M", kind: "buy" as const, venue: "raydium-launchlab" as const, symbol: "S", decimals: 6, trader: "T", unzeen, tags, tokenAmount: 5n, solAmount: 2_000_000_000n, signature: sig, ix: 4, slot: 9, ts: T,
    });
    const commit = (marketTrades: ReturnType<typeof row>[]) => ({ asOf: T - (T % 60_000), tickStartedAt: T, nextTickAt: T + 60_000, rows: [], cards: [], missing: [], batch: [], consumed: [], curveUpdates: [], subscriptions: [], marketTrades });
    await store.commitTick(commit([row("a", ["whale", "sniper"]), row("b", []), row("c", ["whale"], true)]));
    await store.commitTick(commit([row("a", ["whale"])])); // replay
    const r = await pool.query(`SELECT signature, tags, unzeen, venue, sol_amount::text AS sol FROM market_trades ORDER BY signature`);
    expect(r.rows).toEqual([
      { signature: "a", tags: ["whale", "sniper"], unzeen: false, venue: "raydium-launchlab", sol: "2000000000" },
      { signature: "b", tags: [], unzeen: false, venue: "raydium-launchlab", sol: "2000000000" },
      { signature: "c", tags: ["whale"], unzeen: true, venue: "raydium-launchlab", sol: "2000000000" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// intel_creates with core's exact grants (0024 + infra/indexer-role.sql: UPDATE on rug columns only)
// ---------------------------------------------------------------------------

import { PgCreateIndex } from "../src/intel/dev-index";

describe.skipIf(!DB)("intel_creates under the indexer role's column grants (live Postgres)", () => {
  const schema = `intel_ci_${randomBytes(4).toString("hex")}`;
  const role = `idx_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DB, max: 1 });
    const ddl = fs.readFileSync(path.resolve(__dirname, "../../core/migrations/0024_intel_creates.sql"), "utf8");
    const table = ddl.slice(ddl.indexOf("CREATE TABLE intel_creates"), ddl.indexOf(");", ddl.indexOf("CREATE TABLE intel_creates")) + 2);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path = ${schema}; ${table}`);
    await admin.query(`CREATE ROLE ${role} NOLOGIN`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    // exactly infra/indexer-role.sql
    await admin.query(`GRANT SELECT, INSERT, UPDATE (rug, rug_checked_at) ON ${schema}.intel_creates TO ${role}`);
    pool = new pg.Pool({ connectionString: DB, max: 1, options: `-c search_path=${schema} -c role=${role}` });
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.query(`DROP ROLE IF EXISTS ${role}`);
    await admin?.end();
  });
  it("available() is true with column-level UPDATE; record / rug / count work under that role", async () => {
    const idx = new PgCreateIndex(pool, "mainnet-beta");
    expect(await idx.available()).toBe(true);
    await idx.record([{ mint: "M1", venue: "raydium-launchlab", creator: "D", slot: 5, createdAt: T - RUG_WINDOW_MS * 2, signature: "s1" }]);
    await idx.record([{ mint: "M1", venue: "raydium-launchlab", creator: "D", slot: 5, createdAt: T, signature: "s1" }]); // replay ignored
    await idx.setRug("M1", true);
    expect(await idx.count("D")).toEqual({ launches: 1, rugs: 1, since: T - RUG_WINDOW_MS * 2 });
    expect((await idx.byCreator("D", 5))[0]).toMatchObject({ mint: "M1", rug: true, venue: "raydium-launchlab" });
  });
  it("without the rug column grant: not available (kept in memory)", async () => {
    await admin.query(`REVOKE UPDATE (rug) ON ${schema}.intel_creates FROM ${role}`);
    expect(await new PgCreateIndex(pool, "mainnet-beta").available()).toBe(false);
  });
});
