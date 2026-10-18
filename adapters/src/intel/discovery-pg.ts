import type { Pool } from "pg";
import { Connection, type AccountInfo, type PublicKey } from "@solana/web3.js";
import { rateLimitedFetch } from "./reader";
import { getTransactionAnyVersion } from "../tx";
import type { DiscoveryCandidate, DiscoveryChain, DiscoveryCommit, DiscoveryStore, DiscoveryVenue } from "./discovery";

/**
 * PROPOSED core migration (Discovery, FEATURES.md 9). Public data only (no
 * user, request or anon key anywhere). Written by the indexer on its tick, read
 * by the API for /tokens?source=discovery (same list for every visitor).
 * Exported for tests and for core to copy.
 */
export const PROPOSED_DISCOVERY_SQL = `
CREATE TABLE IF NOT EXISTS intel_discovery (
  network        TEXT        NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
  mint           TEXT        NOT NULL,
  venue          TEXT        NOT NULL CHECK (venue IN ('pumpfun', 'meteora-dbc', 'raydium-launchlab')),
  created_at     TIMESTAMPTZ NOT NULL,
  name           TEXT        NULL CHECK (char_length(name) <= 64),
  symbol         TEXT        NULL CHECK (char_length(symbol) <= 64),
  status         TEXT        NOT NULL CHECK (status IN ('curve', 'graduated')),
  price_sol      NUMERIC     NOT NULL CHECK (price_sol >= 0),
  market_cap_sol NUMERIC     NOT NULL CHECK (market_cap_sol >= 0),
  progress_pct   NUMERIC(5,2) NULL CHECK (progress_pct BETWEEN 0 AND 100),
  as_of          TIMESTAMPTZ NOT NULL,
  pool           TEXT        NULL,
  config         TEXT        NULL,
  PRIMARY KEY (network, mint)
);
CREATE INDEX IF NOT EXISTS intel_discovery_recent ON intel_discovery (network, created_at DESC);
`;

/** Rights (infra/indexer-role.sql); the API role only reads. */
export const PROPOSED_DISCOVERY_GRANTS = `
GRANT SELECT, INSERT, UPDATE, DELETE ON intel_discovery TO unzeen_indexer;
-- API role (whatever core uses for /api/tokens): SELECT only.
`;

export class PgDiscoveryStore implements DiscoveryStore {
  constructor(
    private readonly pool: Pool,
    private readonly network: "devnet" | "mainnet-beta",
  ) {}

  /** True when core created the table and this role may write it. */
  async available(): Promise<boolean> {
    const r = await this.pool.query<{ ok: boolean }>(
      `SELECT to_regclass('intel_discovery') IS NOT NULL
              AND has_table_privilege(current_user, 'intel_discovery', 'INSERT,UPDATE,DELETE,SELECT') AS ok`,
    );
    return r.rows[0]?.ok === true;
  }

  async load(): Promise<DiscoveryCandidate[]> {
    const r = await this.pool.query<{
      mint: string; venue: DiscoveryVenue; created_ms: string; name: string | null; symbol: string | null; status: "curve" | "graduated";
      price_sol: string; market_cap_sol: string; progress_pct: string | null; as_of_ms: string; pool: string | null; config: string | null;
    }>(
      `SELECT mint, venue, (extract(epoch FROM created_at) * 1000)::bigint AS created_ms, name, symbol, status,
              price_sol::text, market_cap_sol::text, progress_pct::text, (extract(epoch FROM as_of) * 1000)::bigint AS as_of_ms, pool, config
         FROM intel_discovery WHERE network = $1`,
      [this.network],
    );
    return r.rows.map((x) => ({
      mint: x.mint, venue: x.venue, createdAt: Number(x.created_ms), name: x.name, symbol: x.symbol, status: x.status,
      priceSol: x.price_sol, marketCapSol: x.market_cap_sol, progressPct: x.progress_pct, asOf: Number(x.as_of_ms),
      ...(x.pool ? { pool: x.pool } : {}), ...(x.config ? { config: x.config } : {}),
    }));
  }

  async commit(c: DiscoveryCommit): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (c.removed.length) await client.query(`DELETE FROM intel_discovery WHERE network = $1 AND mint = ANY($2::text[])`, [this.network, c.removed]);
      for (const u of c.upserts) {
        await client.query(
          `INSERT INTO intel_discovery (network, mint, venue, created_at, name, symbol, status, price_sol, market_cap_sol, progress_pct, as_of, pool, config)
           VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000), $5, $6, $7, $8::numeric, $9::numeric, $10::numeric,
                   to_timestamp($11::double precision / 1000), $12, $13)
           ON CONFLICT (network, mint) DO UPDATE SET
             name = COALESCE(EXCLUDED.name, intel_discovery.name), symbol = COALESCE(EXCLUDED.symbol, intel_discovery.symbol),
             status = EXCLUDED.status, price_sol = EXCLUDED.price_sol, market_cap_sol = EXCLUDED.market_cap_sol,
             progress_pct = EXCLUDED.progress_pct, as_of = EXCLUDED.as_of`,
          [this.network, u.mint, u.venue, u.createdAt, u.name, u.symbol, u.status, u.priceSol, u.marketCapSol, u.progressPct, u.asOf, u.pool ?? null, u.config ?? null],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}

/** Discovery reads on their own rate-limited connection (never user-driven). */
export class RpcDiscoveryChain implements DiscoveryChain {
  readonly conn: Connection;
  constructor(url: string, o: { rps?: number; wsUrl?: string | null } = {}) {
    this.conn = new Connection(url, { commitment: "confirmed", fetch: rateLimitedFetch(o.rps ?? 2), ...(o.wsUrl ? { wsEndpoint: o.wsUrl } : {}) });
  }
  async getMultipleAccounts(keys: readonly PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    return this.conn.getMultipleAccountsInfo(keys as PublicKey[]);
  }
  /** Logs of the create (CreateEvent is in "Program data:"); v1 transactions included. */
  async getLogs(signature: string): Promise<string[] | null> {
    const tx = await getTransactionAnyVersion(this.conn, signature).catch(() => null);
    if (!tx?.meta || tx.meta.err) return null;
    return tx.meta.logMessages ?? null;
  }
}
