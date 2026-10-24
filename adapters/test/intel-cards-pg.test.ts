import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRepoEnv } from "../src/env";
import { PgIntelStore } from "../src/intel/pg-store";
import type { TickCommit, TokenCard } from "../src/intel/types";

loadRepoEnv();
const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)("card lane + discovery warm set (live Postgres, temp schema)", () => {
  const schema = `intel_cards_${randomBytes(4).toString("hex")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DB, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const t of ["token_safety", "intel_tokens", "intel_warm", "intel_requests", "intel_subscriptions", "intel_meta", "tokens"]) {
      await admin.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    }
    pool = new pg.Pool({ connectionString: DB, max: 2, options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const A = "So11111111111111111111111111111111111111112";
  const B = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
  const card = (mint: string, image: string | null): TokenCard => ({
    mint, venue: "pumpfun", symbol: "X", name: "X", image, decimals: 6, status: "curve", priceSol: "0.000000028", marketCapSol: "28", createdAt: 1_760_000_000_000,
  });
  const tick = (o: Partial<TickCommit>): TickCommit => ({
    asOf: 1_760_000_040_000, tickStartedAt: 1_760_000_045_000, nextTickAt: 1_760_000_105_000,
    rows: [], cards: [], missing: [], batch: [], consumed: [], curveUpdates: [], subscriptions: [], ...o,
  });

  it("commitCards: cards + short warm + next_card_at; a missing never replaces a snapshot; queue untouched", async () => {
    const store = new PgIntelStore(pool, "devnet");
    await pool.query(`INSERT INTO intel_requests (mint) VALUES ($1)`, [A]);
    await pool.query(`INSERT INTO token_safety (mint, as_of, missing, data) VALUES ($1, date_trunc('minute', now()), FALSE, '{"program":"spl-token"}')`, [B]);
    await store.commitCards({ asOf: 1_760_000_040_000, nextCardAt: 1_760_000_050_000, cards: [card(A, "https://h/media/a.png")], missing: [B], batch: [A, B] });
    expect((await pool.query(`SELECT image FROM intel_tokens WHERE mint = $1`, [A])).rows[0].image).toBe("https://h/media/a.png");
    expect((await pool.query(`SELECT missing FROM token_safety WHERE mint = $1`, [B])).rows[0].missing).toBe(false);
    expect((await pool.query(`SELECT count(*)::int AS n FROM intel_requests`)).rows[0].n).toBe(1);
    const w = (await pool.query(`SELECT mint, extract(epoch FROM expires_at - now())::int AS s FROM intel_warm ORDER BY mint`)).rows;
    expect(w).toHaveLength(2);
    for (const r of w) expect(r.s).toBeLessThanOrEqual(15 * 60);
    expect((await pool.query(`SELECT value FROM intel_meta WHERE key = 'next_card_at'`)).rows[0].value).toBe("1760000050000");
    // A later card without an image keeps the mirrored one.
    await store.commitCards({ asOf: 1_760_000_100_000, nextCardAt: 1_760_000_110_000, cards: [card(A, null)], missing: [], batch: [A] });
    expect((await pool.query(`SELECT image FROM intel_tokens WHERE mint = $1`, [A])).rows[0].image).toBe("https://h/media/a.png");
  });

  it("commitTick: batch -> 7 days, discovery -> >= 1 h, never shortened", async () => {
    const store = new PgIntelStore(pool, "devnet");
    const D = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
    await store.commitTick(tick({ batch: [A], discovery: [D, A] }));
    const w = Object.fromEntries((await pool.query(`SELECT mint, extract(epoch FROM expires_at - now())::int AS s FROM intel_warm`)).rows.map((r) => [r.mint, r.s]));
    expect(w[A]).toBeGreaterThan(6 * 86_400);
    expect(w[D]).toBeGreaterThan(3_500);
    expect(w[D]).toBeLessThanOrEqual(3_600);
    const ws = await store.warmSet();
    expect(ws.map((x) => x.mint)).toContain(D);
  });
});
