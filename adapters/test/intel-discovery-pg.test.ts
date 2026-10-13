import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRepoEnv } from "../src/env";
import { PROPOSED_DISCOVERY_SQL, PgDiscoveryStore } from "../src/intel/discovery-pg";

loadRepoEnv();
const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)("PgDiscoveryStore on the PROPOSED intel_discovery table (live Postgres, temp schema)", () => {
  const schema = `disc_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DB, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DB, max: 2, options: `-c search_path=${schema}` });
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("unavailable before core creates the table; upsert / load / delete in one commit after", async () => {
    const s = new PgDiscoveryStore(pool, "devnet");
    expect(await s.available()).toBe(false);
    await pool.query(PROPOSED_DISCOVERY_SQL);
    expect(await s.available()).toBe(true);
    const row = {
      mint: "M1", venue: "pumpfun" as const, createdAt: 1_791_900_000_000, name: "N", symbol: "S", status: "curve" as const,
      priceSol: "0.000000028", marketCapSol: "28.5", progressPct: "1.25", asOf: 1_791_900_060_000,
    };
    await s.commit({ asOf: row.asOf, upserts: [row, { ...row, mint: "M2", venue: "meteora-dbc", name: null, symbol: null, progressPct: null, pool: "P", config: "C" }], removed: [] });
    await s.commit({ asOf: row.asOf + 60_000, upserts: [{ ...row, name: null, priceSol: "0.00000003", asOf: row.asOf + 60_000 }], removed: ["M2"] });
    const rows = await s.load();
    expect(rows).toEqual([{ ...row, priceSol: "0.00000003", asOf: row.asOf + 60_000 }]); // name kept (COALESCE)
    expect(await new PgDiscoveryStore(pool, "mainnet-beta").load()).toEqual([]);
  });
});
