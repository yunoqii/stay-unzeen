import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgFeeSweepStore } from "../src/relayer/fee-sweeper";

const DB = process.env.DATABASE_URL;

// Temp schema with a LIKE copy of core's creator_fee_sweeps (0010 + 0019/0020 columns when present).
describe.skipIf(!DB)("PgFeeSweepStore on creator_fee_sweeps (live Postgres, temp schema)", () => {
  const schema = `fees_it_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let present = false;
  let quoteCols = false;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DB, max: 1 });
    present = (await admin.query(`SELECT to_regclass('public.creator_fee_sweeps') IS NOT NULL AS ok`)).rows[0]?.ok === true;
    if (!present) return;
    quoteCols = (await admin.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'creator_fee_sweeps' AND column_name IN ('quote_mint', 'quote_amount')`)).rows[0].n === 2;
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.creator_fee_sweeps (LIKE public.creator_fee_sweeps INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    await admin.query(`CREATE SEQUENCE ${schema}.fs_seq`);
    await admin.query(`ALTER TABLE ${schema}.creator_fee_sweeps ALTER COLUMN id SET DEFAULT nextval('${schema}.fs_seq')`);
    pool = new pg.Pool({ connectionString: DB, max: 2, options: `-c search_path=${schema}` });
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("SOL rows as before; quote rows with quote_mint / quote_amount / lamports (v9 §2) when core 0019 is there", async () => {
    if (!present) return;
    const s = new PgFeeSweepStore(pool);
    expect(await s.supportsQuote()).toBe(quoteCols);
    const row = { network: "devnet" as const, venue: "raydium-launchlab" as const, kind: "creator" as const, mint: "M", authority: "A", lastValidBlockHeight: 10 };
    await s.recordSent({ ...row, signature: "SOL1" });
    await s.confirm("SOL1", 89_709n, 5, 1_760_000_000);
    expect((await pool.query(`SELECT status, lamports::text AS l FROM creator_fee_sweeps WHERE signature = 'SOL1'`)).rows[0]).toEqual({ status: "confirmed", l: "89709" });
    if (!quoteCols) {
      await expect(s.recordSent({ ...row, signature: "Q1", quoteMint: "USDC" })).rejects.toThrow(/quote columns/);
      return;
    }
    await s.recordSent({ ...row, signature: "Q1", quoteMint: "USDC" });
    expect((await s.pending("devnet")).find((r) => r.signature === "Q1")).toMatchObject({ quoteMint: "USDC" });
    await s.confirm("Q1", 104_800n, 6, null, 10_537n);
    expect((await pool.query(`SELECT status, lamports::text AS l, quote_mint, quote_amount::text AS q FROM creator_fee_sweeps WHERE signature = 'Q1'`)).rows[0]).toEqual({ status: "confirmed", l: "104800", quote_mint: "USDC", q: "10537" });
  });
});
