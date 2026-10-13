import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { Pool } from "pg";
import { extractTradeEvents } from "../events";
import { getTransactionAnyVersion } from "../tx";
import type { CreateSeen } from "./discovery";
import { firstBlockFacts, type LaunchIndex } from "./full";

/**
 * Dev history (INTEL_FULL=1): launches of an address seen by OUR OWN index of creates
 * (token-intel.md T7: DAS knows nothing about pump.fun creators). The index is fed by the public
 * create streams Discovery already runs (pump.fun CreateEvent.user from logs, DBC / LaunchLab
 * `creator` from Parsed Streams) — every create drained, not only admitted candidates.
 * "since" = the oldest create of that address WE saw (not the address's real first launch).
 *
 * Rug heuristic (lead 13.10): the dev SOLD >= 50 % of what it BOUGHT of its own token within 60 min
 * of the create. Checked lazily, only for devs of warm tokens, through the read provider: the
 * signatures of the dev's token accounts of that mint (both token programs) in the window, then
 * those transactions (bounded). Once a launch is older than 60 min the answer never changes: cached.
 * Public chain data only; nothing here depends on who asked.
 */

export interface CreateRecord {
  mint: string;
  venue: "pumpfun" | "meteora-dbc" | "raydium-launchlab";
  creator: string;
  slot: number;
  /** unix ms; null = unknown (then the record time). */
  createdAt: number;
  signature: string;
}

export interface LaunchRow extends CreateRecord {
  /** null = not evaluated yet. */
  rug: boolean | null;
}

export interface CreateIndexStore {
  record(rows: readonly CreateRecord[]): Promise<void>;
  /** Newest first. */
  byCreator(creator: string, limit: number): Promise<LaunchRow[]>;
  count(creator: string): Promise<{ launches: number; rugs: number; since: number } | null>;
  setRug(mint: string, rug: boolean): Promise<void>;
}

export class MemoryCreateIndex implements CreateIndexStore {
  readonly rows = new Map<string, LaunchRow>();
  async record(rows: readonly CreateRecord[]): Promise<void> {
    for (const r of rows) if (!this.rows.has(r.mint)) this.rows.set(r.mint, { ...r, rug: null });
  }
  async byCreator(creator: string, limit: number): Promise<LaunchRow[]> {
    return [...this.rows.values()].filter((r) => r.creator === creator).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
  async count(creator: string): Promise<{ launches: number; rugs: number; since: number } | null> {
    const rs = [...this.rows.values()].filter((r) => r.creator === creator);
    if (rs.length === 0) return null;
    return { launches: rs.length, rugs: rs.filter((r) => r.rug === true).length, since: Math.min(...rs.map((r) => r.createdAt)) };
  }
  async setRug(mint: string, rug: boolean): Promise<void> {
    const r = this.rows.get(mint);
    if (r) r.rug = rug;
  }
}

/**
 * Proposed core table (the indexer never runs DDL):
 *   CREATE TABLE intel_creates (network, mint, venue, creator, slot, created_at, signature, rug, rug_checked_at,
 *                               PRIMARY KEY (network, mint));  index (network, creator, created_at DESC)
 */
export class PgCreateIndex implements CreateIndexStore {
  constructor(
    private readonly db: Pool,
    private readonly network: "devnet" | "mainnet-beta",
  ) {}

  async available(): Promise<boolean> {
    const r = await this.db
      .query<{ ok: boolean }>(`SELECT to_regclass('intel_creates') IS NOT NULL AND has_table_privilege(current_user, 'intel_creates', 'INSERT,UPDATE,SELECT') AS ok`)
      .catch(() => null);
    return r?.rows[0]?.ok === true;
  }

