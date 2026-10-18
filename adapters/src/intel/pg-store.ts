import { curveJson } from "./curves";
import type pg from "pg";
import type { CreatorPubkeyFile } from "../keys";
import type { IntelStore, OffchainInfo, TickCommit, TokenSafety, WarmEntry } from "./types";

/**
 * IntelStore on core's tables (docs/INTEL.md v1, migration 0007), role
 * `unzeen_indexer` (infra/indexer-role.sql) via DATABASE_URL_INDEXER.
 * - one instance per DB: session advisory lock 0x756e7a65656e0007 on a
 *   dedicated connection held for the process lifetime;
 * - refuses to start with excess rights (creator_tokens SELECT or tokens INSERT);
 * - every write of a tick in ONE transaction (commitTick);
 * - never writes tokens / trades (the role cannot either).
 */

export const INTEL_LOCK_KEY = "8461835325787734023"; // 0x756e7a65656e0007

type Network = "devnet" | "mainnet-beta";

export class PgIntelStore implements IntelStore {
  private lockClient: pg.PoolClient | null = null;

  constructor(
    private readonly db: pg.Pool,
    private readonly network: Network,
    /** Public creator list written by the relayer (T1 race); null = DB only. */
    private readonly creators: CreatorPubkeyFile | null = null,
    /** Extra public vault addresses (adapters config), merged with the DB list. */
    private readonly extraVaults: readonly string[] = [],
  ) {}

  /** Role check + advisory lock. Throws if another indexer runs or the role is over-privileged. */
  async start(): Promise<void> {
    const r = await this.db.query<{ bad: boolean }>(
      `SELECT has_table_privilege('creator_tokens', 'SELECT') OR has_table_privilege('tokens', 'INSERT') AS bad`,
    );
    if (r.rows[0]?.bad !== false) throw new Error("this DB role can read creator_tokens or write tokens: use unzeen_indexer (DATABASE_URL_INDEXER)");
    const c = await this.db.connect();
    const l = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS ok", [INTEL_LOCK_KEY]);
    if (l.rows[0]?.ok !== true) {
      c.release();
      throw new Error("another indexer holds the intel lock");
    }
    this.lockClient = c;
  }

  async stop(): Promise<void> {
    if (!this.lockClient) return;
    await this.lockClient.query("SELECT pg_advisory_unlock($1::bigint)", [INTEL_LOCK_KEY]).catch(() => undefined);
    this.lockClient.release();
    this.lockClient = null;
  }

  async warmSet(): Promise<WarmEntry[]> {
    const r = await this.db.query<{ mint: string; hot: boolean; pinned: boolean; as_of: string | null }>(
      `SELECT w.mint, w.hot, w.pinned, (extract(epoch FROM s.as_of) * 1000)::bigint::text AS as_of
         FROM intel_warm w LEFT JOIN token_safety s ON s.mint = w.mint
        WHERE w.pinned OR w.expires_at > now()`,
    );
    return r.rows.map((x) => ({ mint: x.mint, hot: x.hot, pinned: x.pinned, asOf: x.as_of === null ? null : Number(x.as_of) }));
  }

  async peekLookups(max: number): Promise<string[]> {
    const r = await this.db.query<{ mint: string }>("SELECT mint FROM intel_requests ORDER BY queued_at, random() LIMIT $1", [max]);
    return r.rows.map((x) => x.mint);
  }

  async unzeenLaunches(): Promise<Set<string>> {
    const r = await this.db.query<{ mint: string }>("SELECT DISTINCT mint FROM trades WHERE kind = 'create'");
    return new Set(r.rows.map((x) => x.mint));
  }

  async poolCreators(): Promise<Set<string>> {
    try {
      return this.creators ? this.creators.read() : new Set();
    } catch {
      return new Set();
    }
  }

  async poolVaults(): Promise<Set<string>> {
    const r = await this.db.query<{ vault: string }>(
      `SELECT vault FROM relayer_vault_usage WHERE network = $1 UNION SELECT vault FROM mint_vaults WHERE network = $1`,
      [this.network],
    );
    return new Set([...r.rows.map((x) => x.vault), ...this.extraVaults]);
  }

