import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRepoEnv } from "../src/env";
import { PgIntelStore } from "../src/intel/pg-store";
import type { TickCommit } from "../src/intel/types";

loadRepoEnv();
const DB = process.env.DATABASE_URL;

/** intel_prices DDL exactly as in core's 0011 (the table may not be applied locally yet). */
function intelPricesDdl(): string {
  const ddl = fs.readFileSync(path.resolve(__dirname, "../../core/migrations/0011_orders.sql"), "utf8");
  const a = ddl.indexOf("CREATE TABLE intel_prices");
  const b = ddl.indexOf(");", a);
  if (a < 0 || b < 0) throw new Error("0011 layout changed");
  return ddl.slice(a, b + 2);
}

describe.skipIf(!DB || !fs.existsSync(path.resolve(__dirname, "../../core/migrations/0011_orders.sql")))("intel_prices in the tick transaction (live Postgres, temp schema)", () => {
  const schema = `intel_v2_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DB, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const t of ["token_safety", "intel_tokens", "intel_warm", "intel_requests", "intel_subscriptions", "intel_meta", "tokens", "market_trades"]) {
      await admin.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    }
    const c = await admin.connect();
    try {
      await c.query(`SET search_path = ${schema}`);
      await c.query(intelPricesDdl());
    } finally {
      c.release();
    }
    pool = new pg.Pool({ connectionString: DB, max: 2, options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const commit = (tickStartedAt: number, prices: TickCommit["prices"]): TickCommit => ({
    asOf: Math.floor(tickStartedAt / 60_000) * 60_000,
    tickStartedAt,
    nextTickAt: tickStartedAt + 60_000,
    rows: [],
    cards: [],
    missing: [],
    batch: [],
    consumed: [],
    curveUpdates: [],
    subscriptions: [],
    ...(prices ? { prices } : {}),
  });

  it("upsert keeps current + previous, an older tick never overwrites, tick_at = last_tick_at", async () => {
    const store = new PgIntelStore(pool, "devnet");
    const M = "So11111111111111111111111111111111111111112";
    await store.commitTick(commit(1000, [{ mint: M, priceSol: "0.000000028", status: "curve" }]));
    await store.commitTick(commit(2000, [{ mint: M, priceSol: "0.000000030", status: "graduated" }]));
    await store.commitTick(commit(1500, [{ mint: M, priceSol: "9", status: "curve" }])); // stale tick
    await store.commitTick(commit(3000, [])); // failed pass: untouched
    const r = (await pool.query(`SELECT price_sol::text, status, tick_at::text, prev_price_sol::text, prev_tick_at::text FROM intel_prices`)).rows;
    expect(r).toEqual([{ price_sol: "0.000000030", status: "graduated", tick_at: "2000", prev_price_sol: "0.000000028", prev_tick_at: "1000" }]);
    const last = (await pool.query(`SELECT value FROM intel_meta WHERE key = 'last_tick_at'`)).rows[0].value;
    expect(last).toBe("3000");
  });

  it("a mint listed twice in one tick does not abort the tick transaction", async () => {
    const store = new PgIntelStore(pool, "devnet");
    const M = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
    await store.commitTick(commit(5000, [
      { mint: M, priceSol: "0.1", status: "curve" },
      { mint: M, priceSol: "0.2", status: "curve" },
    ]));
    const r = (await pool.query(`SELECT price_sol::text, tick_at::text FROM intel_prices WHERE mint = $1`, [M])).rows;
    expect(r).toEqual([{ price_sol: "0.2", tick_at: "5000" }]);
    expect((await pool.query(`SELECT value FROM intel_meta WHERE key = 'last_tick_at'`)).rows[0].value).toBe("5000");
  });

  it("market_trades: NUMERIC (core 0026) amounts above i64 round-trip exactly", async () => {
    const store = new PgIntelStore(pool, "devnet");
    const M = "So11111111111111111111111111111111111111112";
    const big = 10n ** 27n + 7n; // 18-decimal supply scale: > i64 / u64
    await store.commitTick({
      ...commit(7000, undefined),
      marketTrades: [
        { mint: M, kind: "buy", venue: "pumpfun", symbol: "BIG", decimals: 6, trader: "T1", unzeen: false, tags: ["whale"], tokenAmount: big, solAmount: 2n ** 64n, signature: "sig-numeric", ix: 0, slot: 1, ts: 7000 },
      ],
    });
    const r = (await pool.query(`SELECT token_amount::text, sol_amount::text FROM market_trades WHERE signature = 'sig-numeric'`)).rows;
    expect(r).toEqual([{ token_amount: big.toString(), sol_amount: (2n ** 64n).toString() }]);
  });
});
