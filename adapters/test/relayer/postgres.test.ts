import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRepoEnv } from "../../src/env";
import { Relayer } from "../../src/relayer/engine";
import { PostgresJobQueue, rowToSpec, sanitizeMessage, type JobRow } from "../../src/relayer/postgres-queue";
import { seededRng } from "../../src/relayer/random";
import { LeaseLostError } from "../../src/relayer/types";
import { VaultPool } from "../../src/relayer/vaults";
import { FakeChain, FakeClock, FakeExecutor, FakeInventory, MINT, vaults } from "./fakes";
import { MINT_VAULTS_TEST_SQL, PgMintVaults } from "../../src/relayer/mint-vaults";
import {
  JobsVaultUsage,
  PROPOSED_RELAYER_STATE_SQL,
  PgAdvisoryVaultLock,
  PgCreatorIndexCounter,
  PgVaultUsage,
  vaultLockKey,
} from "../../src/relayer/postgres-vaults";

const ROW: JobRow = {
  id: "1",
  part: 0,
  op: "buy",
  venue: "pumpfun",
  mint: MINT,
  lamports_in: "1000",
  token_amount: null,
  min_out: "5",
  dest: null,
  gas_lamports: null,
  network: "devnet",
  attempts: 1,
  status: "claimed",
  signature: null,
  last_valid_block_height: null,
  vault: null,
  sent_at_ms: null,
  not_before_ms: "0",
};

describe("rowToSpec", () => {
  it("maps buy / sell / transfer rows", () => {
    expect(rowToSpec(ROW, "devnet")).toEqual({ kind: "buy", venue: "pumpfun", mint: MINT, lamportsIn: 1000n, minOut: 5n });
    expect(rowToSpec({ ...ROW, op: "sell", token_amount: "77" }, "devnet")).toEqual({
      kind: "sell",
      venue: "pumpfun",
      mint: MINT,
      amount: 77n,
      minLamports: 5n,
    });
    const dest = Keypair.generate().publicKey.toBase58();
    expect(
      rowToSpec({ ...ROW, op: "transfer", venue: null, token_amount: "9", dest, gas_lamports: "2000000" }, "devnet"),
    ).toEqual({ kind: "withdraw", mint: MINT, to: dest, amount: 9n, gasLamports: 2_000_000n });
    expect(
      rowToSpec({ ...ROW, op: "create", mint: null, meta: { name: "Unzeen", symbol: "UNZ", image: "data:image/png;base64,AA==" }, lamports_in: "5", min_out: "7" }, "devnet"),
    ).toEqual({ kind: "create", venue: "pumpfun", meta: { name: "Unzeen", symbol: "UNZ", image: "data:image/png;base64,AA==" }, lamportsIn: 5n, minOut: 7n });
  });
  it("rejects other networks, unsupported ops and missing fields", () => {
    expect(() => rowToSpec(ROW, "mainnet-beta")).toThrow(/devnet/);
    expect(() => rowToSpec({ ...ROW, op: "claim" }, "devnet")).toThrow(/not supported/);
    expect(() => rowToSpec({ ...ROW, op: "create", meta: { symbol: "X" } }, "devnet")).toThrow(/meta/);
    expect(() => rowToSpec({ ...ROW, lamports_in: null }, "devnet")).toThrow(/lamports_in/);
  });
  it("error messages lose addresses", () => {
    expect(sanitizeMessage(`vault ${MINT} empty`)).toBe("vault <addr> empty");
  });
});

loadRepoEnv();
const DB = process.env.DATABASE_URL;
if (process.env.REQUIRE_PG === "1" && !DB) throw new Error("REQUIRE_PG=1 but DATABASE_URL is not set");

