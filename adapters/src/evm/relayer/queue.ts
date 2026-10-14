import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getAddress, type Address, type Hex } from "viem";
import type { ApiErrorCode } from "../../errors";
import { LeaseLostError, type Lane } from "../../relayer/types";

/**
 * JobQueue of the Robinhood Chain relayer over core's `relayer_jobs`
 * (docs/RELAYER.md v12: network `hood` / `hood-testnet`, venue `pons`,
 * amounts in wei / ERC-20 base units in the same NUMERIC columns,
 * `signature` = tx hash, `slot` = block number).
 *
 * Same protocol as the Solana queue (src/relayer/postgres-queue.ts): lanes,
 * leases, Verify freeze, `sent` written BEFORE broadcast, confirmed + feed rows
 * in ONE transaction. EVM specifics:
 * - `last_valid_block_height` holds the tx NONCE (PROPOSED to core: an EVM tx has
 *   no blockhash expiry; nonce + account nonce decide whether it can still land);
 * - `vault` = the address that signed the job's main tx.
 * Runs as `unzeen_relayer`; columns always listed; no DDL.
 */

export type HoodNetworkId = "hood" | "hood-testnet";

export type HoodJobSpec =
  | { kind: "buy"; token: Address; weiIn: bigint; minOut: bigint }
  | { kind: "sell"; token: Address; amount: bigint; minWei: bigint }
  | { kind: "create"; meta: { name: string; symbol: string; image?: string }; weiIn: bigint; minOut: bigint }
  | { kind: "withdraw"; token: Address; to: string; amount: bigint; gasWei?: bigint }
  | { kind: "attest"; memo: string; purpose: "verify" | "fair" }
  /** RELAYER v14 §3: spread up to `wei` from the rebalance address over the vaults (ONE tx). */
  | { kind: "fund_vaults"; wei: bigint };

export interface HoodSentAttempt {
  hash: Hex;
  nonce: number;
  vault: Address;
  /** unix ms */
  sentAt: number;
  /** attest `meta.purpose = verify`: operator signature over the root, written with the hash. */
  outSig?: string;
}

export interface HoodClaimedJob {
  id: string;
  spec: HoodJobSpec;
  notBefore: number;
  claims: number;
  sent: HoodSentAttempt | null;
  leaseId: string;
}

export interface HoodMarket {
  priceEth: string;
  marketCapEth: string;
  status: "curve" | "graduated";
}

export type HoodExecution =
  | {
      kind: "buy" | "sell";
      hash: Hex;
      block: bigint;
      blockTime: number | null;
      vault: Address;
      token: Address;
      tokenAmount: bigint;
      /** wei paid / received, venue fees included (`out_lamports`). */
      quoteWei: bigint;
      networkFee: bigint;
      symbol: string | null;
      market: HoodMarket | null;
    }
  | {
      kind: "create";
      hash: Hex;
      block: bigint;
      blockTime: number | null;
      vault: Address;
      token: Address;
      tokenAmount: bigint;
      quoteWei: bigint;
      networkFee: bigint;
      creator: Address;
      name: string;
      symbol: string;
      imageUrl: string | null;
      creatorFee: bigint | null;
      market: HoodMarket | null;
    }
  | { kind: "withdraw"; hash: Hex; block: bigint; vault: Address; token: Address; to: Address; amount: bigint; networkFee: bigint }
  | { kind: "attest"; hash: Hex; block: bigint; blockTime: number | null; vault: Address; memo: string; outSig: string | null; networkFee: bigint }
  | { kind: "fund_vaults"; hash: Hex; block: bigint; vault: Address; wei: bigint; networkFee: bigint };

export type HoodJobResult =
  | { status: "executed"; execution: HoodExecution }
  | { status: "failed"; code: ApiErrorCode; message: string }
  | { status: "retry"; code: ApiErrorCode; message: string; notBefore: number };

