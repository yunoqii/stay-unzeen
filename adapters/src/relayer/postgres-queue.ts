import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
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
/** RELAYER v3 (core 0008): taken only when relayer_jobs has the v3 columns. */
const OPS_V3 = [...OPS, "fair_create", "attest"] as const;

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
  /** v3 fair_create: 64-byte mint keypair. Never logged. */
  mint_secret?: Buffer | null;
}

export class PostgresJobQueue implements JobQueue {
  private readonly pool: Pool;
  private readonly network: SolanaNetwork;
  private readonly probe: PostgresJobQueueOptions["probe"];
  private leaseMs = 10 * 60_000;
  private execModeColumn: Promise<boolean> | null = null;
  private v3Columns: Promise<boolean> | null = null;
  private v4Schema: Promise<boolean> | null = null;
  private blockTimeCol: Promise<{ name: string; ts: boolean } | null> | null = null;
  private creatorFeeCol: Promise<boolean> | null = null;

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

  /** Whether relayer_jobs has the v3 columns (core 0008: mint_secret, out_memo). Cached. */
  private hasV3(): Promise<boolean> {
    if (!this.v3Columns) {
      this.v3Columns = this.pool
        .query<{ ok: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_schema = current_schema() AND table_name = 'relayer_jobs'
                             AND column_name = 'mint_secret') AS ok`,
        )
        .then((r) => r.rows[0]?.ok === true)
        .catch((e) => {
          this.v3Columns = null;
          throw e;
        });
    }
    return this.v3Columns;
  }

  /**
   * Whether core 0009 is there (relayer_jobs.out_sig + verify_snapshots readable). Cached.
   * The freeze needs SELECT on verify_snapshots (infra/relayer-role.sql v4).
   */
  private hasV4(): Promise<boolean> {
    if (!this.v4Schema) {
      this.v4Schema = this.pool
        .query<{ ok: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_schema = current_schema() AND table_name = 'relayer_jobs'
                             AND column_name = 'out_sig')
                  AND to_regclass('verify_snapshots') IS NOT NULL AS ok`,
        )
        .then((r) => r.rows[0]?.ok === true)
        .catch((e) => {
          this.v4Schema = null;
          throw e;
        });
    }
    return this.v4Schema;
  }

  /**
   * F2 (lead 12.10): attest results carry the tx blockTime. Core adds the column;
   * until then nothing is written. Accepts `out_block_time` (preferred) or
   * `block_time`, as unix seconds (integer types) or timestamptz. Cached.
   */
  private blockTimeColumn(): Promise<{ name: string; ts: boolean } | null> {
    if (!this.blockTimeCol) {
      this.blockTimeCol = this.pool
        .query<{ column_name: string; data_type: string }>(
          `SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'relayer_jobs'
              AND column_name IN ('out_block_time', 'block_time')
            ORDER BY column_name = 'out_block_time' DESC LIMIT 1`,
        )
        .then((r) => {
          const c = r.rows[0];
          return c ? { name: c.column_name, ts: c.data_type.startsWith("timestamp") } : null;
        })
        .catch((e) => {
          this.blockTimeCol = null;
          throw e;
        });
    }
    return this.blockTimeCol;
  }

  /** RELAYER v6 (core 0013): relayer_jobs.out_creator_fee exists and is writable for this role. Cached. */
  private hasCreatorFee(): Promise<boolean> {
    if (!this.creatorFeeCol) {
      this.creatorFeeCol = this.pool
        .query<{ ok: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_schema = current_schema() AND table_name = 'relayer_jobs'
                             AND column_name = 'out_creator_fee')
                  AND has_column_privilege(current_user, 'relayer_jobs', 'out_creator_fee', 'UPDATE') AS ok`,
        )
        .then((r) => r.rows[0]?.ok === true)
        .catch((e) => {
          this.creatorFeeCol = null;
          throw e;
        });
    }
    return this.creatorFeeCol;
  }

  async claim(opts: { workerId: string; now: number; leaseMs: number; lane?: Lane }): Promise<ClaimedJob | null> {
    this.leaseMs = opts.leaseMs;
    const leaseId = `${opts.workerId}:${randomBytes(6).toString("hex")}`;
    let laneSql = "";
    if (opts.lane === "attest") {
      // RELAYER v5 §3: attest has its own loop (any exec_mode), never behind a fair_create / epoch.
      laneSql = `AND op = 'attest'`;
    } else if (opts.lane !== undefined) {
      if (await this.hasExecMode()) {
        laneSql =
          opts.lane === "now"
            ? `AND exec_mode IS NOT DISTINCT FROM 'now'`
            : `AND exec_mode IS DISTINCT FROM 'now'`;
      } else if (opts.lane === "now") {
        return null; // before 0005 every job is 'delayed'
      }
      laneSql += ` AND op <> 'attest'`; // served by the attest lane only
    }
    // Now lane: FIFO. Batch: random order inside an epoch (N-4). Attest: FIFO.
    const tieBreak = opts.lane === "batch" || opts.lane === undefined ? "random()" : "id";
    // Attest lane: fair-launch roots (deadline: the drand round) before Verify anchors.
    // No lane: attest jobs first.
    const priority =
      opts.lane === "attest"
        ? `(meta->>'purpose' IS NOT DISTINCT FROM 'verify'), `
        : opts.lane === undefined
          ? `(op <> 'attest'), `
          : "";
    const v3 = await this.hasV3();
    // RELAYER v4 §1: while a Verify snapshot of this network is freezing/collecting,
    // no NEW job is taken (both lanes, every op incl. fair_create; attest exempt, E21).
    // In-flight rows (claimed/sent, lease ran out) are still driven to the end:
    // core waits for exactly those before it reads the ledger.
    // E21: attest is exempt (memo signed and paid by an attestation key, never a vault:
    // no ledger/vault balance moves), so a fair-launch root is not held up to 120 s.
    const freeze = (await this.hasV4())
      ? `AND (op = 'attest' OR NOT EXISTS (SELECT 1 FROM verify_snapshots v
                          WHERE v.network = $2 AND v.status IN ('freezing', 'collecting')
                            AND v.freeze_until > now()))`
      : "";
    // DB clock (not opts.now): all relayers and core agree on time.
    const res = await this.pool.query<JobRow>(
      `WITH c AS (
         SELECT id FROM relayer_jobs
          WHERE network = $2 AND settled_at IS NULL AND op = ANY($4::text[])
            AND ((status = 'queued' AND not_before <= now() ${freeze})
              OR (status IN ('claimed', 'sent') AND lease_until < now()))
            ${laneSql}
          ORDER BY ${priority}(status = 'queued'), not_before, ${tieBreak}
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
                 (extract(epoch FROM j.not_before) * 1000)::bigint AS not_before_ms
                 ${v3 ? ", j.mint_secret" : ""}`,
      [leaseId, this.network, opts.leaseMs, v3 ? OPS_V3 : OPS],
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
    if (e.kind === "attest") {
      // No feed rows; the memo comes from the confirmed tx, not from the job.
      // v4: + out_sig (attestation key over hex_decode(meta.memo)) when the column exists.
      const v4 = e.outSig !== undefined && (await this.hasV4());
      const bt = e.blockTime !== null ? await this.blockTimeColumn() : null;
      const params: unknown[] = [job.id, e.slot, e.memo, e.networkFee.toString(), e.signature, job.leaseId];
      let extra = "";
      if (v4) {
        params.push(e.outSig);
        extra += `, out_sig = $${params.length}`;
      }
      if (bt) {
        params.push(e.blockTime);
        extra += `, ${bt.name} = ${bt.ts ? `to_timestamp($${params.length}::double precision)` : `$${params.length}`}`;
      }
      const res = await this.pool.query(
        `UPDATE relayer_jobs SET status = 'confirmed', slot = $2, out_memo = $3, network_fee = $4, updated_at = now()${extra}
          WHERE id = $1 AND status = 'sent' AND signature = $5 AND claimed_by = $6 AND settled_at IS NULL`,
        params,
      );
      if (res.rowCount !== 1) throw new LeaseLostError(job.id);
      return;
    }
    // v6: exact launch-tx creator fee (create / fair_create), when known and the column exists.
    const fee = e.kind === "create" && e.creatorFee !== undefined && e.creatorFee !== null && (await this.hasCreatorFee()) ? e.creatorFee : null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const outLamports = e.kind === "withdraw" ? 0n : e.solAmount;
      const params: unknown[] = [job.id, e.slot, e.mint, e.tokenAmount.toString(), outLamports.toString(), e.networkFee.toString(), e.signature, job.leaseId];
      if (fee !== null) params.push(fee.toString());
      const res = await client.query(
        `UPDATE relayer_jobs
            SET status = 'confirmed', slot = $2, out_mint = $3, out_token_amount = $4,
                out_lamports = $5, network_fee = $6, updated_at = now()${fee !== null ? ", out_creator_fee = $9" : ""}
          WHERE id = $1 AND status = 'sent' AND signature = $7 AND claimed_by = $8 AND settled_at IS NULL`,
        params,
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
    case "fair_create": {
      const m = row.meta as { name?: unknown; symbol?: unknown; image?: unknown } | null | undefined;
      if (!m || typeof m !== "object" || typeof m.name !== "string" || typeof m.symbol !== "string") {
        throw new Error(`job ${row.id}: meta.name / meta.symbol missing`);
      }
      if (m.image !== undefined && m.image !== null && typeof m.image !== "string") throw new Error(`job ${row.id}: bad meta.image`);
      const secret = row.mint_secret;
      if (!secret || secret.length !== 64) throw new Error(`job ${row.id}: mint_secret missing`);
      let mintKeypair: Keypair;
      try {
        mintKeypair = Keypair.fromSecretKey(Uint8Array.from(secret)); // checks pubkey = seed's
      } catch {
        throw new Error(`job ${row.id}: bad mint_secret`);
      }
      const minOut = big(row.min_out, "min_out");
      if (minOut <= 0n) throw new Error(`job ${row.id}: min_out must be > 0`);
      return {
        kind: "fair_create",
        venue: venue(row),
        meta: { name: m.name, symbol: m.symbol, ...(typeof m.image === "string" ? { image: m.image } : {}) },
        lamportsIn: big(row.lamports_in, "lamports_in"),
        minOut,
        mintKeypair,
      };
    }
    case "attest": {
      const m = row.meta as { memo?: unknown; purpose?: unknown } | null | undefined;
      if (!m || typeof m.memo !== "string" || !/^[0-9a-f]{64}$/.test(m.memo)) throw new Error(`job ${row.id}: meta.memo must be 64 hex`);
      if (m.purpose !== undefined && m.purpose !== null && m.purpose !== "verify" && m.purpose !== "fair") {
        throw new Error(`job ${row.id}: meta.purpose must be verify|fair`);
      }
      // F14: no marker -> the fair-launch key (never the public Verify key by accident).
      return { kind: "attest", memo: m.memo, purpose: m.purpose === "verify" ? "verify" : "fair" };
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
