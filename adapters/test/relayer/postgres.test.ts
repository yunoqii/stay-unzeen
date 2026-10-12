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
    ).toEqual({ kind: "withdraw", mint: MINT, to: dest, amount: 9n, avoidVaults: [], gasLamports: 2_000_000n });
  });
  it("rejects other networks, unsupported ops and missing fields", () => {
    expect(() => rowToSpec(ROW, "mainnet-beta")).toThrow(/devnet/);
    expect(() => rowToSpec({ ...ROW, op: "create" }, "devnet")).toThrow(/not supported/);
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
    await insert({ op: "create", venue: "pumpfun", lamports_in: 0, min_out: 0, network: "devnet", meta: {} });
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

  it("transfer avoids vaults of recent buys of the same mint", async () => {
    await pool.query(`DELETE FROM relayer_jobs`);
    await pool.query(
      `INSERT INTO relayer_jobs (op, venue, mint, lamports_in, min_out, network, status, signature, vault)
       VALUES ('buy', 'pumpfun', $1, 1, 1, 'devnet', 'confirmed', 'sigB', 'buyVault')`,
      [MINT],
    );
    const dest = Keypair.generate().publicKey.toBase58();
    await insert({ op: "transfer", mint: MINT, token_amount: 10, dest, gas_lamports: 2_000_000, network: "devnet" });
    const c = (await claim())!;
    expect(c.spec).toMatchObject({ kind: "withdraw", to: dest, avoidVaults: ["buyVault"], gasLamports: 2_000_000n });
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
});