// Runs against a throw-away schema with copies of the 0002 tables, so the real
// queue (and core's settler) are never touched.
describe.skipIf(!DB)("PostgresJobQueue (live Postgres, temp schema)", () => {
  const schema = `relayer_it_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let q: PostgresJobQueue;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DB, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const t of ["relayer_jobs", "tokens", "trades"]) {
      await admin.query(
        `CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`,
      );
    }
    for (const t of ["relayer_jobs", "trades"]) {
      await admin.query(`CREATE SEQUENCE ${schema}.${t}_seq`);
      await admin.query(`ALTER TABLE ${schema}.${t} ALTER COLUMN id SET DEFAULT nextval('${schema}.${t}_seq')`);
    }
    pool = new pg.Pool({ connectionString: DB, max: 4, options: `-c search_path=${schema}` });
    q = new PostgresJobQueue({ pool, network: "devnet" });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const insert = async (cols: Record<string, unknown>): Promise<string> => {
    const keys = Object.keys(cols);
    const res = await pool.query<{ id: string }>(
      `INSERT INTO relayer_jobs (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      Object.values(cols),
    );
    return res.rows[0]!.id;
  };
  const row = async (id: string) =>
    (await pool.query(`SELECT status, signature, vault, out_token_amount, out_lamports, error_code, attempts FROM relayer_jobs WHERE id = $1`, [id])).rows[0];
  const claim = (leaseMs = 60_000) => q.claim({ workerId: "w", now: Date.now(), leaseMs });
  const buyJob = { op: "buy", venue: "pumpfun", mint: MINT, lamports_in: 1000, min_out: 1, network: "devnet" };

  it("claims due jobs of its network/ops only, signature before send, confirmed + feed in one tx", async () => {
    await insert({ ...buyJob, network: "mainnet-beta" });
    await insert({ op: "create", venue: "pumpfun", lamports_in: 0, min_out: 0, network: "mainnet-beta", meta: { name: "a", symbol: "b" } });
    await insert({ ...buyJob, not_before: new Date(Date.now() + 3_600_000) });
    await pool.query(`INSERT INTO tokens (mint, venue, symbol, name, decimals) VALUES ($1, 'pumpfun', 'UNZT', 'Unzeen', 6)`, [MINT]);
    const id = await insert(buyJob);

    const c = (await claim())!;
    expect(c.id).toBe(id);
    expect(c.spec).toMatchObject({ kind: "buy", lamportsIn: 1000n });
    expect(await claim()).toBeNull(); // leased; others are not eligible
    expect((await row(id)).status).toBe("claimed");

    await expect(q.reportSent({ id, leaseId: "w:stale" }, { signature: "s", lastValidBlockHeight: 1, vault: "v", sentAt: 0 })).rejects.toBeInstanceOf(LeaseLostError);
    await q.reportSent(c, { signature: "sigA", lastValidBlockHeight: 99, vault: "vaultA", sentAt: Date.now() });
    expect(await row(id)).toMatchObject({ status: "sent", signature: "sigA", vault: "vaultA" });

    await q.reportResult(c, {
      status: "executed",
      execution: {
        kind: "buy", signature: "sigA", slot: 7, vault: "vaultA", mint: MINT, tokenAmount: 123n, solAmount: 990n,
        networkFee: 5000n, decimals: 6, fromEvent: true, blockTime: 1_760_000_000, symbol: null,
        market: { priceSol: "0.000000001", marketCapSol: "28.5", status: "curve" },
      },
    });
    expect(await row(id)).toMatchObject({ status: "confirmed", out_token_amount: "123", out_lamports: "990" });
    const t = (await pool.query(`SELECT kind, symbol, token_amount, sol_amount, signature FROM trades`)).rows;
    expect(t).toEqual([{ kind: "buy", symbol: "UNZT", token_amount: "123", sol_amount: "990", signature: "sigA" }]);
    const tok = (await pool.query(`SELECT market_cap_sol::text AS m FROM tokens WHERE mint = $1`, [MINT])).rows[0];
    expect(tok.m).toBe("28.5");
  });

  it("recovers a sent job after the lease runs out, with its signature (no blind resend)", async () => {
    await pool.query(`DELETE FROM relayer_jobs`);
    const id = await insert(buyJob);
    const c1 = (await claim(1))!;
    await q.reportSent(c1, { signature: "sigR", lastValidBlockHeight: 500, vault: "vaultR", sentAt: Date.now() });
    await pool.query(`UPDATE relayer_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    const c2 = (await claim())!;
    expect(c2.id).toBe(id);
    expect(c2.claims).toBe(2);
    expect(c2.attempts).toEqual([expect.objectContaining({ signature: "sigR", lastValidBlockHeight: 500, vault: "vaultR" })]);
    await expect(q.reportResult(c1, { status: "failed", code: "internal", message: "x" })).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("retry keeps the row in flight until notBefore; failed stores the code", async () => {
    await pool.query(`DELETE FROM relayer_jobs`);
    const id = await insert(buyJob);
    const c = (await claim())!;
    await q.reportResult(c, { status: "retry", code: "pool_liquidity", message: "m", notBefore: Date.now() + 3_600_000 });
    expect(await claim()).toBeNull();
    await pool.query(`UPDATE relayer_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    const c2 = (await claim())!;
    await q.reportResult(c2, { status: "failed", code: "slippage", message: `quote < min for ${MINT}` });
    expect(await row(id)).toMatchObject({ status: "failed", error_code: "slippage", attempts: 2 });
  });

  it("drives the engine end to end (transport error after send -> exactly one tx)", async () => {
    await pool.query(`DELETE FROM relayer_jobs`);
    await pool.query(`DELETE FROM trades`);
    const id = await insert(buyJob);
    const chain = new FakeChain();
    const clock = new FakeClock(Date.now(), chain);
    const inv = new FakeInventory();
    const ex = new FakeExecutor(chain);
    ex.behaviors = ["land-then-transport-error"];
    ex.sentRecorded = () => true;
    const relayer = new Relayer({
      queue: q,
      pool: new VaultPool(vaults(2, inv), inv, seededRng(1)),
      executors: { trade: { pumpfun: ex }, withdraw: ex },
      probe: chain,
      clock,
      rng: seededRng(1),
    });
    expect(await relayer.tick()).toBe(true);
    expect(ex.submitted).toEqual(["sig1"]);
    expect(await row(id)).toMatchObject({ status: "confirmed", signature: "sig1", out_token_amount: "123" });
    expect((await pool.query(`SELECT count(*)::int AS n FROM trades`)).rows[0].n).toBe(1);
  });

  it("D7: an in-flight row that cannot be parsed is never failed without proof it expired", async () => {
    await pool.query(`DELETE FROM relayer_jobs`);
    // A 'sent' transfer (signature recorded) whose lease ran out, now unparsable (dest lost).
    const id = await insert({
      op: "transfer", mint: MINT, token_amount: 10, dest: null, network: "devnet", status: "sent",
      signature: "sigD7", last_valid_block_height: 900, vault: "v", claimed_by: "old", lease_until: new Date(Date.now() - 1_000),
    });
    expect(await claim()).toBeNull();
    expect(await row(id)).toMatchObject({ status: "sent", error_code: null }); // lease extended, not failed

    // With a probe: landed / pending -> still not failed; expired -> failed is safe.
    const states: string[] = ["pending", "expired"];
    const probed = new PostgresJobQueue({ pool, network: "devnet", probe: { state: async () => ({ state: states.shift()! }) } });
    const reclaim = () => probed.claim({ workerId: "w2", now: Date.now(), leaseMs: 60_000 });
    await pool.query(`UPDATE relayer_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await reclaim()).toBeNull();
    expect((await row(id)).status).toBe("sent");
    await pool.query(`UPDATE relayer_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await reclaim()).toBeNull();
    expect(await row(id)).toMatchObject({ status: "failed", error_code: "bad_request" });
  });

  it("D7: a lost result report leaves the job in flight (engine run loop survives, no 'failed')", async () => {
    await pool.query(`DELETE FROM relayer_jobs`);
    const id = await insert({ ...buyJob, dest: null });
    const chain = new FakeChain();
    const clock = new FakeClock(Date.now(), chain);
    const inv = new FakeInventory();
    const ex = new FakeExecutor(chain);
    let broken = true;
    const flaky = Object.create(q) as PostgresJobQueue;
    flaky.reportResult = async (j, r) => {
      if (broken && r.status === "executed") throw new Error("connection terminated");
      return q.reportResult(j, r);
    };
    const relayer = new Relayer({ queue: flaky, pool: new VaultPool(vaults(1, inv), inv, seededRng(2)), executors: { trade: { pumpfun: ex }, withdraw: ex }, probe: chain, clock, rng: seededRng(2), leaseMs: 1 });
    const ac = new AbortController();
    const errors: unknown[] = [];
    clock.sleep = async () => { ac.abort(); };
    await relayer.run(ac.signal, 10, (e) => errors.push(e));
    expect(errors).toHaveLength(1);
    expect(await row(id)).toMatchObject({ status: "sent", signature: "sig1" });
    // Next claim (lease ran out) resolves the recorded signature on chain: no second tx.
    broken = false;
    await new Promise((r) => setTimeout(r, 5));
    expect(await relayer.tick()).toBe(true);
    expect(ex.submitted).toEqual(["sig1"]);
    expect(await row(id)).toMatchObject({ status: "confirmed", signature: "sig1" });
  });

  it("create: out_mint + first buy, tokens row and 'create' + 'buy' feed events in one transaction", async () => {
    await pool.query(`DELETE FROM relayer_jobs`);
    await pool.query(`DELETE FROM trades`);
    const id = await insert({ op: "create", venue: "pumpfun", lamports_in: 50_000, min_out: 1, network: "devnet", meta: { name: "Unzeen", symbol: "UNZ" } });
    const c = (await claim())!;
    expect(c.spec).toMatchObject({ kind: "create", meta: { name: "Unzeen", symbol: "UNZ" }, lamportsIn: 50_000n });
    await q.reportSent(c, { signature: "sigC", lastValidBlockHeight: 1, vault: "vC", sentAt: Date.now() });
    const newMint = Keypair.generate().publicKey.toBase58();
    await q.reportResult(c, {
      status: "executed",
      execution: {
        kind: "create", signature: "sigC", slot: 9, vault: "vC", mint: newMint, creator: "cr", tokenAmount: 777n, solAmount: 50_000n,
        networkFee: 5_000n, decimals: 6, blockTime: 1_760_000_000, name: "Unzeen", symbol: "UNZ", imageUrl: "https://m.example/a.jpg",
        market: { priceSol: "0.00000003", marketCapSol: "30.1", status: "curve" },
      },
    });
    const r = (await pool.query(`SELECT status, out_mint, out_token_amount, out_lamports FROM relayer_jobs WHERE id = $1`, [id])).rows[0];
    expect(r).toEqual({ status: "confirmed", out_mint: newMint, out_token_amount: "777", out_lamports: "50000" });
    const tok = (await pool.query(`SELECT symbol, name, image, decimals, market_cap_sol::text AS m FROM tokens WHERE mint = $1`, [newMint])).rows[0];
    expect(tok).toEqual({ symbol: "UNZ", name: "Unzeen", image: "https://m.example/a.jpg", decimals: 6, m: "30.1" });
    const t = (await pool.query(`SELECT kind, token_amount, sol_amount, signature FROM trades WHERE mint = $1 ORDER BY id`, [newMint])).rows;
    expect(t).toEqual([
      { kind: "create", token_amount: "0", sol_amount: "0", signature: "sigC" },
      { kind: "buy", token_amount: "777", sol_amount: "50000", signature: "sigC" },
    ]);
  });

  it("advisory vault lock: exclusive across connections, released on release() and on disconnect", async () => {
    const lockPool = new pg.Pool({ connectionString: DB, max: 4 });
    const otherPool = new pg.Pool({ connectionString: DB, max: 4 });
    otherPool.on("error", () => undefined);
    const held: { release(): Promise<void> }[] = [];
    try {
      const a = new PgAdvisoryVaultLock(lockPool, "devnet");
      const b = new PgAdvisoryVaultLock(otherPool, "devnet");
      const vault = `vault-${schema}`;
      const l1 = (await a.tryAcquire(vault))!;
      expect(l1).not.toBeNull();
      expect(await b.tryAcquire(vault)).toBeNull();
      held.push((await b.tryAcquire(`${vault}-other`))!); // other vaults independent
      held.push((await new PgAdvisoryVaultLock(otherPool, "mainnet-beta").tryAcquire(vault))!); // per network
      expect(held.every(Boolean)).toBe(true);
      await l1.release();
      const l2 = (await b.tryAcquire(vault))!;
      expect(l2).not.toBeNull();
      // Crash of the holder: its session ends (backend killed), the lock is gone.
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_locks
          WHERE locktype = 'advisory' AND classid = $1::oid AND objid = $2::oid AND granted`,
        [0x554e5a56, vaultLockKey("devnet", vault) >>> 0],
      );
      await new Promise((r) => setTimeout(r, 200));
      const l3 = await a.tryAcquire(vault);
      expect(l3).not.toBeNull();
      held.push(l3!, l2); // l2's connection is dead: release destroys it, no throw
    } finally {
      for (const h of held) await h.release();
      await lockPool.end();
      await otherPool.end();
    }
  });

  it("vault usage derived from relayer_jobs (no extra table) + local touches", async () => {
    await pool.query(`DELETE FROM relayer_jobs`);
    await insert({ ...buyJob, vault: "vu1", claimed_at: new Date(1_700_000_000_000), status: "confirmed", signature: "s1" });
    await insert({ ...buyJob, vault: "vu1", claimed_at: new Date(1_700_000_100_000), status: "confirmed", signature: "s2" });
    const u = new JobsVaultUsage(pool, "devnet");
    await u.touch("vu2", 5);
    expect(await u.lastUsed(["vu1", "vu2", "vu3"])).toEqual(new Map([["vu1", 1_700_000_100_000], ["vu2", 5]]));
  });

  it("proposed tables (temp schema): mint pins, vault usage, creator counter are atomic", async () => {
    await pool.query(PROPOSED_RELAYER_STATE_SQL + MINT_VAULTS_TEST_SQL);
    const pins = new PgMintVaults(pool, "devnet");
    const winners = await Promise.all(["va", "vb", "vc", "vd"].map((v) => pins.assign("M1", v)));
    expect(new Set(winners).size).toBe(1);
    expect(await pins.get("M1")).toBe(winners[0]);
    expect(await new PgMintVaults(pool, "mainnet-beta").get("M1")).toBeNull();
    await pins.assign("M2", "vb");
    await pins.reassign("M1", "vb");
    expect(await pins.load()).toEqual(new Map([["vb", 2]]));

    const usage = new PgVaultUsage(pool, "devnet");
    await usage.touch("vx", 2_000);
    await usage.touch("vx", 1_000); // never goes back
    expect(await usage.lastUsed(["vx", "vy"])).toEqual(new Map([["vx", 2_000]]));

    const counter = new PgCreatorIndexCounter(pool, "devnet", 5); // file counter was at 5
    const got = await Promise.all(Array.from({ length: 10 }, () => counter.next()));
    expect([...got].sort((x, y) => x - y)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(await new PgCreatorIndexCounter(pool, "devnet", 0).next()).toBe(15);
    expect(await new PgCreatorIndexCounter(pool, "mainnet-beta").next()).toBe(0);
  });

  it("R-relayer-1: now lane takes exec_mode='now' at once, past the epoch; lanes are disjoint", async () => {
    await pool.query(`DELETE FROM relayer_jobs`);
    const epoch = new Date(Date.now() + 45_000);
    const d = await insert({ ...buyJob, exec_mode: "delayed", not_before: epoch });
    const m = await insert({ ...buyJob, exec_mode: "max", not_before: epoch });
    const n = await insert({ ...buyJob, exec_mode: "now" });
    const lane = (l: "now" | "batch") => q.claim({ workerId: "w", now: Date.now(), leaseMs: 60_000, lane: l });
    expect(await lane("batch")).toBeNull(); // epoch not reached
    expect((await lane("now"))!.id).toBe(n);
    expect(await lane("now")).toBeNull();
    await pool.query(`UPDATE relayer_jobs SET not_before = now() - interval '1 second' WHERE id IN ($1, $2)`, [d, m]);
    expect(await lane("now")).toBeNull(); // due delayed/max never enter the now lane
    const got = [(await lane("batch"))!.id, (await lane("batch"))!.id].sort();
    expect(got).toEqual([d, m].sort());
    // Without a lane (legacy single loop) everything is claimable.
    await pool.query(`DELETE FROM relayer_jobs`);
    await insert({ ...buyJob, exec_mode: "now" });
    expect(await claim()).not.toBeNull();
  });

  it("N-4: jobs of one epoch are claimed in random order (statistical)", async () => {
    const K = 5;
    const TRIALS = 150;
    const firstPos = new Array(K).fill(0);
    const posOfFirstInserted = new Array(K).fill(0);
    let fifo = 0;
    for (let trial = 0; trial < TRIALS; trial++) {
      await pool.query(`DELETE FROM relayer_jobs`);
      const epoch = new Date(Date.now() - 1_000);
      const ids: string[] = [];
      for (let i = 0; i < K; i++) ids.push(await insert({ ...buyJob, exec_mode: i % 2 ? "max" : "delayed", not_before: epoch }));
      const order: number[] = [];
      for (;;) {
        const c = await q.claim({ workerId: "w", now: Date.now(), leaseMs: 60_000, lane: "batch" });
        if (!c) break;
        order.push(ids.indexOf(c.id));
      }
      expect([...order].sort()).toEqual([0, 1, 2, 3, 4]);
      firstPos[order[0]!]++;
      posOfFirstInserted[order.indexOf(0)]++;
      if (order.every((v, i) => v === i)) fifo++;
    }
    const chi = (c: number[]) => c.reduce((s, x) => s + (x - TRIALS / K) ** 2 / (TRIALS / K), 0);
    // df = 4: p = 1e-4 at 23.5. The old ORDER BY not_before gave FIFO (chi = 600).
    expect(chi(firstPos)).toBeLessThan(23.5);
    expect(chi(posOfFirstInserted)).toBeLessThan(23.5);
    expect(fifo / TRIALS).toBeLessThan(0.05); // 1/120 expected
  });
});