  async offchain(mint: string): Promise<OffchainInfo | null> {
    const r = await this.db.query<{ socials: TokenSafety["socials"] | null; image: string | null; as_of: string }>(
      `SELECT data->'socials' AS socials, data->>'image' AS image, (extract(epoch FROM as_of) * 1000)::bigint::text AS as_of
         FROM token_safety WHERE mint = $1 AND NOT missing`,
      [mint],
    );
    const x = r.rows[0];
    if (!x || (!x.socials && !x.image)) return null;
    return { ...(x.socials ? { socials: x.socials } : {}), ...(x.image ? { image: x.image } : {}), fetchedAt: Number(x.as_of), ok: true };
  }

  private pricesWritable: Promise<boolean> | null = null;

  private curveCols: Promise<boolean> | null = null;

  /** intel_prices.progress_pct / curve (core 0035) exist. Cached once true; before 0035 only price/status are written. */
  private hasCurveColumns(): Promise<boolean> {
    if (!this.curveCols) {
      this.curveCols = this.db
        .query<{ ok: boolean }>(
          `SELECT count(*) = 2 AS ok FROM information_schema.columns
            WHERE table_name = 'intel_prices' AND column_name IN ('progress_pct', 'curve') AND table_schema = current_schema()`,
        )
        .then((r) => {
          const ok = Boolean(r.rows[0]?.ok);
          if (!ok) this.curveCols = null; // core may migrate later: ask again next tick
          return ok;
        })
        .catch(() => {
          this.curveCols = null;
          return false;
        });
    }
    return this.curveCols;
  }

  /** intel_prices (core 0011) exists and this role may upsert it. Cached; before 0011 prices are dropped. */
  private canWritePrices(): Promise<boolean> {
    if (!this.pricesWritable) {
      this.pricesWritable = this.db
        .query<{ ok: boolean }>(
          `SELECT to_regclass('intel_prices') IS NOT NULL
                  AND has_table_privilege('intel_prices', 'SELECT')
                  AND has_table_privilege('intel_prices', 'INSERT')
                  AND has_table_privilege('intel_prices', 'UPDATE') AS ok`,
        )
        .then((r) => r.rows[0]?.ok === true)
        .catch((e) => {
          this.pricesWritable = null;
          throw e;
        });
    }
    return this.pricesWritable;
  }

  private tradesWritable: Promise<boolean> | null = null;

  /** market_trades (core 0007) insertable by this role. Cached. */
  private canWriteTrades(): Promise<boolean> {
    this.tradesWritable ??= this.db
      .query<{ ok: boolean }>(`SELECT to_regclass('market_trades') IS NOT NULL AND has_table_privilege('market_trades', 'INSERT') AS ok`)
      .then((r) => r.rows[0]?.ok === true)
      .catch(() => {
        this.tradesWritable = null;
        return false;
      });
    return this.tradesWritable;
  }

