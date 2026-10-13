import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction } from "@solana/web3.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTEST_PATH, FAIR_ATTEST_PATH, deriveAttestKeypair } from "../../src/attest";
import { loadRepoEnv } from "../../src/env";
import { AdapterError } from "../../src/errors";
import { deriveCreatorKeypair } from "../../src/keys";
import { MIN_FUND_LAMPORTS, PoolSolInventoryWriter, REBALANCE_PATH, RENT_EXEMPT_MIN, VaultFunder, deriveRebalanceKeypair, planFunding } from "../../src/rebalance";
import { Relayer } from "../../src/relayer/engine";
import { ConsolidateExecutor } from "../../src/relayer/executors";
import { InMemoryJobQueue } from "../../src/relayer/memory-queue";
import { MemoryMintVaults } from "../../src/relayer/mint-vaults";
import { PostgresJobQueue, rowToSpec, type JobRow } from "../../src/relayer/postgres-queue";
import { seededRng } from "../../src/relayer/random";
import type { JobSpec } from "../../src/relayer/types";
import { VaultPool } from "../../src/relayer/vaults";
import { FakeChain, FakeClock, FakeExecutor, FakeInventory, vaults } from "./fakes";

const SEED = new Uint8Array(64).fill(7);
const V = (i: number) => Keypair.fromSeed(new Uint8Array(32).fill(i + 1)).publicKey.toBase58();

describe("rebalance key", () => {
  it("own hardened branch /4': not an attestation key, creator or another seed's key", () => {
    expect(REBALANCE_PATH).toEqual([44, 501, 0x7ffffffd, 4]);
    expect(REBALANCE_PATH[3]).not.toBe(ATTEST_PATH[3]);
    expect(REBALANCE_PATH[3]).not.toBe(FAIR_ATTEST_PATH[3]);
    const k = deriveRebalanceKeypair(SEED).publicKey;
    expect(k.equals(deriveRebalanceKeypair(SEED).publicKey)).toBe(true);
    expect(k.equals(deriveAttestKeypair(SEED, "verify").publicKey)).toBe(false);
    expect(k.equals(deriveAttestKeypair(SEED, "fair").publicKey)).toBe(false);
    for (let i = 0; i < 50; i++) expect(k.equals(deriveCreatorKeypair(SEED, i).publicKey)).toBe(false);
    expect(k.equals(deriveRebalanceKeypair(new Uint8Array(64).fill(8)).publicKey)).toBe(false);
  });
});

describe("planFunding (water-fill)", () => {
  const bal = (xs: bigint[]) => xs.map((l, i) => ({ vault: V(i), lamports: l }));
  it("raises the poorest to a common level, exact total", () => {
    const t = planFunding(30n, bal([10n, 0n, 100n]));
    expect(t).toEqual([{ vault: V(1), lamports: 20n }, { vault: V(0), lamports: 10n }]);
  });
  it("everyone level: the rest spreads evenly; rounding lamports go to the poorest", () => {
    const t = planFunding(301n, bal([100n, 100n, 100n]));
    expect(t.reduce((s, x) => s + x.lamports, 0n)).toBe(301n);
    expect(t.map((x) => x.lamports).sort()).toEqual([100n, 100n, 101n]);
  });
  it("never more than maxRecipients (the poorest)", () => {
    const t = planFunding(1_000n, bal(Array.from({ length: 30 }, (_, i) => BigInt(i))), 20);
    expect(t.length).toBeLessThanOrEqual(20);
    expect(t.reduce((s, x) => s + x.lamports, 0n)).toBe(1_000n);
    expect(t.some((x) => x.vault === V(29))).toBe(false);
  });
  it("0 -> nothing; no vaults -> error", () => {
    expect(planFunding(0n, bal([1n]))).toEqual([]);
    expect(() => planFunding(5n, [])).toThrow();
  });
});

