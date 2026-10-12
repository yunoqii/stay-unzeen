import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import type { SolanaNetwork } from "./postgres-queue";

/**
 * D4 (owner's decision, day 4): the pool's position in a mint lives on ONE
 * vault (shared inventory of all users of that token). The first buy/create
 * of a mint picks a vault (random among the least loaded) and pins it; every
 * later buy / sell / withdraw of that mint goes through it. Then a sell of
 * everything is one tx and a withdrawal never misses tokens on another shard.
 *
 * Pins are public information (the vault's holdings are on chain) and carry
 * nothing about users.
 */
export interface MintVaults {
  /** Pinned vault of `mint`, or null. */
  get(mint: string): Promise<string | null>;
  /**
   * Pins `mint` to `vault` unless it is pinned already; returns the vault
   * that holds the pin (the existing one wins a race). Atomic.
   */
  assign(mint: string, vault: string): Promise<string>;
  /** Number of pinned mints per vault (choice for a new mint). */
  load(): Promise<Map<string, number>>;
  /** Moves a pin (consolidation tooling only; tokens must be moved first). */
  reassign(mint: string, vault: string): Promise<void>;
}

export class MemoryMintVaults implements MintVaults {
  private readonly m = new Map<string, string>();
  async get(mint: string): Promise<string | null> {
    return this.m.get(mint) ?? null;
  }
  async assign(mint: string, vault: string): Promise<string> {
    const cur = this.m.get(mint);
    if (cur) return cur;
    this.m.set(mint, vault);
    return vault;
  }
  async load(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const v of this.m.values()) out.set(v, (out.get(v) ?? 0) + 1);
    return out;
  }
  async reassign(mint: string, vault: string): Promise<void> {
    this.m.set(mint, vault);
  }
}

/**
 * JSON file (`mint-vaults.json`, 0600) with an exclusive lock file: atomic
 * between relayer processes of one host. Several hosts: Postgres table.
 */
export class FileMintVaults implements MintVaults {
  constructor(
    private readonly file: string,
    private readonly lockTimeoutMs = 10_000,
  ) {}

  async get(mint: string): Promise<string | null> {
    return this.read()[mint] ?? null;
  }

  async assign(mint: string, vault: string): Promise<string> {
    return this.locked(() => {
      const m = this.read();
      const cur = m[mint];
      if (cur) return cur;
      m[mint] = vault;
      this.write(m);
      return vault;
    });
  }

  async load(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const v of Object.values(this.read())) out.set(v, (out.get(v) ?? 0) + 1);
    return out;
  }

  async reassign(mint: string, vault: string): Promise<void> {
    await this.locked(() => {
      const m = this.read();
      m[mint] = vault;
      this.write(m);
    });
  }

  private read(): Record<string, string> {
    if (!fs.existsSync(this.file)) return {};
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  }

  private write(m: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private async locked<T>(f: () => T): Promise<T> {
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        fd = fs.openSync(lock, "wx", 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
        if (age > this.lockTimeoutMs) fs.rmSync(lock, { force: true });
        else if (Date.now() > deadline) throw new Error("mint-vaults file is locked by another process");
        else await new Promise((r) => setTimeout(r, 20));
      }
    }
    try {
      return f();
    } finally {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    }
  }
}

/**
 * Schema of core's `mint_vaults` (core/migrations/0003_payouts_epochs.sql),
 * copied for tests in a throw-away schema. The relayer runs no DDL.
 */
export const MINT_VAULTS_TEST_SQL = `
CREATE TABLE mint_vaults (
    network    TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    mint       TEXT NOT NULL,
    vault      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('day', now(), 'UTC'),
    PRIMARY KEY (network, mint)
);
CREATE INDEX mint_vaults_vault_idx ON mint_vaults (network, vault);
`;

/** Grant the relayer role needs (not yet in infra/relayer-role.sql). */
export const MINT_VAULTS_GRANTS = `
GRANT SELECT, INSERT, UPDATE (vault) ON mint_vaults TO unzeen_relayer;
`;

/** MintVaults over core's `mint_vaults` table (0003). */
export class PgMintVaults implements MintVaults {
  constructor(
    private readonly pool: Pool,
    private readonly network: SolanaNetwork,
  ) {}

  async get(mint: string): Promise<string | null> {
    const r = await this.pool.query<{ vault: string }>(
      `SELECT vault FROM mint_vaults WHERE network = $1 AND mint = $2`,
      [this.network, mint],
    );
    return r.rows[0]?.vault ?? null;
  }

  async assign(mint: string, vault: string): Promise<string> {
    // A concurrent insert committed after this statement's snapshot yields no
    // row (conflict, but invisible): just ask again.
    for (let i = 0; i < 3; i++) {
      const v = await this.tryAssign(mint, vault);
      if (v) return v;
    }
    throw new Error("mint vault pin: no row");
  }

  private async tryAssign(mint: string, vault: string): Promise<string | null> {
    // ON CONFLICT DO NOTHING + read back: the first writer wins.
    const r = await this.pool.query<{ vault: string }>(
      `WITH ins AS (
         INSERT INTO mint_vaults (network, mint, vault) VALUES ($1, $2, $3)
         ON CONFLICT (network, mint) DO NOTHING RETURNING vault)
       SELECT vault FROM ins
       UNION ALL
       SELECT vault FROM mint_vaults WHERE network = $1 AND mint = $2
       LIMIT 1`,
      [this.network, mint, vault],
    );
    return r.rows[0]?.vault ?? null;
  }

  async load(): Promise<Map<string, number>> {
    const r = await this.pool.query<{ vault: string; n: string }>(
      `SELECT vault, count(*) AS n FROM mint_vaults WHERE network = $1 GROUP BY vault`,
      [this.network],
    );
    return new Map(r.rows.map((x) => [x.vault, Number(x.n)]));
  }

  async reassign(mint: string, vault: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO mint_vaults (network, mint, vault) VALUES ($1, $2, $3)
       ON CONFLICT (network, mint) DO UPDATE SET vault = EXCLUDED.vault`,
      [this.network, mint, vault],
    );
  }
}
