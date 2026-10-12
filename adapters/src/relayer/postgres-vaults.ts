import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CreatorIndexCounter } from "../keys";
import type { SolanaNetwork } from "./postgres-queue";
import type { VaultLease, VaultLock, VaultUsage } from "./vaults";

/**
 * Postgres-backed relayer state shared by all relayer processes.
 *
 * - PgAdvisoryVaultLock: "one tx in flight per vault" via session advisory
 *   locks. Needs NO table and no grant (pg_try_advisory_lock is PUBLIC).
 *   The lock lives as long as the dedicated connection: a crashed relayer
 *   releases it automatically.
 * - JobsVaultUsage: rotation age per vault derived from `relayer_jobs`
 *   (`vault`, `claimed_at`), which the relayer role can already read. No table.
 * - PgVaultUsage / PgCreatorIndexCounter: use the tables proposed to core in
 *   PROPOSED_RELAYER_STATE_SQL (not created by the relayer; core migrates).
 *   Until then: JobsVaultUsage and the file counter (keys.ts).
 */

/** "UNZV": namespace of vault advisory locks (first int4 key). */
const LOCK_CLASS = 0x554e5a56;

/** Second int4 key: stable hash of network + vault address. */
export function vaultLockKey(network: SolanaNetwork, vault: string): number {
  return createHash("sha256").update(`${network}:${vault}`).digest().readInt32BE(0);
}

export class PgAdvisoryVaultLock implements VaultLock {
  /**
   * `pool` should be dedicated to locks (each held lock pins one connection):
   * size it >= the number of vaults.
   */
  constructor(
    private readonly pool: Pool,
    private readonly network: SolanaNetwork,
  ) {}

  async tryAcquire(vault: string): Promise<VaultLease | null> {
    const key = vaultLockKey(this.network, vault);
    const client: PoolClient = await this.pool.connect();
    let ok = false;
    try {
      const r = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1::int4, $2::int4) AS ok`, [LOCK_CLASS, key]);
      ok = r.rows[0]?.ok === true;
    } catch (e) {
      client.release(e as Error);
      throw e;
    }
    if (!ok) {
      client.release();
      return null;
    }
    // A held connection that dies drops the lock server-side; swallow the
    // socket error here (the pool would otherwise crash the process) and
    // destroy the client on release.
    let lost: Error | null = null;
    const onError = (e: Error) => {
      lost = e;
    };
    client.on("error", onError);
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          if (lost) throw lost;
          await client.query(`SELECT pg_advisory_unlock($1::int4, $2::int4)`, [LOCK_CLASS, key]);
          client.off("error", onError);
          client.release();
        } catch (e) {
          // Destroy the connection: that drops the session lock for sure.
          client.off("error", onError);
          client.release(e as Error);
        }
      },
    };
  }
}

/**
 * Last use per vault = latest `claimed_at` of a job that recorded this vault
 * (claimed_at is set by the relayer when it takes the job, i.e. right before
 * signing), merged with touches of this process (internal transfers).
 */
export class JobsVaultUsage implements VaultUsage {
  private readonly local = new Map<string, number>();

  constructor(
    private readonly pool: Pool,
    private readonly network: SolanaNetwork,
  ) {}

  async lastUsed(vaults: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (vaults.length > 0) {
      const r = await this.pool.query<{ vault: string; ms: string }>(
        `SELECT vault, (extract(epoch FROM max(claimed_at)) * 1000)::bigint AS ms
           FROM relayer_jobs
          WHERE network = $1 AND vault = ANY($2::text[]) AND claimed_at IS NOT NULL
          GROUP BY vault`,
        [this.network, vaults],
      );
      for (const row of r.rows) out.set(row.vault, Number(row.ms));
    }
    for (const v of vaults) {
      const t = this.local.get(v);
      if (t !== undefined && t > (out.get(v) ?? -1)) out.set(v, t);
    }
    return out;
  }

  async touch(vault: string, at: number): Promise<void> {
    this.local.set(vault, Math.max(at, this.local.get(vault) ?? 0));
  }
}

/**
 * Tables proposed to core (migration 0003/0004). The relayer never runs DDL;
 * this string is the exact proposal and is used by tests in a throw-away schema.
 */
export const PROPOSED_RELAYER_STATE_SQL = `
-- Rotation bookkeeping of pool vaults (public data: vaults and their tx times are on chain).
CREATE TABLE relayer_vault_usage (
    network      TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    vault        TEXT NOT NULL,
    last_used_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (network, vault)
);

-- Next unused HD index of per-launch creator addresses, per network (no mapping to users/tokens).
CREATE TABLE relayer_creator_counter (
    network    TEXT PRIMARY KEY CHECK (network IN ('devnet', 'mainnet-beta')),
    next_index INTEGER NOT NULL CHECK (next_index >= 0)
);
`;

export const PROPOSED_RELAYER_STATE_GRANTS = `
GRANT SELECT, INSERT, UPDATE ON relayer_vault_usage TO unzeen_relayer;
GRANT SELECT, INSERT, UPDATE ON relayer_creator_counter TO unzeen_relayer;
`;

/** VaultUsage over the proposed `relayer_vault_usage` table. */
export class PgVaultUsage implements VaultUsage {
  constructor(
    private readonly pool: Pool,
    private readonly network: SolanaNetwork,
  ) {}

  async lastUsed(vaults: readonly string[]): Promise<Map<string, number>> {
    const r = await this.pool.query<{ vault: string; ms: string }>(
      `SELECT vault, (extract(epoch FROM last_used_at) * 1000)::bigint AS ms
         FROM relayer_vault_usage WHERE network = $1 AND vault = ANY($2::text[])`,
      [this.network, vaults],
    );
    return new Map(r.rows.map((row) => [row.vault, Number(row.ms)]));
  }

  async touch(vault: string, at: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO relayer_vault_usage (network, vault, last_used_at)
       VALUES ($1, $2, to_timestamp($3::double precision / 1000))
       ON CONFLICT (network, vault) DO UPDATE
         SET last_used_at = GREATEST(relayer_vault_usage.last_used_at, EXCLUDED.last_used_at)`,
      [this.network, vault, at],
    );
  }
}

/**
 * Creator index counter over the proposed `relayer_creator_counter` table.
 * Atomic across processes and hosts (row lock of the upsert). `floor` is the
 * file counter's value at migration time: the sequence never goes below it,
 * so indexes already used on chain are never handed out again.
 */
export class PgCreatorIndexCounter implements CreatorIndexCounter {
  constructor(
    private readonly pool: Pool,
    private readonly network: SolanaNetwork,
    private readonly floor = 0,
  ) {}

  async next(): Promise<number> {
    const r = await this.pool.query<{ idx: number }>(
      `INSERT INTO relayer_creator_counter AS c (network, next_index) VALUES ($1, $2::int + 1)
       ON CONFLICT (network) DO UPDATE SET next_index = GREATEST(c.next_index, $2::int) + 1
       RETURNING c.next_index - 1 AS idx`,
      [this.network, this.floor],
    );
    const idx = r.rows[0]?.idx;
    if (typeof idx !== "number") throw new Error("creator counter: no row");
    return idx;
  }
}