export interface HoodQueue {
  claim(o: { workerId: string; leaseMs: number; lane?: Lane }): Promise<HoodClaimedJob | null>;
  reportSent(job: { id: string; leaseId: string }, a: HoodSentAttempt): Promise<void>;
  reportResult(job: { id: string; leaseId: string }, r: HoodJobResult): Promise<void>;
  /** Status of a job (reconcile of pending launches after a restart); null = row gone. */
  status(id: string): Promise<{ status: string; settled: boolean } | null>;
}

interface Row {
  id: string;
  op: string;
  venue: string | null;
  mint: string | null;
  lamports_in: string | null;
  token_amount: string | null;
  min_out: string | null;
  meta: unknown;
  dest: string | null;
  gas_lamports: string | null;
  network: string;
  attempts: number;
  signature: string | null;
  last_valid_block_height: string | null;
  vault: string | null;
  sent_at_ms: string | null;
  not_before_ms: string;
}

const OPS = ["buy", "sell", "create", "transfer", "attest", "fund_vaults"];

export class PgHoodQueue implements HoodQueue {
  private leaseMs = 10 * 60_000;
  constructor(
    private readonly pool: Pool,
    readonly network: HoodNetworkId,
  ) {}

  async claim(o: { workerId: string; leaseMs: number; lane?: Lane }): Promise<HoodClaimedJob | null> {
    this.leaseMs = o.leaseMs;
    const leaseId = `${o.workerId}:${randomBytes(6).toString("hex")}`;
    let laneSql = "";
    if (o.lane === "attest") laneSql = `AND op = 'attest'`;
    else if (o.lane === "now") laneSql = `AND exec_mode IS NOT DISTINCT FROM 'now' AND op <> 'attest'`;
    else if (o.lane === "batch") laneSql = `AND exec_mode IS DISTINCT FROM 'now' AND op <> 'attest'`;
    const tieBreak = o.lane === "batch" || o.lane === undefined ? "random()" : "id";
    const priority = o.lane === "attest" ? `(meta->>'purpose' IS NOT DISTINCT FROM 'verify'), ` : o.lane === undefined ? `(op <> 'attest'), ` : "";
    const res = await this.pool.query<Row>(
      `WITH c AS (
         SELECT id FROM relayer_jobs
          WHERE network = $2 AND settled_at IS NULL AND op = ANY($4::text[])
            AND ((status = 'queued' AND not_before <= now()
                  AND (op = 'attest' OR NOT EXISTS (SELECT 1 FROM verify_snapshots v
                        WHERE v.network = $2 AND v.status IN ('freezing', 'collecting') AND v.freeze_until > now())))
              OR (status IN ('claimed', 'sent') AND lease_until < now()))
            ${laneSql}
          ORDER BY ${priority}(status = 'queued'), not_before, ${tieBreak}
          LIMIT 1
          FOR UPDATE SKIP LOCKED)
       UPDATE relayer_jobs j
          SET status = CASE WHEN j.status = 'queued' THEN 'claimed' ELSE j.status END,
              claimed_by = $1, claimed_at = now(), lease_until = now() + $3 * interval '1 millisecond',
              attempts = j.attempts + 1, updated_at = now()
         FROM c WHERE j.id = c.id
       RETURNING j.id, j.op, j.venue, j.mint, j.lamports_in, j.token_amount, j.min_out, j.meta, j.dest, j.gas_lamports,
                 j.network, j.attempts, j.signature, j.last_valid_block_height, j.vault,
                 (extract(epoch FROM j.updated_at) * 1000)::bigint AS sent_at_ms,
                 (extract(epoch FROM j.not_before) * 1000)::bigint AS not_before_ms`,
      [leaseId, this.network, o.leaseMs, OPS],
    );
    const row = res.rows[0];
    if (!row) return null;
    const sent: HoodSentAttempt | null =
      row.signature && row.last_valid_block_height !== null && row.vault
        ? { hash: row.signature as Hex, nonce: Number(row.last_valid_block_height), vault: getAddress(row.vault), sentAt: Number(row.sent_at_ms) }
        : null;
    let spec: HoodJobSpec;
    try {
      spec = rowToHoodSpec(row, this.network);
    } catch (e) {
      // A row whose tx may be on chain is never failed blindly (the engine resolves `sent` first).
      if (sent) {
        await this.pool.query(`UPDATE relayer_jobs SET lease_until = now() + interval '60 seconds' WHERE id = $1 AND claimed_by = $2`, [row.id, leaseId]);
        return null;
      }
      await this.reportResult({ id: row.id, leaseId }, { status: "failed", code: "bad_request", message: e instanceof Error ? e.message : "bad job" }).catch(() => undefined);
      return null;
    }
    return { id: row.id, spec, notBefore: Number(row.not_before_ms), claims: row.attempts, sent, leaseId };
  }