describe("VaultFunder.prepare", () => {
  const key = deriveRebalanceKeypair(SEED);
  const vs = [0, 1, 2].map((i) => new PublicKey(V(i)));
  const conn = (bal: number, vaultLamports: number[]) => ({
    getBalance: async () => bal,
    getMultipleAccountsInfo: async () => vaultLamports.map((l) => ({ lamports: l, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false })),
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 10 }),
  });
  it("one tx of System transfers from the rebalance address, capped by what it holds", async () => {
    const f = new VaultFunder({ connection: conn(2_000_000_000, [5_000_000_000, 0, 1_000_000_000]) as never, key, vaults: vs });
    const p = await f.prepare(10n ** 12n);
    expect(p.lamports).toBe(2_000_000_000n - RENT_EXEMPT_MIN - 100_000n);
    expect(p.transfers.map((t) => t.vault)).toEqual([V(1), V(2)]);
    const tx = Transaction.from(p.raw);
    expect(tx.feePayer!.equals(key.publicKey)).toBe(true);
    const transfers = tx.instructions.filter((i) => i.programId.equals(SystemProgram.programId)).map((i) => SystemInstruction.decodeTransfer(i));
    expect(transfers.every((t) => t.fromPubkey.equals(key.publicKey))).toBe(true);
    expect(transfers.reduce((s, t) => s + t.lamports, 0n)).toBe(p.lamports);
  });
  it("too little SOL on the address -> insufficient_sol (API pool_liquidity), nothing signed", async () => {
    const f = new VaultFunder({ connection: conn(Number(MIN_FUND_LAMPORTS), [0, 0, 0]) as never, key, vaults: vs });
    await expect(f.prepare(5n * 10n ** 9n)).rejects.toMatchObject({ code: "insufficient_sol", apiCode: "pool_liquidity" });
  });
  it("refuses a rebalance key that is a vault", () => {
    expect(() => new VaultFunder({ connection: conn(1, []) as never, key, vaults: [key.publicKey] })).toThrow();
  });
});