  async commitTick(t: TickCommit): Promise<void> {
    const trades = t.marketTrades && t.marketTrades.length > 0 && (await this.canWriteTrades()) ? t.marketTrades : [];
    // One row per mint: a duplicate in one INSERT ... ON CONFLICT DO UPDATE aborts the whole tick.
    const prices = t.prices && t.prices.length > 0 && (await this.canWritePrices()) ? uniqueByMint(t.prices) : [];
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      const asOf = t.asOf / 1000;
      for (const row of t.rows) {
        await c.query(
          `INSERT INTO token_safety (mint, as_of, missing, data) VALUES ($1, to_timestamp($2), FALSE, $3::jsonb)
           ON CONFLICT (mint) DO UPDATE SET as_of = EXCLUDED.as_of, missing = FALSE, data = EXCLUDED.data`,
          [row.mint, asOf, JSON.stringify(safetyData(row))],
        );
      }
      for (const m of t.missing) {
        await c.query(
          `INSERT INTO token_safety (mint, as_of, missing, data) VALUES ($1, to_timestamp($2), TRUE, NULL)
           ON CONFLICT (mint) DO UPDATE SET as_of = EXCLUDED.as_of, missing = TRUE, data = NULL`,
          [m, asOf],
        );
      }
      for (const card of t.cards) {
        await c.query(
          `INSERT INTO intel_tokens (mint, venue, symbol, name, image, decimals, status, price_sol, market_cap_sol, created_at, as_of)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, to_timestamp($10), to_timestamp($11)
            WHERE NOT EXISTS (SELECT 1 FROM tokens WHERE mint = $1)
           ON CONFLICT (mint) DO UPDATE SET venue = EXCLUDED.venue, symbol = EXCLUDED.symbol, name = EXCLUDED.name,
             image = EXCLUDED.image, decimals = EXCLUDED.decimals, status = EXCLUDED.status, price_sol = EXCLUDED.price_sol,
             market_cap_sol = EXCLUDED.market_cap_sol, as_of = EXCLUDED.as_of`,
          [card.mint, card.venue, card.symbol, card.name, card.image, card.decimals, card.status, card.priceSol, card.marketCapSol, card.createdAt / 1000, asOf],
        );
      }
      if (t.batch.length > 0) {
        await c.query(
          `INSERT INTO intel_warm (mint, expires_at) SELECT unnest($1::text[]), now() + interval '7 days'
           ON CONFLICT (mint) DO UPDATE SET expires_at = GREATEST(intel_warm.expires_at, EXCLUDED.expires_at)`,
          [t.batch],
        );
      }
      if (t.consumed.length > 0) await c.query("DELETE FROM intel_requests WHERE mint = ANY($1::text[])", [t.consumed]);
      for (const u of t.curveUpdates) {
        // Live curve state since the last snapshot; written only now, with the tick's minute.
        await c.query(
          `UPDATE token_safety SET as_of = to_timestamp($2),
             data = jsonb_set(jsonb_set(data, '{market,status}', to_jsonb($3::text)), '{market,curveProgressPct}', to_jsonb($4::text))
           WHERE mint = $1 AND NOT missing AND data IS NOT NULL`,
          [u.mint, asOf, u.graduated ? "graduated" : "curve", u.progressPct],
        );
        await c.query(
          `UPDATE intel_tokens SET status = $2, price_sol = $3::numeric, market_cap_sol = $4::numeric, as_of = to_timestamp($5) WHERE mint = $1`,
          [u.mint, u.graduated ? "graduated" : "curve", u.priceSol, u.marketCapSol, asOf],
        );
      }
      if (trades.length > 0) {
        // Public trades of hot warm mints since the last tick; replays of a tx are ignored (UNIQUE signature, ix).
        await c.query(
          `INSERT INTO market_trades (mint, kind, venue, symbol, trader, unzeen, tags, token_amount, sol_amount, decimals, signature, ix, slot, ts)
           SELECT m, k, v, sy, tr, u, COALESCE(string_to_array(NULLIF(tg, ''), ','), '{}'::text[]), ta, sa, d, sig, ix, sl, to_timestamp(ts / 1000.0)
             FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::boolean[], $7::text[], $8::numeric[], $9::numeric[],
                         $10::smallint[], $11::text[], $12::smallint[], $13::bigint[], $14::bigint[])
                  AS x(m, k, v, sy, tr, u, tg, ta, sa, d, sig, ix, sl, ts)
           ON CONFLICT (signature, ix) DO NOTHING`,
          [
            trades.map((x) => x.mint), trades.map((x) => x.kind), trades.map((x) => x.venue), trades.map((x) => x.symbol.slice(0, 16)), trades.map((x) => x.trader),
            trades.map((x) => x.unzeen), trades.map((x) => x.tags.join(",")), trades.map((x) => x.tokenAmount.toString()), trades.map((x) => x.solAmount.toString()),
            trades.map((x) => x.decimals), trades.map((x) => x.signature), trades.map((x) => x.ix), trades.map((x) => x.slot), trades.map((x) => x.ts),
          ],
        );
      }
      if (prices.length > 0) {
        // INTEL v2: current + previous value; an older tick never overwrites a newer one.
        await c.query(
          (await this.hasCurveColumns())
            ? `INSERT INTO intel_prices (mint, price_sol, status, tick_at, progress_pct, curve)
               SELECT m, p::numeric, s, $4::bigint, g::numeric, c::jsonb
               FROM unnest($1::text[], $2::text[], $3::text[], $5::text[], $6::text[]) AS x(m, p, s, g, c)
               ON CONFLICT (mint) DO UPDATE SET prev_price_sol = intel_prices.price_sol, prev_tick_at = intel_prices.tick_at,
                 price_sol = EXCLUDED.price_sol, status = EXCLUDED.status, tick_at = EXCLUDED.tick_at,
                 progress_pct = EXCLUDED.progress_pct, curve = EXCLUDED.curve
               WHERE intel_prices.tick_at < EXCLUDED.tick_at`
            : `INSERT INTO intel_prices (mint, price_sol, status, tick_at)
               SELECT m, p::numeric, s, $4::bigint FROM unnest($1::text[], $2::text[], $3::text[]) AS x(m, p, s)
               ON CONFLICT (mint) DO UPDATE SET prev_price_sol = intel_prices.price_sol, prev_tick_at = intel_prices.tick_at,
                 price_sol = EXCLUDED.price_sol, status = EXCLUDED.status, tick_at = EXCLUDED.tick_at
               WHERE intel_prices.tick_at < EXCLUDED.tick_at`,
          [
            prices.map((p) => p.mint),
            prices.map((p) => p.priceSol),
            prices.map((p) => p.status),
            String(t.tickStartedAt),
            ...((await this.hasCurveColumns())
              ? [prices.map((p) => (p.progressPct && /^\d{1,3}\.\d{2}$/.test(p.progressPct) && Number(p.progressPct) <= 100 ? p.progressPct : null)), prices.map((p) => (p.curve ? JSON.stringify(curveJson(p.curve)) : null))]
              : []),
          ],
        );
      }
      await c.query("DELETE FROM intel_subscriptions");
      for (const s of t.subscriptions) {
        await c.query("INSERT INTO intel_subscriptions (account, mint, kind) VALUES ($1, $2, $3) ON CONFLICT (account) DO NOTHING", [s.account, s.mint, s.kind]);
      }
      await c.query(
        `INSERT INTO intel_meta (key, value, updated_at) VALUES ('next_tick_at', $1, now()), ('last_tick_at', $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [String(t.nextTickAt), String(t.tickStartedAt)],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}

/** token_safety.data: TokenSafety without mint / asOf / unzeen (core sets them) and without holders.asOf. */
export function safetyData(row: TokenSafety): Record<string, unknown> {
  const market: Record<string, unknown> = {
    venue: row.market.venue ?? "jupiter",
    status: row.market.status === "curve" ? "curve" : "graduated",
  };
  if (row.market.curveProgressPct !== undefined) market.curveProgressPct = row.market.curveProgressPct;
  if (row.market.lpBurnedPct !== undefined) market.lpBurnedPct = row.market.lpBurnedPct;
  const d: Record<string, unknown> = { program: row.program, authorities: row.authorities, market };
  if (row.holders) {
    const { asOf: _asOf, ...h } = row.holders;
    d.holders = row.unzeen ? { ...h, devPct: null } : h;
  }
  if (row.socials) d.socials = row.socials;
  if (row.image) d.image = row.image;
  if (row.dev && !row.unzeen) d.dev = row.dev;
  if (row.firstBlocks) d.firstBlocks = row.firstBlocks;
  return d;
}

/** Last row per mint wins (INTEL v2: one intel_prices row per mint per tick). */
export function uniqueByMint<T extends { mint: string }>(rows: readonly T[]): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(r.mint, r);
  return [...m.values()];
}