  async record(rows: readonly CreateRecord[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.query(
      `INSERT INTO intel_creates (network, mint, venue, creator, slot, created_at, signature)
       SELECT $1, m, v, c, s, to_timestamp(t / 1000.0), g
         FROM unnest($2::text[], $3::text[], $4::text[], $5::bigint[], $6::bigint[], $7::text[]) AS x(m, v, c, s, t, g)
       ON CONFLICT (network, mint) DO NOTHING`,
      [this.network, rows.map((r) => r.mint), rows.map((r) => r.venue), rows.map((r) => r.creator), rows.map((r) => r.slot), rows.map((r) => r.createdAt), rows.map((r) => r.signature)],
    );
  }

  async byCreator(creator: string, limit: number): Promise<LaunchRow[]> {
    const r = await this.db.query<{ mint: string; venue: CreateRecord["venue"]; slot: string; ts: string; signature: string; rug: boolean | null }>(
      `SELECT mint, venue, slot::text, (extract(epoch FROM created_at) * 1000)::bigint::text AS ts, signature, rug
         FROM intel_creates WHERE network = $1 AND creator = $2 ORDER BY created_at DESC LIMIT $3`,
      [this.network, creator, limit],
    );
    return r.rows.map((x) => ({ mint: x.mint, venue: x.venue, creator, slot: Number(x.slot), createdAt: Number(x.ts), signature: x.signature, rug: x.rug }));
  }

  async count(creator: string): Promise<{ launches: number; rugs: number; since: number } | null> {
    const r = await this.db.query<{ n: number; rugs: number; since: string | null }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE rug)::int AS rugs, (extract(epoch FROM min(created_at)) * 1000)::bigint::text AS since
         FROM intel_creates WHERE network = $1 AND creator = $2`,
      [this.network, creator],
    );
    const x = r.rows[0];
    return x && x.n > 0 && x.since ? { launches: x.n, rugs: x.rugs, since: Number(x.since) } : null;
  }

  async setRug(mint: string, rug: boolean): Promise<void> {
    await this.db.query(`UPDATE intel_creates SET rug = $3, rug_checked_at = now() WHERE network = $1 AND mint = $2 AND rug IS NULL`, [this.network, mint, rug]);
  }
}

/** Creates drained from the streams -> index rows (those with a known creator and mint). */
export function createRecords(creates: readonly CreateSeen[], now: number): CreateRecord[] {
  const out: CreateRecord[] = [];
  for (const c of creates) {
    if (!c.mint || !c.creator) continue;
    out.push({ mint: c.mint, venue: c.venue, creator: c.creator, slot: c.slot, createdAt: c.createdAt ?? now, signature: c.signature });
  }
  return out;
}

export const RUG_WINDOW_MS = 60 * 60_000;

/** "Sold >= 50 % of what it bought within 60 min" from the dev's trades of its token. */
export function isRug(bought: bigint, sold: bigint): boolean {
  return bought > 0n && sold * 2n >= bought;
}

/** The dev's own buys / sells of `mint` in one tx (pump TradeEvent.user; DBC / LaunchLab: the dev paid the tx). */
export function devFlows(tx: Parameters<typeof firstBlockFacts>[0], mint: PublicKey, dev: string): { bought: bigint; sold: bigint } {
  let bought = 0n;
  let sold = 0n;
  const pumpTrades = extractTradeEvents(tx, PUMP_PROGRAM_ID).filter((t) => t.mint.equals(mint));
  if (pumpTrades.length > 0) {
    for (const t of pumpTrades) {
      if (t.user.toBase58() !== dev) continue;
      const a = BigInt(t.tokenAmount.toString(10));
      if (t.isBuy) bought += a;
      else sold += a;
    }
    return { bought, sold };
  }
  for (const t of firstBlockFacts(tx, mint).trades) {
    if (t.user !== dev) continue;
    if (t.isBuy) bought += t.tokenAmount;
    else sold += t.tokenAmount;
  }
  return { bought, sold };
}

export class RpcRugChecker {
  constructor(
    private readonly read: Pick<Connection, "getSignaturesForAddress" | "getTransaction">,
    private readonly maxTx = 15,
  ) {}

  /** null = cannot tell yet (too young, too many tx for the budget, or unreadable). */
  async rugged(r: Pick<LaunchRow, "mint" | "creator" | "createdAt">, now: number): Promise<boolean | null> {
    if (now - r.createdAt < RUG_WINDOW_MS) return null;
    const mint = new PublicKey(r.mint);
    const dev = new PublicKey(r.creator);
    const end = (r.createdAt + RUG_WINDOW_MS) / 1000;
    const sigs = new Map<string, number>();
    for (const prog of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const ata = getAssociatedTokenAddressSync(mint, dev, true, prog);
      const list = await this.read.getSignaturesForAddress(ata, { limit: 1000 });
      for (const s of list) if (s.err === null && s.blockTime !== null && s.blockTime !== undefined && s.blockTime <= end) sigs.set(s.signature, s.blockTime);
    }
    if (sigs.size === 0) return false; // the dev never held its token in the window
    if (sigs.size > this.maxTx) return null; // too active for the budget: no claim
    let bought = 0n;
    let sold = 0n;
    for (const sig of sigs.keys()) {
      const tx = await getTransactionAnyVersion(this.read, sig).catch(() => null);
      if (!tx) return null;
      if (tx.meta?.err) continue;
      const f = devFlows(tx, mint, r.creator);
      bought += f.bought;
      sold += f.sold;
    }
    return isRug(bought, sold);
  }
}

/** LaunchIndex over the create index + lazy, bounded rug checks (≤ `maxChecks` per dev lookup). */
export class DevIndex implements LaunchIndex {
  constructor(
    private readonly store: CreateIndexStore,
    private readonly rugs: Pick<RpcRugChecker, "rugged"> | null,
    private readonly o: { maxChecks?: number; now?: () => number } = {},
  ) {}

  async record(creates: readonly CreateSeen[]): Promise<void> {
    await this.store.record(createRecords(creates, (this.o.now ?? Date.now)()));
  }

  async launchesBy(dev: string): Promise<{ launches: number; rugs: number; since: number } | null> {
    const now = (this.o.now ?? Date.now)();
    if (this.rugs) {
      let budget = this.o.maxChecks ?? 3;
      for (const r of await this.store.byCreator(dev, 20)) {
        if (budget <= 0) break;
        if (r.rug !== null || now - r.createdAt < RUG_WINDOW_MS) continue;
        budget--;
        const v = await this.rugs.rugged(r, now).catch(() => null);
        if (v !== null) await this.store.setRug(r.mint, v);
      }
    }
    return this.store.count(dev);
  }
}