describe("pool_sol_inventory snapshot", () => {
  it("Σ vaults + rebalance address, one read, its slot", async () => {
    const vs = [0, 1].map((i) => new PublicKey(V(i)));
    const reb = deriveRebalanceKeypair(SEED).publicKey;
    let keys: PublicKey[] = [];
    const read = {
      getMultipleAccountsInfoAndContext: async (k: PublicKey[]) => {
        keys = k;
        return { context: { slot: 77 }, value: [{ lamports: 5 }, null, { lamports: 9 }] };
      },
    };
    const w = new PoolSolInventoryWriter({} as never, "devnet", read as never, vs, reb);
    expect(await w.snapshot()).toEqual({ vaultLamports: 5n, vaultCount: 2, rebalanceLamports: 9n, slot: 77 });
    expect(keys.at(-1)!.equals(reb)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

function engine() {
  const chain = new FakeChain();
  const clock = new FakeClock(1_700_000_000_000, chain);
  const rng = seededRng(9);
  const inv = new FakeInventory();
  const vs = vaults(3, inv);
  const pool = new VaultPool(vs, inv, rng);
  const queue = new InMemoryJobQueue(rng);
  const trade = new FakeExecutor(chain);
  const reb = deriveRebalanceKeypair(SEED);
  class FundFake extends FakeExecutor {
    ownSigner() {
      return reb;
    }
  }
  const fund = new FundFake(chain);
  const consolidate = new FakeExecutor(chain);
  const mintVaults = new MemoryMintVaults();
  const relayer = new Relayer({ queue, pool, executors: { trade: { pumpfun: trade }, withdraw: trade, fund, consolidate }, probe: chain, mintVaults, clock, rng });
  const add = (spec: JobSpec, ex: FakeExecutor) => {
    const j = queue.enqueue(spec, { notBefore: clock.now() });
    ex.sentRecorded = (sig) => queue.get(j.id)!.attempts.some((a) => a.signature === sig);
    return j.id;
  };
  return { relayer, queue, vs, inv, fund, consolidate, reb, mintVaults, add, chain };
}

describe("engine v7", () => {
  it("fund_vaults: signed by the rebalance address, no vault lease, lamports reported", async () => {
    const t = engine();
    const id = t.add({ kind: "fund_vaults", lamports: 3_000_000_000n }, t.fund);
    await t.relayer.tick();
    const j = t.queue.get(id)!;
    expect(j.result).toMatchObject({ status: "executed", execution: { kind: "fund_vaults", lamports: 3_000_000_000n, vault: t.reb.publicKey.toBase58() } });
    expect(t.vs.map((v) => v.publicKey.toBase58())).not.toContain(j.attempts[0]!.vault);
  });

  it("consolidate: signed by the LEG vault (meta.from), not by the mint's pinned vault", async () => {
    const t = engine();
    const [a, b] = t.vs.map((v) => v.publicKey.toBase58());
    const mint = Keypair.generate().publicKey.toBase58();
    await t.mintVaults.assign(mint, a!);
    const id = t.add({ kind: "consolidate", mint, from: b!, to: a! }, t.consolidate);
    await t.relayer.tick();
    const j = t.queue.get(id)!;
    expect(j.attempts[0]!.vault).toBe(b);
    expect(j.result).toMatchObject({ status: "executed", execution: { kind: "consolidate", tokenAmount: 777n } });
  });

  it("consolidate of an empty leg: executed with 0, nothing signed (noop)", async () => {
    const chain = new FakeChain();
    const inv = new FakeInventory();
    const vs = vaults(2, inv);
    const [a, b] = vs.map((v) => v.publicKey.toBase58());
    const mint = Keypair.generate().publicKey.toBase58();
    const withdrawer = { prepare: async () => { throw new Error("must not sign"); }, submit: async () => undefined, result: async () => null, classify: (e: unknown) => new AdapterError("internal", String(e)) };
    const ex = new ConsolidateExecutor(withdrawer as never, inv);
    const queue = new InMemoryJobQueue(seededRng(1));
    const r = new Relayer({ queue, pool: new VaultPool(vs, inv, seededRng(1)), executors: { trade: {}, withdraw: new FakeExecutor(chain), consolidate: ex }, probe: chain });
    const j = queue.enqueue({ kind: "consolidate", mint, from: b!, to: a! }, { notBefore: 0 });
    await r.tick();
    expect(queue.get(j.id)!.result).toMatchObject({ status: "executed", execution: { kind: "consolidate", signature: null, tokenAmount: 0n, vault: b } });
    expect(queue.get(j.id)!.attempts).toEqual([]);
  });

  it("no rebalance key configured: fund_vaults fails before anything is signed", async () => {
    const chain = new FakeChain();
    const inv = new FakeInventory();
    const queue = new InMemoryJobQueue(seededRng(1));
    const r = new Relayer({ queue, pool: new VaultPool(vaults(1, inv), inv, seededRng(1)), executors: { trade: {}, withdraw: new FakeExecutor(chain) }, probe: chain });
    const j = queue.enqueue({ kind: "fund_vaults", lamports: 1n }, { notBefore: 0 });
    await r.tick();
    expect(queue.get(j.id)!.result).toMatchObject({ status: "failed", code: "venue_unavailable" });
  });
});

describe("rowToSpec v7", () => {
  const row = (o: Partial<JobRow>): JobRow => ({
    id: "1", part: 0, op: "fund_vaults", venue: null, mint: null, lamports_in: null, token_amount: null, min_out: null, meta: null, dest: null,
    gas_lamports: null, network: "devnet", attempts: 1, status: "claimed", signature: null, last_valid_block_height: null, vault: null,
    sent_at_ms: null, not_before_ms: "0", ...o,
  });
  it("fund_vaults / consolidate", () => {
    expect(rowToSpec(row({ lamports_in: "5" }), "devnet")).toEqual({ kind: "fund_vaults", lamports: 5n });
    expect(() => rowToSpec(row({ lamports_in: "0" }), "devnet")).toThrow();
    const c = { op: "consolidate", mint: V(5), dest: V(0), meta: { from: V(1), try: 1 } };
    expect(rowToSpec(row(c), "devnet")).toEqual({ kind: "consolidate", mint: V(5), from: V(1), to: V(0) });
    expect(() => rowToSpec(row({ ...c, meta: { from: "x" } }), "devnet")).toThrow();
    expect(() => rowToSpec(row({ ...c, meta: { from: V(0) } }), "devnet")).toThrow();
    expect(() => rowToSpec(row({ ...c, dest: null }), "devnet")).toThrow();
  });
});

// ---------------------------------------------------------------------------

loadRepoEnv();
const DB = process.env.DATABASE_URL;
describe.skipIf(!DB)("v7 on Postgres (live, temp schema with core's 0015 / 0017 DDL)", () => {
  const schema = `relayer_v7_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DB, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const t of ["relayer_jobs", "tokens", "trades"]) {
      await admin.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    }
    for (const t of ["relayer_jobs", "trades"]) {
      await admin.query(`CREATE SEQUENCE ${schema}.${t}_seq`);
      await admin.query(`ALTER TABLE ${schema}.${t} ALTER COLUMN id SET DEFAULT nextval('${schema}.${t}_seq')`);
    }
    const sql = (f: string) => fs.readFileSync(path.resolve(__dirname, "../../../core/migrations", f), "utf8");
    const m15 = sql("0015_rebalance.sql");
    const m17 = sql("0017_fair_bundle.sql");
    const inv = m15.slice(m15.indexOf("CREATE TABLE pool_sol_inventory"), m15.indexOf(");", m15.indexOf("CREATE TABLE pool_sol_inventory")) + 2);
    const c = await admin.connect();
    try {
      await c.query(`SET search_path = ${schema}`);
      await c.query(inv);
      await c.query(`ALTER TABLE relayer_jobs DROP CONSTRAINT IF EXISTS relayer_jobs_op_check`);
      // 0017: bundle_legs + op list (only the relayer_jobs parts).
      for (const stmt of m17.replace(/--.*$/gm, "").split(";").map((x) => x.trim()).filter((x) => /^ALTER TABLE relayer_jobs/.test(x))) {
        if (/DROP CONSTRAINT relayer_jobs_op_check/.test(stmt)) continue;
        await c.query(idempotent(stmt));
      }
    } finally {
      c.release();
    }
    pool = new pg.Pool({ connectionString: DB, max: 4, options: `-c search_path=${schema}` });
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("pool_sol_inventory upsert", async () => {
    const read = { getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 5 }, value: [{ lamports: 3 }, { lamports: 4 }] }) };
    const w = new PoolSolInventoryWriter(pool, "devnet", read as never, [new PublicKey(V(0))], new PublicKey(V(1)));
    await w.writeOnce();
    await w.writeOnce();
    const r = (await pool.query(`SELECT vault_lamports, vault_count, rebalance_lamports, slot FROM pool_sol_inventory`)).rows;
    expect(r).toEqual([{ vault_lamports: "3", vault_count: 1, rebalance_lamports: "4", slot: "5" }]);
  });

  it("fund_vaults and consolidate are claimed, confirmed without feed rows; empty consolidate under 0002's CHECK -> failed not_found", async () => {
    const q = new PostgresJobQueue({ pool, network: "devnet" });
    await pool.query(`INSERT INTO relayer_jobs (op, lamports_in, meta, network, exec_mode) VALUES ('fund_vaults', 2000000000, '{"purpose":"rebalance"}', 'devnet', 'delayed')`);
    const f = (await q.claim({ workerId: "w", now: Date.now(), leaseMs: 60_000 }))!;
    expect(f.spec).toEqual({ kind: "fund_vaults", lamports: 2_000_000_000n });
    await q.reportSent(f, { signature: "F1", lastValidBlockHeight: 9, vault: "REB", sentAt: Date.now() });
    await q.reportResult(f, { status: "executed", execution: { kind: "fund_vaults", signature: "F1", slot: 3, vault: "REB", lamports: 1_999_000_000n, networkFee: 5_000n, blockTime: 1 } });
    expect((await pool.query(`SELECT status, out_lamports, vault FROM relayer_jobs WHERE id = $1`, [f.id])).rows[0]).toEqual({ status: "confirmed", out_lamports: "1999000000", vault: "REB" });

    const ins = (from: string) =>
      pool.query(`INSERT INTO relayer_jobs (op, mint, dest, meta, network, exec_mode) VALUES ('consolidate', $1, $2, $3, 'devnet', 'delayed')`, [V(5), V(0), { from, try: 1 }]);
    await ins(V(1));
    const c1 = (await q.claim({ workerId: "w", now: Date.now(), leaseMs: 60_000 }))!;
    await q.reportSent(c1, { signature: "C1", lastValidBlockHeight: 9, vault: V(1), sentAt: Date.now() });
    await q.reportResult(c1, { status: "executed", execution: { kind: "consolidate", signature: "C1", slot: 4, vault: V(1), mint: V(5), to: V(0), tokenAmount: 10n, networkFee: 5_000n } });
    expect((await pool.query(`SELECT status, out_token_amount FROM relayer_jobs WHERE id = $1`, [c1.id])).rows[0]).toEqual({ status: "confirmed", out_token_amount: "10" });

    await ins(V(2));
    const c2 = (await q.claim({ workerId: "w", now: Date.now(), leaseMs: 60_000 }))!;
    await q.reportResult(c2, { status: "executed", execution: { kind: "consolidate", signature: null, slot: null, vault: V(2), mint: V(5), to: V(0), tokenAmount: 0n, networkFee: 0n } });
    // 0002's CHECK forbids confirmed without a signature -> failed/not_found; core 0018+ allows it for consolidate.
    const relaxed = (await pool.query(`SELECT bool_or(pg_get_constraintdef(oid) LIKE '%consolidate%') AS ok FROM pg_constraint WHERE conrelid = 'relayer_jobs'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%signature IS NOT NULL%'`)).rows[0]?.ok === true;
    expect((await pool.query(`SELECT status, error_code FROM relayer_jobs WHERE id = $1`, [c2.id])).rows[0]).toEqual(relaxed ? { status: "confirmed", error_code: null } : { status: "failed", error_code: "not_found" });
    expect((await pool.query(`SELECT count(*)::int n FROM trades`)).rows[0].n).toBe(0);
  });

  it("confirmed fair_create: bundle_legs = exactly the legs that landed", async () => {
    const q = new PostgresJobQueue({ pool, network: "devnet" });
    const mint = Keypair.generate();
    await pool.query(
      `INSERT INTO relayer_jobs (op, venue, lamports_in, min_out, meta, network, mint_secret, exec_mode)
       VALUES ('fair_create', 'pumpfun', 9000000000, 5, '{"name":"F","symbol":"F"}', 'devnet', $1, 'now')`,
      [Buffer.from(mint.secretKey)],
    );
    const c = (await q.claim({ workerId: "w", now: Date.now(), leaseMs: 60_000 }))!;
    await q.reportSent(c, { signature: "L0", lastValidBlockHeight: 9, vault: "VA", sentAt: Date.now(), bundle: { legs: [{ signature: "L1", vault: "VB" }, { signature: "L2", vault: "VC" }] } });
    const leg = { kind: "buy" as const, signature: "L2", slot: 7, vault: "VC", mint: "MX", tokenAmount: 5n, solAmount: 5n, networkFee: 1n, decimals: 6, fromEvent: true, blockTime: 1, symbol: "F", market: null };
    await q.reportResult(c, {
      status: "executed",
      execution: { kind: "create", signature: "L0", slot: 7, vault: "VA", mint: "MX", creator: "C", tokenAmount: 15n, solAmount: 15n, networkFee: 2n, decimals: 6, blockTime: 1, name: "F", symbol: "F", imageUrl: null, market: null, legs: [leg] },
    });
    expect((await pool.query(`SELECT bundle_legs FROM relayer_jobs WHERE id = $1`, [c.id])).rows[0].bundle_legs).toEqual([{ sig: "L2", vault: "VC" }]);
  });
});


/** Core DDL fragments re-applied on a LIKE copy of a NEWER public schema: make them idempotent. */
function idempotent(sql: string): string {
  return sql
    .replace(/ADD COLUMN (?!IF NOT EXISTS)/g, "ADD COLUMN IF NOT EXISTS ")
    .replace(/ALTER TABLE (\w+) ADD CONSTRAINT (\w+)/g, "ALTER TABLE $1 DROP CONSTRAINT IF EXISTS $2; ALTER TABLE $1 ADD CONSTRAINT $2");
}
