import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ApiErrorCode } from "../errors";
import type { VenueId } from "../types";
import { LeaseLostError, type ClaimedJob, type CreateExecution, type JobQueue, type JobResult, type JobSpec, type Lane, type SentAttempt } from "./types";

/**
 * JobQueue over `relayer_jobs` (core/migrations/0002_relayer.sql), protocol of
 * docs/RELAYER.md v1. Runs as the least-privilege role `unzeen_relayer`:
 * columns are always listed (action_id is not readable), no INSERT/DELETE on
 * jobs, no schema changes.
 *
 * Mapping to the generic queue:
 * - claim: in-flight rows whose lease ran out (`claimed`/`sent`) are taken
 *   first (restart recovery), then `queued` rows with `not_before <= now()`.
 *   Only ops this relayer executes (buy/sell/create/transfer) and only its network.
 * - lanes (R-relayer-1, 0005 exec_mode): the "now" lane takes only
 *   exec_mode = 'now' rows (FIFO), the "batch" lane everything else. Inside an
 *   epoch (same not_before) the batch order is random (`random()`, N-4), so
 *   the on-chain order does not follow the order of the requests. Without the
 *   column (DB before 0005) everything is batch and the now lane is empty.
 *   exec_mode is used only in WHERE: it is not returned, logged or passed on.
 * - lease token: `claimed_by` = "<worker>:<random>" per claim.
 * - a `transfer` row is the generic `withdraw` spec.
 * - retry: the relayer may not touch `not_before`, so the backoff is the lease:
 *   the row stays `claimed`/`sent` with `lease_until = notBefore` and is
 *   recovered by the next claim after that time (RELAYER.md §4).
 * - executed: `confirmed` + public feed rows (`trades`, `tokens`) in ONE transaction.
 */
export type SolanaNetwork = "devnet" | "mainnet-beta";

export interface PostgresJobQueueOptions {
  pool: Pool;
  network: SolanaNetwork;
  /**
   * Chain access for D7: a malformed in-flight row (signature recorded) is
   * only failed once its transaction provably expired without landing.
   */
  probe?: { state(signature: string, lastValidBlockHeight: number): Promise<{ state: string }> };
}

const OPS = ["buy", "sell", "create", "transfer"] as const;

/** Row of relayer_jobs as returned by `claim` (pg returns BIGINT as string). */
export interface JobRow {
  id: string;
  part: number;
  op: string;
  venue: string | null;
  mint: string | null;
  lamports_in: string | null;
  token_amount: string | null;
  min_out: string | null;
  meta?: unknown;
  dest: string | null;
  gas_lamports: string | null;
  network: string;
  attempts: number;
  status: string;
  signature: string | null;
  last_valid_block_height: string | null;
  vault: string | null;
  sent_at_ms: string | null;
  not_before_ms: string;
}

export class PostgresJobQueue implements JobQueue {
  private readonly pool: Pool;
  private readonly network: SolanaNetwork;
  private readonly probe: PostgresJobQueueOptions["probe"];
  private leaseMs = 10 * 60_000;
  private execModeColumn: Promise<boolean> | null = null;

  constructor(o: PostgresJobQueueOptions) {
    this.pool = o.pool;
    this.network = o.network;
    this.probe = o.probe;
  }

