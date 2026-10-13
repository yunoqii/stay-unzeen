import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

/**
 * Pending Pons launches of the hood relayer: job id -> creator HD index + the
 * block before any of its txs. Written BEFORE the funder tops up the creator,
 * so after a crash the same creator is reused (never a second launch) and an
 * abandoned one is reconciled (`reconcileCreator`: launched / refund to funder).
 *
 * The entry links a relayer job id to a creator address only while the launch
 * is in flight; it is deleted when the job settles (mint -> creator is public
 * on chain anyway). No user data.
 *
 * Storage: a 0600 JSON file next to the EVM keys (atomic rename). The Postgres
 * variant is PROPOSED to core (`relayer_launches`, below) for multi-host relayers.
 */
export interface PendingLaunch {
  creatorIndex: number;
  /** Head block when the creator was allocated (reconcile scans from here). */
  fromBlock: bigint;
}

export interface LaunchStore {
  get(jobId: string): Promise<PendingLaunch | null>;
  put(jobId: string, l: PendingLaunch): Promise<void>;
  delete(jobId: string): Promise<void>;
  all(): Promise<Map<string, PendingLaunch>>;
}

export class MemoryLaunchStore implements LaunchStore {
  private readonly m = new Map<string, PendingLaunch>();
  async get(id: string) {
    return this.m.get(id) ?? null;
  }
  async put(id: string, l: PendingLaunch) {
    this.m.set(id, l);
  }
  async delete(id: string) {
    this.m.delete(id);
  }
  async all() {
    return new Map(this.m);
  }
}

export class FileLaunchStore implements LaunchStore {
  constructor(readonly file: string) {}

  static inDir(keysDir: string): FileLaunchStore {
    return new FileLaunchStore(path.join(keysDir, "pending-launches.json"));
  }

  private read(): Record<string, { creatorIndex: number; fromBlock: string }> {
    if (!fs.existsSync(this.file)) return {};
    return JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, { creatorIndex: number; fromBlock: string }>;
  }

  private write(v: Record<string, { creatorIndex: number; fromBlock: string }>): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(v));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  async get(id: string): Promise<PendingLaunch | null> {
    const e = this.read()[id];
    return e ? { creatorIndex: e.creatorIndex, fromBlock: BigInt(e.fromBlock) } : null;
  }

  async put(id: string, l: PendingLaunch): Promise<void> {
    const v = this.read();
    v[id] = { creatorIndex: l.creatorIndex, fromBlock: l.fromBlock.toString() };
    this.write(v);
  }

  async delete(id: string): Promise<void> {
    const v = this.read();
    if (!(id in v)) return;
    delete v[id];
    this.write(v);
  }

  async all(): Promise<Map<string, PendingLaunch>> {
    return new Map(Object.entries(this.read()).map(([k, e]) => [k, { creatorIndex: e.creatorIndex, fromBlock: BigInt(e.fromBlock) }]));
  }
}

/** PROPOSED to core (multi-host hood relayers): same data in Postgres. Not created by the relayer. */
export const PROPOSED_RELAYER_LAUNCHES_SQL = `
CREATE TABLE relayer_launches (
    job_id        BIGINT PRIMARY KEY REFERENCES relayer_jobs(id) ON DELETE CASCADE,
    network       TEXT NOT NULL CHECK (network IN ('hood', 'hood-testnet')),
    creator_index INTEGER NOT NULL CHECK (creator_index >= 0),
    from_block    BIGINT NOT NULL CHECK (from_block >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON relayer_launches TO unzeen_relayer;
`;

export class PgLaunchStore implements LaunchStore {
  constructor(
    private readonly pool: Pool,
    private readonly network: string,
  ) {}
  async get(id: string) {
    const r = await this.pool.query<{ i: number; b: string }>(`SELECT creator_index AS i, from_block::text AS b FROM relayer_launches WHERE job_id = $1`, [id]);
    const x = r.rows[0];
    return x ? { creatorIndex: x.i, fromBlock: BigInt(x.b) } : null;
  }
  async put(id: string, l: PendingLaunch) {
    await this.pool.query(
      `INSERT INTO relayer_launches (job_id, network, creator_index, from_block) VALUES ($1, $2, $3, $4)
       ON CONFLICT (job_id) DO NOTHING`,
      [id, this.network, l.creatorIndex, l.fromBlock.toString()],
    );
  }
  async delete(id: string) {
    await this.pool.query(`DELETE FROM relayer_launches WHERE job_id = $1`, [id]);
  }
  async all() {
    const r = await this.pool.query<{ id: string; i: number; b: string }>(
      `SELECT job_id::text AS id, creator_index AS i, from_block::text AS b FROM relayer_launches WHERE network = $1`,
      [this.network],
    );
    return new Map(r.rows.map((x) => [x.id, { creatorIndex: x.i, fromBlock: BigInt(x.b) }]));
  }
}
