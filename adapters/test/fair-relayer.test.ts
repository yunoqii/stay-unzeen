import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import BN from "bn.js";
import { Keypair, MessageV0, PublicKey, VersionedTransaction, type VersionedTransactionResponse } from "@solana/web3.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTEST_PATH, MEMO_PROGRAM_ID, deriveAttestKeypair, isCommitmentMemo, memoInstruction, memoOfTx } from "../src/attest";
import { deriveCreatorKeypair } from "../src/keys";
import { derivePartnerKeypair } from "../src/meteora";
import { Relayer } from "../src/relayer/engine";
import { LaunchCurveWriter, pumpLaunchCurve } from "../src/relayer/launch-curves";
import { InMemoryJobQueue } from "../src/relayer/memory-queue";
import { MemoryMintVaults } from "../src/relayer/mint-vaults";
import { PostgresJobQueue, rowToSpec, type JobRow } from "../src/relayer/postgres-queue";
import { seededRng } from "../src/relayer/random";
import type { JobSpec } from "../src/relayer/types";
import { VaultPool } from "../src/relayer/vaults";
import { loadParams } from "./helpers";
import { FakeChain, FakeClock, FakeExecutor, FakeInventory, vaults } from "./relayer/fakes";

const SEED = new Uint8Array(64).fill(9);
const ROOT = "a".repeat(64);

function row(over: Partial<JobRow>): JobRow {
  return {
    id: "1", part: 0, op: "buy", venue: "pumpfun", mint: null, lamports_in: null, token_amount: null, min_out: null,
    meta: null, dest: null, gas_lamports: null, network: "devnet", attempts: 1, status: "claimed", signature: null,
    last_valid_block_height: null, vault: null, sent_at_ms: null, not_before_ms: "0", ...over,
  };
}

