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

  it("v4 (core 0035): progress_pct and the curve state are written once the columns exist", async () => {
    const store = new PgIntelStore(pool, "devnet");
    const M = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
    // Before 0035: the old two-column write still works.
    await store.commitTick(commit(8000, [{ mint: M, priceSol: "0.5", status: "curve", progressPct: "12.50", curve: null }]));
    const sql = fs.readFileSync(path.resolve(__dirname, "../../core/migrations/0035_trading_comfort.sql"), "utf8");
    const a = sql.indexOf("ALTER TABLE intel_prices");
    await pool.query(sql.slice(a, sql.indexOf(";", a) + 1));
    const curve = { virtualSol: 31_000_000_000n, virtualTokens: 1_038_000_000_000_000n, feeBps: 100, buyFee: "input" as const, buyLimitLamports: 54_000_000_000n, sellLimitTokens: null };
    await store.commitTick(commit(9000, [{ mint: M, priceSol: "0.6", status: "curve", progressPct: "12.75", curve }, { mint: "So11111111111111111111111111111111111111112", priceSol: "1", status: "graduated", progressPct: null, curve: null }]));
    const r = (await pool.query(`SELECT progress_pct::text, curve FROM intel_prices WHERE mint = $1`, [M])).rows;
    expect(r).toEqual([{ progress_pct: "12.75", curve: { virtualSol: "31000000000", virtualTokens: "1038000000000000", feeBps: 100, buyFee: "input", buyLimitLamports: "54000000000" } }]);
    // A malformed progress never reaches the CHECK: written as NULL.
    await store.commitTick(commit(10_000, [{ mint: M, priceSol: "0.6", status: "curve", progressPct: "100.01", curve: null }]));
    expect((await pool.query(`SELECT progress_pct, curve FROM intel_prices WHERE mint = $1`, [M])).rows).toEqual([{ progress_pct: null, curve: null }]);
  });
});