  /** Whether relayer_jobs has exec_mode (core 0005) in the current search_path. Cached. */
  private hasExecMode(): Promise<boolean> {
    if (!this.execModeColumn) {
      this.execModeColumn = this.pool
        .query<{ ok: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_schema = current_schema() AND table_name = 'relayer_jobs'
                             AND column_name = 'exec_mode') AS ok`,
        )
        .then((r) => r.rows[0]?.ok === true)
        .catch((e) => {
          this.execModeColumn = null; // retry on the next claim
          throw e;
        });
    }
    return this.execModeColumn;
  }

  async claim(opts: { workerId: string; now: number; leaseMs: number; lane?: Lane }): Promise<ClaimedJob | null> {
    this.leaseMs = opts.leaseMs;
    const leaseId = `${opts.workerId}:${randomBytes(6).toString("hex")}`;
    let laneSql = "";
    if (opts.lane !== undefined) {
      if (await this.hasExecMode()) {
        laneSql =
          opts.lane === "now"
            ? `AND exec_mode IS NOT DISTINCT FROM 'now'`
            : `AND exec_mode IS DISTINCT FROM 'now'`;
      } else if (opts.lane === "now") {
        return null; // before 0005 every job is 'delayed'
      }
    }
    // Now lane: FIFO. Batch: random order inside an epoch (N-4).
    const tieBreak = opts.lane === "now" ? "id" : "random()";
    // DB clock (not opts.now): all relayers and core agree on time.
    const res = await this.pool.query<JobRow>(
      `WITH c AS (
         SELECT id FROM relayer_jobs
          WHERE network = $2 AND settled_at IS NULL AND op = ANY($4::text[])
            AND ((status = 'queued' AND not_before <= now())
              OR (status IN ('claimed', 'sent') AND lease_until < now()))
            ${laneSql}
          ORDER BY (status = 'queued'), not_before, ${tieBreak}
          LIMIT 1
          FOR UPDATE SKIP LOCKED)
       UPDATE relayer_jobs j
          SET status = CASE WHEN j.status = 'queued' THEN 'claimed' ELSE j.status END,
              claimed_by = $1, claimed_at = now(),
              lease_until = now() + $3 * interval '1 millisecond',
              attempts = j.attempts + 1, updated_at = now()
         FROM c
        WHERE j.id = c.id
       RETURNING j.id, j.part, j.op, j.venue, j.mint, j.lamports_in, j.token_amount, j.min_out,
                 j.meta, j.dest, j.gas_lamports, j.network, j.attempts, j.status, j.signature,
                 j.last_valid_block_height, j.vault,
                 (extract(epoch FROM j.updated_at) * 1000)::bigint AS sent_at_ms,
                 (extract(epoch FROM j.not_before) * 1000)::bigint AS not_before_ms`,
      [leaseId, this.network, opts.leaseMs, OPS],
    );
    const row = res.rows[0];
    if (!row) return null;
    const inFlight = row.signature !== null && row.last_valid_block_height !== null;
    let spec: JobSpec;
    try {
      spec = rowToSpec(row, this.network);
    } catch (e) {
      // Malformed job (core bug). D7: a row whose tx may be on chain is never
      // failed blindly (the settler would release the hold while the tokens left).
      if (inFlight && !(await this.provablyExpired(row))) {
        await this.extendLease({ id: row.id, leaseId }, 60_000).catch(() => undefined);
        return null;
      }
      await this.reportResult({ id: row.id, leaseId }, {
        status: "failed",
        code: "bad_request",
        message: e instanceof Error ? e.message : "bad job",
      }).catch(() => undefined);
      return null;
    }
    const attempts: SentAttempt[] =
      row.signature && row.last_valid_block_height && row.vault
        ? [
            {
              signature: row.signature,
              lastValidBlockHeight: Number(row.last_valid_block_height),
              vault: row.vault,
              sentAt: Number(row.sent_at_ms),
            },
          ]
        : [];
    return {
      id: row.id,
      spec,
      notBefore: Number(row.not_before_ms),
      claims: row.attempts,
      attempts,
      leaseId,
      leaseUntil: opts.now + opts.leaseMs,
    };
  }

  async reportSent(job: { id: string; leaseId: string }, a: SentAttempt): Promise<void> {
    // Written BEFORE broadcast. A previous signature is only ever replaced after
    // the engine proved it expired (RELAYER.md §4).
    const res = await this.pool.query(
      `UPDATE relayer_jobs
          SET status = 'sent', signature = $2, last_valid_block_height = $3, vault = $4,
              lease_until = now() + $6 * interval '1 millisecond', updated_at = now()
        WHERE id = $1 AND status IN ('claimed', 'sent') AND claimed_by = $5 AND settled_at IS NULL`,
      [job.id, a.signature, a.lastValidBlockHeight, a.vault, job.leaseId, this.leaseMs],
    );
    if (res.rowCount !== 1) throw new LeaseLostError(job.id);
  }

  async reportResult(job: { id: string; leaseId: string }, r: JobResult): Promise<void> {
    if (r.status === "failed") {
      const res = await this.pool.query(
        `UPDATE relayer_jobs SET status = 'failed', error_code = $2, error_message = $3, updated_at = now()
          WHERE id = $1 AND status IN ('claimed', 'sent') AND claimed_by = $4 AND settled_at IS NULL`,
        [job.id, r.code, sanitizeMessage(r.message), job.leaseId],
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
      const outLamports = e.kind === "withdraw" ? 0n : e.solAmount;
      const res = await client.query(
        `UPDATE relayer_jobs
            SET status = 'confirmed', slot = $2, out_mint = $3, out_token_amount = $4,
                out_lamports = $5, network_fee = $6, updated_at = now()
          WHERE id = $1 AND status = 'sent' AND signature = $7 AND claimed_by = $8 AND settled_at IS NULL`,
        [job.id, e.slot, e.mint, e.tokenAmount.toString(), outLamports.toString(), e.networkFee.toString(), e.signature, job.leaseId],
      );
      if (res.rowCount !== 1) throw new LeaseLostError(job.id);
      if (e.kind === "create") await this.writeCreateFeed(client, job, e);
      else if (e.kind !== "withdraw") await this.writeFeed(client, job, e);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** New token row + 'create' event (+ 'buy' of the first buy, same signature). Public data only. */
  private async writeCreateFeed(client: PoolClient, job: { id: string }, e: CreateExecution): Promise<void> {
    const venue = await client.query<{ venue: string }>(`SELECT venue FROM relayer_jobs WHERE id = $1`, [job.id]);
    const v = venue.rows[0]?.venue ?? "pumpfun";
    await client.query(
      `INSERT INTO tokens (mint, venue, symbol, name, image, decimals, status, price_sol, market_cap_sol)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric)
       ON CONFLICT (mint) DO NOTHING`,
      [e.mint, v, e.symbol, e.name, e.imageUrl, e.decimals, e.market?.status ?? "curve", e.market?.priceSol ?? "0", e.market?.marketCapSol ?? "0"],
    );
    const ts = e.blockTime;
    const insert = (kind: "create" | "buy", tokens: bigint, sol: bigint) =>
      client.query(
        `INSERT INTO trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, slot, ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE(to_timestamp($10::double precision), now()))
         ON CONFLICT (signature, kind, mint) DO NOTHING`,
        [kind, v, e.mint, e.symbol, tokens.toString(), sol.toString(), e.decimals, e.signature, e.slot, ts],
      );
    await insert("create", 0n, 0n);
    if (e.tokenAmount > 0n) await insert("buy", e.tokenAmount, e.solAmount);
  }

  /** Public data only (already on Solana). Transfers never reach the feed. */
  private async writeFeed(
    client: PoolClient,
    job: { id: string },
    e: Extract<Extract<JobResult, { status: "executed" }>["execution"], { kind: "buy" | "sell" }>,
  ): Promise<void> {
    const venue = await client.query<{ venue: string }>(`SELECT venue FROM relayer_jobs WHERE id = $1`, [job.id]);
    const v = venue.rows[0]?.venue ?? "pumpfun";
    if (e.market) {
      await client.query(
        `UPDATE tokens SET price_sol = $2::numeric, market_cap_sol = $3::numeric, status = $4, updated_at = now()
          WHERE mint = $1`,
        [e.mint, e.market.priceSol, e.market.marketCapSol, e.market.status],
      );
    }
    await client.query(
      `INSERT INTO trades (kind, venue, mint, symbol, token_amount, sol_amount, decimals, signature, slot, ts)
       VALUES ($1, $2, $3, COALESCE((SELECT symbol FROM tokens WHERE mint = $3), $4), $5, $6, $7, $8, $9,
               COALESCE(to_timestamp($10::double precision), now()))
       ON CONFLICT (signature, kind, mint) DO NOTHING`,
      [e.kind, v, e.mint, e.symbol ?? "", e.tokenAmount.toString(), e.solAmount.toString(), e.decimals, e.signature, e.slot, e.blockTime],
    );
  }

  private async extendLease(job: { id: string; leaseId: string }, ms: number): Promise<void> {
    await this.pool.query(
      `UPDATE relayer_jobs SET lease_until = now() + $2 * interval '1 millisecond', updated_at = now()
        WHERE id = $1 AND status IN ('claimed', 'sent') AND claimed_by = $3 AND settled_at IS NULL`,
      [job.id, ms, job.leaseId],
    );
  }

  /** True only when the recorded tx can no longer land (needs a probe; without one: false). */
  private async provablyExpired(row: JobRow): Promise<boolean> {
    if (!this.probe || !row.signature || !row.last_valid_block_height) return false;
    try {
      const st = await this.probe.state(row.signature, Number(row.last_valid_block_height));
      return st.state === "expired";
    } catch {
      return false;
    }
  }
}

/** relayer_jobs row -> generic spec. Throws on rows this relayer must not execute. */
export function rowToSpec(row: JobRow, network: SolanaNetwork): JobSpec {
  if (row.network !== network) throw new Error(`job for ${row.network}, relayer is ${network}`);
  const big = (v: string | null, name: string): bigint => {
    if (v === null || !/^\d+$/.test(v)) throw new Error(`job ${row.id}: ${name} missing`);
    return BigInt(v);
  };
  const needMint = (): string => {
    if (!row.mint) throw new Error(`job ${row.id}: mint missing`);
    return row.mint;
  };
  switch (row.op) {
    case "buy":
      return { kind: "buy", venue: venue(row), mint: needMint(), lamportsIn: big(row.lamports_in, "lamports_in"), minOut: big(row.min_out, "min_out") };
    case "sell":
      return { kind: "sell", venue: venue(row), mint: needMint(), amount: big(row.token_amount, "token_amount"), minLamports: big(row.min_out, "min_out") };
    case "create": {
      const m = row.meta as { name?: unknown; symbol?: unknown; image?: unknown } | null | undefined;
      if (!m || typeof m !== "object" || typeof m.name !== "string" || typeof m.symbol !== "string") {
        throw new Error(`job ${row.id}: meta.name / meta.symbol missing`);
      }
      if (m.image !== undefined && m.image !== null && typeof m.image !== "string") throw new Error(`job ${row.id}: bad meta.image`);
      return {
        kind: "create",
        venue: venue(row),
        meta: { name: m.name, symbol: m.symbol, ...(typeof m.image === "string" ? { image: m.image } : {}) },
        lamportsIn: row.lamports_in === null ? 0n : big(row.lamports_in, "lamports_in"),
        minOut: row.min_out === null ? 0n : big(row.min_out, "min_out"),
      };
    }
    case "transfer": {
      const mint = needMint();
      if (!row.dest) throw new Error(`job ${row.id}: dest missing`);
      const gas = row.gas_lamports === null ? undefined : big(row.gas_lamports, "gas_lamports");
      return {
        kind: "withdraw",
        mint,
        to: row.dest,
        amount: big(row.token_amount, "token_amount"),
        ...(gas !== undefined && gas > 0n ? { gasLamports: gas } : {}),
      };
    }
    default:
      throw new Error(`job ${row.id}: op ${row.op} not supported by this relayer`);
  }
}

function venue(row: JobRow): VenueId {
  if (row.venue === "pumpfun" || row.venue === "meteora-dbc" || row.venue === "jupiter") return row.venue;
  throw new Error(`job ${row.id}: bad venue`);
}

/** error_message is shown to developers only; keep it short and free of addresses. */
export function sanitizeMessage(m: string): string {
  return m.replace(/[1-9A-HJ-NP-Za-km-z]{32,88}/g, "<addr>").slice(0, 200);
}

export const ERROR_CODES: readonly ApiErrorCode[] = [
  "slippage",
  "graduated",
  "pool_liquidity",
  "venue_unavailable",
  "not_found",
  "bad_request",
  "internal",
];