describe("rowToSpec v3", () => {
  const mint = Keypair.generate();
  const fair = (o: Partial<JobRow> = {}) =>
    row({ op: "fair_create", meta: { name: "Fair", symbol: "FAIR" }, lamports_in: "5000000000", min_out: "1000", mint_secret: Buffer.from(mint.secretKey), ...o });

  it("fair_create: the mint keypair comes from mint_secret", () => {
    const s = rowToSpec(fair(), "devnet");
    expect(s.kind).toBe("fair_create");
    if (s.kind !== "fair_create") throw new Error();
    expect(s.mintKeypair.publicKey.equals(mint.publicKey)).toBe(true);
    expect(s.lamportsIn).toBe(5_000_000_000n);
    expect(s.minOut).toBe(1000n);
  });

  it("fair_create: rejects missing / malformed secret and min_out 0, without echoing the secret", () => {
    const secretHex = Buffer.from(mint.secretKey).toString("hex");
    const bad = Buffer.from(mint.secretKey);
    bad[40] = bad[40]! ^ 1; // pubkey half does not match the seed
    for (const o of [{ mint_secret: null }, { mint_secret: Buffer.alloc(32) }, { mint_secret: bad }, { min_out: "0" }]) {
      let msg = "";
      try {
        rowToSpec(fair(o), "devnet");
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toBe("");
      expect(msg).not.toContain(secretHex.slice(0, 16));
    }
  });

  it("attest: only a bare 64-hex memo", () => {
    expect(rowToSpec(row({ op: "attest", venue: null, meta: { memo: ROOT } }), "devnet")).toEqual({ kind: "attest", memo: ROOT, purpose: "fair" });
    for (const memo of ["unzeen:" + ROOT, ROOT.toUpperCase(), ROOT + "0", "", 42]) {
      expect(() => rowToSpec(row({ op: "attest", venue: null, meta: { memo } }), "devnet")).toThrow();
    }
  });
});

describe("attestation key and memo", () => {
  it("own HD branch: never a creator, the partner or another network's key", () => {
    const k = deriveAttestKeypair(SEED);
    expect(k.publicKey.equals(deriveAttestKeypair(SEED).publicKey)).toBe(true);
    expect(k.publicKey.equals(derivePartnerKeypair(SEED).publicKey)).toBe(false);
    for (let i = 0; i < 50; i++) expect(k.publicKey.equals(deriveCreatorKeypair(SEED, i).publicKey)).toBe(false);
    expect(deriveAttestKeypair(new Uint8Array(64).fill(1)).publicKey.equals(k.publicKey)).toBe(false);
    expect(ATTEST_PATH[2]).toBeGreaterThan(0x7ffffff0);
  });

  it("memo instruction carries exactly the root; memoOfTx reads it back", () => {
    expect(isCommitmentMemo(ROOT)).toBe(true);
    expect(() => memoInstruction("x".repeat(64))).toThrow();
    const ix = memoInstruction(ROOT);
    expect(ix.keys).toEqual([]);
    expect(Buffer.from(ix.data).toString("utf8")).toBe(ROOT);
    const payer = Keypair.generate();
    const msg = MessageV0.compile({ payerKey: payer.publicKey, instructions: [ix], recentBlockhash: PublicKey.default.toBase58() });
    const vtx = new VersionedTransaction(msg);
    const resp = { transaction: { message: vtx.message, signatures: [] }, meta: { err: null }, slot: 1 } as unknown as VersionedTransactionResponse;
    expect(memoOfTx(resp)).toBe(ROOT);
    expect(msg.staticAccountKeys.some((k) => k.equals(MEMO_PROGRAM_ID))).toBe(true);
  });
});

describe("launch curve from pump Global", () => {
  it("devnet snapshot: 1 virtual SOL (never hardcoded)", () => {
    const c = pumpLaunchCurve(loadParams().global);
    expect(c).toEqual({
      venue: "pumpfun",
      virtualSolLamports: 1_000_000_000n,
      virtualTokenReserves: 1_073_000_000_000_000n,
      realTokenReserves: 793_100_000_000_000n,
      tokenTotalSupply: 1_000_000_000_000_000n,
    });
  });
  it("refuses zero / inconsistent values", () => {
    const g = loadParams().global;
    expect(() => pumpLaunchCurve({ ...g, initialVirtualSolReserves: new BN(0) })).toThrow();
    expect(() => pumpLaunchCurve({ ...g, initialRealTokenReserves: g.initialVirtualTokenReserves.addn(1) })).toThrow();
  });
});

class FakeAttestExecutor extends FakeExecutor {
  constructor(
    chain: FakeChain,
    readonly key: Keypair,
  ) {
    super(chain);
  }
  ownSigner() {
    return this.key;
  }
}

function engine() {
  const chain = new FakeChain();
  const clock = new FakeClock(1_700_000_000_000, chain);
  const rng = seededRng(3);
  const inv = new FakeInventory();
  const vs = vaults(2, inv);
  const pool = new VaultPool(vs, inv, rng);
  let acquired = 0;
  const acquire = pool.acquire.bind(pool);
  pool.acquire = async (r) => {
    acquired++;
    return acquire(r);
  };
  const queue = new InMemoryJobQueue(rng);
  const trade = new FakeExecutor(chain);
  const attestKey = deriveAttestKeypair(SEED);
  const attest = new FakeAttestExecutor(chain, attestKey);
  const mintVaults = new MemoryMintVaults();
  const relayer = new Relayer({
    queue, pool, executors: { trade: { pumpfun: trade }, withdraw: trade, attest }, probe: chain, mintVaults, clock, rng,
    pollMs: 2_000, resolveTimeoutMs: 120_000,
  });
  const add = (spec: JobSpec, ex: FakeExecutor) => {
    const j = queue.enqueue(spec, { notBefore: clock.now() });
    ex.sentRecorded = (sig) => queue.get(j.id)!.attempts.some((a) => a.signature === sig);
    return j.id;
  };
  return { relayer, queue, trade, attest, attestKey, mintVaults, vs, add, acquired: () => acquired, chain };
}

describe("relayer engine v3", () => {
  it("attest is signed by the attestation key, no vault is leased, memo from the landed tx", async () => {
    const t = engine();
    const id = t.add({ kind: "attest", memo: ROOT, purpose: "fair" }, t.attest);
    expect(await t.relayer.tick()).toBe(true);
    const j = t.queue.get(id)!;
    expect(j.state).toBe("executed");
    expect(t.acquired()).toBe(0);
    expect(j.attempts[0]!.vault).toBe(t.attestKey.publicKey.toBase58());
    expect(t.vs.map((v) => v.publicKey.toBase58())).not.toContain(j.attempts[0]!.vault);
    expect(j.result).toMatchObject({ status: "executed", execution: { kind: "attest", memo: ROOT } });
  });

  it("attest without a configured key fails before anything is signed", async () => {
    const t = engine();
    const queue = new InMemoryJobQueue(seededRng(1));
    const r = new Relayer({ queue, pool: new VaultPool(t.vs, new FakeInventory(), seededRng(1)), executors: { trade: {}, withdraw: t.trade }, probe: t.chain });
    const j = queue.enqueue({ kind: "attest", memo: ROOT, purpose: "fair" }, { notBefore: 0 });
    await r.tick();
    expect(queue.get(j.id)!.result).toMatchObject({ status: "failed", code: "venue_unavailable" });
    expect(queue.get(j.id)!.attempts).toEqual([]);
  });

  it("fair_create: core's mint on every attempt, pinned to the vault before sending", async () => {
    const t = engine();
    const mint = Keypair.generate();
    const spec: JobSpec = { kind: "fair_create", venue: "pumpfun", meta: { name: "F", symbol: "F" }, lamportsIn: 1_000_000n, minOut: 1n, mintKeypair: mint };
    // first attempt never lands (expires), second lands
    t.trade.behaviors = ["transport-error-dropped", "land"];
    const id = t.add(spec, t.trade);
    for (let i = 0; i < 5 && t.queue.get(id)!.state !== "executed"; i++) await t.relayer.tick();
    const j = t.queue.get(id)!;
    expect(j.result).toMatchObject({ status: "executed", execution: { kind: "create", mint: mint.publicKey.toBase58() } });
    expect(await t.mintVaults.get(mint.publicKey.toBase58())).toBe(j.attempts.at(-1)!.vault);
  });
});

const DB = process.env.DATABASE_URL;
describe.skipIf(!DB)("PostgresJobQueue v3 + launch_curves (live Postgres, temp schema)", () => {
  const schema = `relayer_v3_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let q: PostgresJobQueue;

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
    // Exactly core's 0008 DDL for the relayer-visible parts, inside the throw-away schema.
    const ddl = fs.readFileSync(path.resolve(__dirname, "../../core/migrations/0008_fair_launch.sql"), "utf8");
    const cut = (from: string, to: string) => {
      const a = ddl.indexOf(from);
      const b = ddl.indexOf(to, a);
      if (a < 0 || b < 0) throw new Error(`0008 layout changed: ${from}`);
      return ddl.slice(a, ddl.lastIndexOf("\n", b));
    };
    const jobs = cut("ALTER TABLE relayer_jobs DROP CONSTRAINT", "launch curve of the network");
    const curves = cut("CREATE TABLE launch_curves", "launches (core only)");
    const c = await admin.connect();
    try {
      await c.query(`SET search_path = ${schema}`);
      await c.query(`ALTER TABLE relayer_jobs DROP CONSTRAINT IF EXISTS relayer_jobs_op_check`);
      await c.query(idempotent(jobs.replace(/ALTER TABLE relayer_jobs DROP CONSTRAINT relayer_jobs_op_check;/, "")));
      await c.query(curves);
    } finally {
      c.release();
    }
    pool = new pg.Pool({ connectionString: DB, max: 4, options: `-c search_path=${schema}` });
    q = new PostgresJobQueue({ pool, network: "devnet" });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("claims fair_create with mint_secret and attest; attest confirm writes out_memo, no feed", async () => {
    const mint = Keypair.generate();
    await pool.query(
      `INSERT INTO relayer_jobs (op, venue, lamports_in, min_out, meta, network, mint_secret, exec_mode)
       VALUES ('fair_create', 'pumpfun', 1000000, 5, '{"name":"F","symbol":"F"}', 'devnet', $1, 'now')`,
      [Buffer.from(mint.secretKey)],
    );
    const a = (await q.claim({ workerId: "w", now: Date.now(), leaseMs: 60_000 }))!;
    expect(a.spec.kind).toBe("fair_create");
    if (a.spec.kind !== "fair_create") throw new Error();
    expect(a.spec.mintKeypair.publicKey.equals(mint.publicKey)).toBe(true);

    const id = (await pool.query<{ id: string }>(
      `INSERT INTO relayer_jobs (op, meta, network, exec_mode) VALUES ('attest', $1, 'devnet', 'now') RETURNING id`,
      [{ memo: ROOT }],
    )).rows[0]!.id;
    const b = (await q.claim({ workerId: "w", now: Date.now(), leaseMs: 60_000 }))!;
    expect(b.id).toBe(id);
    expect(b.spec).toEqual({ kind: "attest", memo: ROOT, purpose: "fair" });
    await q.reportSent(b, { signature: "sigM", lastValidBlockHeight: 9, vault: "AttestKey", sentAt: Date.now() });
    await q.reportResult(b, { status: "executed", execution: { kind: "attest", signature: "sigM", slot: 77, vault: "AttestKey", memo: ROOT, networkFee: 5000n, blockTime: 1 } });
    const r = (await pool.query(`SELECT status, out_memo, slot, vault, out_mint FROM relayer_jobs WHERE id = $1`, [id])).rows[0];
    expect(r).toEqual({ status: "confirmed", out_memo: ROOT, slot: "77", vault: "AttestKey", out_mint: null });
    expect((await pool.query(`SELECT count(*)::int AS n FROM trades`)).rows[0].n).toBe(0);
  });

  it("launch_curves upsert from the pump Global", async () => {
    const g = loadParams().global;
    const w = new LaunchCurveWriter(pool, "devnet", async () => [pumpLaunchCurve(g)]);
    expect(await w.writeOnce()).toBe(1);
    expect(await w.writeOnce()).toBe(1);
    const rows = (await pool.query(`SELECT venue, virtual_sol_lamports, token_total_supply FROM launch_curves WHERE network = 'devnet'`)).rows;
    expect(rows).toEqual([{ venue: "pumpfun", virtual_sol_lamports: "1000000000", token_total_supply: "1000000000000000" }]);
  });
});

/** Core DDL fragments re-applied on a LIKE copy of a NEWER public schema: make them idempotent. */
function idempotent(sql: string): string {
  return sql
    .replace(/ADD COLUMN (?!IF NOT EXISTS)/g, "ADD COLUMN IF NOT EXISTS ")
    .replace(/ALTER TABLE (\w+) ADD CONSTRAINT (\w+)/g, "ALTER TABLE $1 DROP CONSTRAINT IF EXISTS $2; ALTER TABLE $1 ADD CONSTRAINT $2");
}