  async reportSent(job: { id: string; leaseId: string }, a: HoodSentAttempt): Promise<void> {
    const params: unknown[] = [job.id, a.hash, a.nonce, a.vault, job.leaseId, this.leaseMs];
    let extra = "";
    if (a.outSig !== undefined) {
      params.push(a.outSig);
      extra = `, out_sig = $${params.length}`;
    }
    const res = await this.pool.query(
      `UPDATE relayer_jobs
          SET status = 'sent', signature = $2, last_valid_block_height = $3, vault = $4,
              lease_until = now() + $6 * interval '1 millisecond', updated_at = now()${extra}
        WHERE id = $1 AND status IN ('claimed', 'sent') AND claimed_by = $5 AND settled_at IS NULL`,
      params,
    );
    if (res.rowCount !== 1) throw new LeaseLostError(job.id);
  }

  async status(id: string): Promise<{ status: string; settled: boolean } | null> {
    const r = await this.pool.query<{ status: string; settled: boolean }>(`SELECT status, settled_at IS NOT NULL AS settled FROM relayer_jobs WHERE id = $1`, [id]);
    return r.rows[0] ?? null;
  }

  async reportResult(job: { id: string; leaseId: string }, r: HoodJobResult): Promise<void> {
    if (r.status === "failed") {
      const res = await this.pool.query(
        `UPDATE relayer_jobs SET status = 'failed', error_code = $2, error_message = $3, updated_at = now()
          WHERE id = $1 AND status IN ('claimed', 'sent') AND claimed_by = $4 AND settled_at IS NULL`,
        [job.id, r.code, sanitize(r.message), job.leaseId],
      );
      if (res.rowCount !== 1) throw new LeaseLostError(job.id);
      return;
    }
    if (r.status === "retry") {
      const res = await this.pool.query(
        `UPDATE relayer_jobs SET lease_until = to_timestamp($2::double precision / 1000), updated_at = now()
          WHERE id = $1 AND status IN ('claimed', 'sent') AND claimed_by = $3 AND settled_at IS NULL`,
        [job.id, r.notBefore, job.leaseId],
      );
      if (res.rowCount !== 1) throw new LeaseLostError(job.id);
      return;
    }
    const e = r.execution;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let res;
      if (e.kind === "fund_vaults") {
        // Pool-internal: out_lamports = wei that reached the vaults; no feed rows.
        res = await client.query(
          `UPDATE relayer_jobs SET status = 'confirmed', slot = $2, out_lamports = $3::numeric, network_fee = $4, updated_at = now()
            WHERE id = $1 AND status = 'sent' AND signature = $5 AND claimed_by = $6 AND settled_at IS NULL`,
          [job.id, e.block.toString(), e.wei.toString(), e.networkFee.toString(), e.hash, job.leaseId],
        );
      } else if (e.kind === "attest") {
        res = await client.query(
          `UPDATE relayer_jobs SET status = 'confirmed', slot = $2, out_memo = $3, network_fee = $4, out_block_time = $5,
                  vault = $6, out_sig = COALESCE($7, out_sig), updated_at = now()
            WHERE id = $1 AND status = 'sent' AND signature = $8 AND claimed_by = $9 AND settled_at IS NULL`,
          [job.id, e.block.toString(), e.memo, e.networkFee.toString(), e.blockTime, e.vault, e.outSig, e.hash, job.leaseId],
        );
      } else {
        const outTokens = e.kind === "withdraw" ? e.amount : e.tokenAmount;
        const outWei = e.kind === "withdraw" ? 0n : e.quoteWei;
        const fee = e.kind === "create" && e.creatorFee !== null ? e.creatorFee.toString() : null;
        res = await client.query(
          `UPDATE relayer_jobs
              SET status = 'confirmed', slot = $2, out_mint = $3, out_token_amount = $4::numeric, out_lamports = $5::numeric,
                  network_fee = $6, out_creator_fee = COALESCE($9::numeric, out_creator_fee), updated_at = now()
            WHERE id = $1 AND status = 'sent' AND signature = $7 AND claimed_by = $8 AND settled_at IS NULL`,
          [job.id, e.block.toString(), e.token, outTokens.toString(), outWei.toString(), e.networkFee.toString(), e.hash, job.leaseId, fee],
        );
      }
      if (res.rowCount !== 1) throw new LeaseLostError(job.id);
      if (e.kind === "create") await this.writeCreate(client, e);
      else if (e.kind === "buy" || e.kind === "sell") await this.writeTrade(client, e);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Token row + mint pin (one vault per mint) + 'create' (+ first 'buy') feed rows. Public data only. */
  private async writeCreate(c: PoolClient, e: Extract<HoodExecution, { kind: "create" }>): Promise<void> {
    await c.query(
      `INSERT INTO tokens (mint, venue, symbol, name, image, decimals, status, price_sol, market_cap_sol)
       VALUES ($1, 'pons', $2, $3, $4, 18, $5, $6::numeric, $7::numeric) ON CONFLICT (mint) DO NOTHING`,
      [e.token, e.symbol, e.name, e.imageUrl, e.market?.status ?? "curve", e.market?.priceEth ?? "0", e.market?.marketCapEth ?? "0"],
    );
    await c.query(
      `INSERT INTO mint_vaults (network, mint, vault) VALUES ($1, $2, $3) ON CONFLICT (network, mint) DO NOTHING`,
      [this.network, e.token, e.vault],
    );
    const ins = (kind: "create" | "buy", tokens: bigint, wei: bigint) =>
      c.query(
        `INSERT INTO trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, slot, ts)
         VALUES ($1, 'pons', $2, $3, $4::numeric, $5::numeric, 18, $6, $7, COALESCE(to_timestamp($8::double precision), now()))
         ON CONFLICT (signature, kind, mint) DO NOTHING`,
        [kind, e.token, e.symbol, tokens.toString(), wei.toString(), e.hash, e.block.toString(), e.blockTime],
      );
    await ins("create", 0n, 0n);
    if (e.tokenAmount > 0n) await ins("buy", e.tokenAmount, e.quoteWei);
  }

  private async writeTrade(c: PoolClient, e: Extract<HoodExecution, { kind: "buy" | "sell" }>): Promise<void> {
    if (e.market) {
      await c.query(
        `UPDATE tokens SET price_sol = $2::numeric, market_cap_sol = $3::numeric, status = $4, updated_at = now() WHERE mint = $1`,
        [e.token, e.market.priceEth, e.market.marketCapEth, e.market.status],
      );
    }
    await c.query(
      `INSERT INTO trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, slot, ts)
       VALUES ($1, 'pons', $2, COALESCE((SELECT symbol FROM tokens WHERE mint = $2), $3), $4::numeric, $5::numeric, 18, $6, $7,
               COALESCE(to_timestamp($8::double precision), now()))
       ON CONFLICT (signature, kind, mint) DO NOTHING`,
      [e.kind, e.token, e.symbol ?? "", e.tokenAmount.toString(), e.quoteWei.toString(), e.hash, e.block.toString(), e.blockTime],
    );
  }
}

/** relayer_jobs row -> hood spec. Throws on rows this relayer must not execute. */
export function rowToHoodSpec(row: Pick<Row, "id" | "op" | "venue" | "mint" | "lamports_in" | "token_amount" | "min_out" | "meta" | "dest" | "gas_lamports" | "network">, network: HoodNetworkId): HoodJobSpec {
  if (row.network !== network) throw new Error(`job for ${row.network}, relayer is ${network}`);
  const big = (v: string | null, name: string): bigint => {
    if (v === null || !/^\d+$/.test(v)) throw new Error(`job ${row.id}: ${name} missing`);
    return BigInt(v);
  };
  const token = (): Address => {
    if (!row.mint || !/^0x[0-9a-fA-F]{40}$/.test(row.mint)) throw new Error(`job ${row.id}: mint must be an EVM address`);
    return getAddress(row.mint);
  };
  const pons = () => {
    if (row.venue !== "pons") throw new Error(`job ${row.id}: venue must be pons`);
  };
  switch (row.op) {
    case "buy":
      pons();
      return { kind: "buy", token: token(), weiIn: big(row.lamports_in, "lamports_in"), minOut: big(row.min_out, "min_out") };
    case "sell":
      pons();
      return { kind: "sell", token: token(), amount: big(row.token_amount, "token_amount"), minWei: big(row.min_out, "min_out") };
    case "create": {
      pons();
      const m = row.meta as { name?: unknown; symbol?: unknown; image?: unknown; quote?: unknown } | null;
      if (!m || typeof m.name !== "string" || typeof m.symbol !== "string") throw new Error(`job ${row.id}: meta.name / meta.symbol missing`);
      if (m.quote !== undefined && m.quote !== null && m.quote !== "ETH") throw new Error(`job ${row.id}: pons launches are ETH-paired`);
      if (m.image !== undefined && m.image !== null && typeof m.image !== "string") throw new Error(`job ${row.id}: bad meta.image`);
      return {
        kind: "create",
        meta: { name: m.name, symbol: m.symbol, ...(typeof m.image === "string" ? { image: m.image } : {}) },
        weiIn: row.lamports_in === null ? 0n : big(row.lamports_in, "lamports_in"),
        minOut: row.min_out === null ? 0n : big(row.min_out, "min_out"),
      };
    }
    case "transfer": {
      if (!row.dest) throw new Error(`job ${row.id}: dest missing`);
      const gas = row.gas_lamports === null ? undefined : big(row.gas_lamports, "gas_lamports");
      return { kind: "withdraw", token: token(), to: row.dest, amount: big(row.token_amount, "token_amount"), ...(gas !== undefined && gas > 0n ? { gasWei: gas } : {}) };
    }
    case "attest": {
      const m = row.meta as { memo?: unknown; purpose?: unknown } | null;
      if (!m || typeof m.memo !== "string" || !/^[0-9a-f]{64}$/.test(m.memo)) throw new Error(`job ${row.id}: meta.memo must be 64 hex`);
      return { kind: "attest", memo: m.memo, purpose: m.purpose === "verify" ? "verify" : "fair" };
    }
    case "fund_vaults": {
      const wei = big(row.lamports_in, "lamports_in");
      if (wei <= 0n) throw new Error(`job ${row.id}: lamports_in must be > 0`);
      return { kind: "fund_vaults", wei };
    }
    default:
      throw new Error(`job ${row.id}: op ${row.op} not supported by the hood relayer`);
  }
}

function sanitize(m: string): string {
  return m.replace(/0x[0-9a-fA-F]{40,64}/g, "<hex>").slice(0, 200);
}
