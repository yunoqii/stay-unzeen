import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRepoEnv } from "../../src/env";
import { PostgresJobQueue } from "../../src/relayer/postgres-queue";

loadRepoEnv();
const DB = process.env.DATABASE_URL;

// Throw-away schema with copies of public tables + the PROPOSED 0015 column.
describe.skipIf(!DB)("fair-launch v2 on PostgresJobQueue (live Postgres, temp schema)", () => {
  const schema = `relayer_fb_${randomBytes(4).toString("hex")}`;
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
    pool = new pg.Pool({ connectionString: DB, max: 4, options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  async function fairJob(): Promise<{ q: PostgresJobQueue; id: string }> {
    const mint = Keypair.generate();
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO relayer_jobs (op, venue, lamports_in, min_out, meta, network, mint_secret, exec_mode)
         VALUES ('fair_create', 'pumpfun', 9000000000, 5, '{"name":"F","symbol":"F"}', 'devnet', $1, 'now') RETURNING id`,
        [Buffer.from(mint.secretKey)],
      )
    ).rows[0]!.id;
    return { q: new PostgresJobQueue({ pool, network: "devnet" }), id };
  }

  it("without the column: legs are not stored (rediscovered later), leg feed rows still written", async () => {
    const { q, id } = await fairJob();
    const c = (await q.claim({ workerId: "w", now: Date.now(), leaseMs: 60_000 }))!;
    await q.reportSent(c, { signature: "S0", lastValidBlockHeight: 9, vault: "VA", sentAt: Date.now(), bundle: { legs: [{ signature: "S1", vault: "VB" }] } });
    await q.reportResult(c, {
      status: "executed",
      execution: {
        kind: "create", signature: "S0", slot: 7, vault: "VA", mint: "M1", creator: "C", tokenAmount: 3_000n, solAmount: 150n, networkFee: 10n,
        decimals: 6, blockTime: 1, name: "F", symbol: "F", imageUrl: null, market: null, creatorFee: 3n,
        legs: [{ kind: "buy", signature: "S1", slot: 7, vault: "VB", mint: "M1", tokenAmount: 2_000n, solAmount: 100n, networkFee: 5n, decimals: 6, fromEvent: true, blockTime: 1, symbol: "F", market: null }],
      },
    });
    const job = (await pool.query(`SELECT status, signature, out_token_amount, out_lamports, network_fee, out_creator_fee FROM relayer_jobs WHERE id = $1`, [id])).rows[0];
    expect(job).toEqual({ status: "confirmed", signature: "S0", out_token_amount: "3000", out_lamports: "150", network_fee: "10", out_creator_fee: "3" });
    const t = (await pool.query(`SELECT kind, signature, token_amount, sol_amount FROM trades WHERE mint = 'M1' ORDER BY id`)).rows;
    expect(t).toEqual([
      { kind: "create", signature: "S0", token_amount: "0", sol_amount: "0" },
      { kind: "buy", signature: "S0", token_amount: "1000", sol_amount: "50" },
      { kind: "buy", signature: "S1", token_amount: "2000", sol_amount: "100" },
    ]);
  });

  it("with bundle_legs (proposed 0015): legs recorded before the send and returned on the next claim", async () => {
    await admin.query(`ALTER TABLE ${schema}.relayer_jobs ADD COLUMN bundle_legs JSONB`);
    const { id } = await fairJob();
    const q = new PostgresJobQueue({ pool, network: "devnet" }); // fresh column cache
    const c = (await q.claim({ workerId: "w", now: Date.now(), leaseMs: 60_000 }))!;
    expect(c.id).toBe(id);
    await q.reportSent(c, {
      signature: "T0", lastValidBlockHeight: 9, vault: "VA", sentAt: Date.now(),
      bundle: { legs: [{ signature: "T1", vault: "VB", rawTx: "AQI=" }, { signature: "T2", vault: "VC" }] },
    });
    const raw = (await pool.query(`SELECT bundle_legs FROM relayer_jobs WHERE id = $1`, [id])).rows[0].bundle_legs;
    expect(raw).toEqual([{ sig: "T1", vault: "VB" }, { sig: "T2", vault: "VC" }]); // no raw bytes stored
    await pool.query(`UPDATE relayer_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    const again = (await q.claim({ workerId: "w2", now: Date.now(), leaseMs: 60_000 }))!;
    expect(again.attempts[0]).toMatchObject({ signature: "T0", bundle: { legs: [{ signature: "T1", vault: "VB" }, { signature: "T2", vault: "VC" }] } });
    // a later single-tx attempt clears the legs
    await q.reportSent(again, { signature: "U0", lastValidBlockHeight: 99, vault: "VA", sentAt: Date.now() });
    expect((await pool.query(`SELECT bundle_legs FROM relayer_jobs WHERE id = $1`, [id])).rows[0].bundle_legs).toBeNull();
  });
});
