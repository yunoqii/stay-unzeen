import fs from "node:fs";
import path from "node:path";
import { PublicKey, type Connection, type Signer, type TransactionInstruction, type VersionedTransactionResponse } from "@solana/web3.js";
import type { Pool } from "pg";
import {
  DBC_FEE_CU,
  LL_FEE_CU,
  PUMP_FEE_CU,
  feeTxCost,
  sweepThreshold,
  DEFAULT_THRESHOLD,
  type FeeKind,
  type FeeTarget,
  type FeeTxPlan,
  type FeeVenue,
  type FeeVenueId,
  type ThresholdPolicy,
} from "../creator-fees";
import type { PriorityPrice } from "../fees";
import type { TxPipeline } from "../sender";
import { broadcastAndConfirm, fetchTx, signTx, signatureState, type SignatureState, type SignedTx } from "../tx";
import type { Rng } from "./random";
import type { SolanaNetwork } from "./postgres-queue";
import { VaultsBusyError, type VaultPool } from "./vaults";

/**
 * Global creator-fee sweep (docs/ARCHITECTURE.md "Сбор комиссий (claim)",
 * review-day2 H7). Runs on its own schedule (random 6-12 h), never because a
 * user asked: `claim` in core is a ledger-only operation over what this
 * sweeper recorded.
 *
 * Per run: every claimable target of every venue (all creator addresses of the
 * pool + the DBC partner side) above its threshold, in a uniformly random
 * order, ONE transaction per target (never two fee authorities in one tx),
 * random pauses between them, the receiving vault picked by rotation (LRU half,
 * never the one used just before) and locked like any relayer tx. Every tx is
 * signed through the pool pipeline: the same compute unit price, the same
 * Sender tip on mainnet.
 *
 * Bookkeeping (for core): a `sent` row with the signature BEFORE broadcast,
 * then `confirmed` with the lamports that reached the vault (from the landed
 * tx), or `failed`. Unknown outcomes are resolved at the start of the next run.
 * Logs carry counts and totals only.
 */

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export interface FeeSweepRow {
  network: SolanaNetwork;
  venue: FeeVenueId;
  kind: FeeKind;
  mint: string;
  /** Fee authority of the target (creator / partner address); needed to read the landed tx. */
  authority: string;
  signature: string;
  lastValidBlockHeight: number;
  status: "sent" | "confirmed" | "failed";
  lamports: bigint | null;
  slot: number | null;
  /** Block time (unix seconds) of the landed tx. */
  sweptAt: number | null;
  /** RELAYER v8 A8: fee collected in a quote token (then `lamports` = 0). */
  quoteMint?: string | null;
  quoteAmount?: bigint | null;
}

export interface FeeSweepStore {
  /** Before broadcast. Idempotent by signature. */
  recordSent(r: Omit<FeeSweepRow, "status" | "lamports" | "slot" | "sweptAt" | "quoteAmount">): Promise<void>;
  /** `quoteAmount`: units of the row's quote mint (quote rows; `lamports` is then 0). */
  confirm(signature: string, lamports: bigint, slot: number, sweptAt: number | null, quoteAmount?: bigint | null): Promise<void>;
  /** Whether quote rows can be recorded (core 0019 columns); quote targets are skipped otherwise. */
  supportsQuote(): Promise<boolean>;
  fail(signature: string): Promise<void>;
  /** Rows still `sent` (outcome unknown) of this network. */
  pending(network: SolanaNetwork): Promise<FeeSweepRow[]>;
  /** Confirmed lamports per (venue, kind, mint) of this network. */
  totals(network: SolanaNetwork): Promise<{ venue: FeeVenueId; kind: FeeKind; mint: string; lamports: bigint }[]>;
}

export class MemoryFeeSweepStore implements FeeSweepStore {
  readonly rows: FeeSweepRow[] = [];

  async recordSent(r: Omit<FeeSweepRow, "status" | "lamports" | "slot" | "sweptAt" | "quoteAmount">): Promise<void> {
    if (this.rows.some((x) => x.signature === r.signature)) return;
    this.rows.push({ ...r, status: "sent", lamports: null, slot: null, sweptAt: null, quoteMint: r.quoteMint ?? null, quoteAmount: null });
  }
  async confirm(signature: string, lamports: bigint, slot: number, sweptAt: number | null, quoteAmount: bigint | null = null): Promise<void> {
    const r = this.rows.find((x) => x.signature === signature);
    if (r && r.status === "sent") Object.assign(r, { status: "confirmed", lamports, slot, sweptAt, quoteAmount });
  }
  async supportsQuote(): Promise<boolean> {
    return true;
  }
  async fail(signature: string): Promise<void> {
    const r = this.rows.find((x) => x.signature === signature);
    if (r && r.status === "sent") r.status = "failed";
  }
  async pending(network: SolanaNetwork): Promise<FeeSweepRow[]> {
    return this.rows.filter((r) => r.network === network && r.status === "sent").map((r) => ({ ...r }));
  }
  async totals(network: SolanaNetwork): Promise<{ venue: FeeVenueId; kind: FeeKind; mint: string; lamports: bigint }[]> {
    const m = new Map<string, { venue: FeeVenueId; kind: FeeKind; mint: string; lamports: bigint }>();
    for (const r of this.rows) {
      if (r.network !== network || r.status !== "confirmed" || r.lamports === null) continue;
      const k = `${r.venue}|${r.kind}|${r.mint}`;
      const cur = m.get(k) ?? { venue: r.venue, kind: r.kind, mint: r.mint, lamports: 0n };
      cur.lamports += r.lamports;
      m.set(k, cur);
    }
    return [...m.values()];
  }
}

/**
 * JSON file store (until core adds `creator_fee_sweeps`): whole-file rewrite
 * with atomic rename, 0600. Public data only (mint, amount, signature are on
 * chain); no anon keys, no job ids.
 */
export class FileFeeSweepStore extends MemoryFeeSweepStore {
  constructor(readonly file: string) {
    super();
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, "utf8")) as { rows?: Array<Record<string, unknown>> };
      for (const r of j.rows ?? []) {
        this.rows.push({
          ...(r as unknown as FeeSweepRow),
          lamports: r.lamports === null || r.lamports === undefined ? null : BigInt(r.lamports as string),
          quoteAmount: r.quoteAmount === null || r.quoteAmount === undefined ? null : BigInt(r.quoteAmount as string),
        });
      }
    }
  }
  override async recordSent(r: Omit<FeeSweepRow, "status" | "lamports" | "slot" | "sweptAt" | "quoteAmount">): Promise<void> {
    await super.recordSent(r);
    this.save();
  }
  override async confirm(signature: string, lamports: bigint, slot: number, sweptAt: number | null, quoteAmount: bigint | null = null): Promise<void> {
    await super.confirm(signature, lamports, slot, sweptAt, quoteAmount);
    this.save();
  }
  override async fail(signature: string): Promise<void> {
    await super.fail(signature);
    this.save();
  }
  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const rows = this.rows.map((r) => ({
      ...r,
      lamports: r.lamports === null ? null : r.lamports.toString(),
      quoteAmount: r.quoteAmount === null || r.quoteAmount === undefined ? null : r.quoteAmount.toString(),
    }));
    fs.writeFileSync(tmp, JSON.stringify({ rows }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/**
 * Table proposed to core (the relayer never runs DDL). `authority` is the
 * public fee authority of the target (the launch's fresh creator address or
 * the DBC partner key); it is on chain in the tx anyway and lets the pending
 * resolver read the landed amount. `credited_at` is core's: set when the
 * creator share was credited to the launcher's balance (`claim` = ledger op).
 */
export const PROPOSED_FEE_SWEEPS_SQL = `
CREATE TABLE creator_fee_sweeps (
    id                      BIGSERIAL PRIMARY KEY,
    network                 TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet-beta')),
    venue                   TEXT NOT NULL CHECK (venue IN ('pumpfun', 'meteora-dbc')),
    kind                    TEXT NOT NULL CHECK (kind IN ('creator', 'partner')),
    mint                    TEXT NOT NULL,
    authority               TEXT NOT NULL,
    signature               TEXT NOT NULL UNIQUE,      -- written BEFORE broadcast
    last_valid_block_height BIGINT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'confirmed', 'failed')),
    lamports                BIGINT CHECK (lamports >= 0),  -- set on 'confirmed': SOL that reached the pool vault
    slot                    BIGINT,
    swept_at                TIMESTAMPTZ,               -- block time of the landed tx
    credited_at             TIMESTAMPTZ,               -- core: credited to the creator's balance
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (status <> 'confirmed' OR (lamports IS NOT NULL AND slot IS NOT NULL))
);
CREATE INDEX creator_fee_sweeps_pending_idx ON creator_fee_sweeps (network) WHERE status = 'sent';
CREATE INDEX creator_fee_sweeps_credit_idx ON creator_fee_sweeps (network, mint)
    WHERE status = 'confirmed' AND kind = 'creator' AND credited_at IS NULL;
`;

export const PROPOSED_FEE_SWEEPS_GRANTS = `
GRANT SELECT (id, network, venue, kind, mint, authority, signature, last_valid_block_height,
              status, lamports, slot, swept_at, created_at)
    ON creator_fee_sweeps TO unzeen_relayer;
GRANT INSERT (network, venue, kind, mint, authority, signature, last_valid_block_height)
    ON creator_fee_sweeps TO unzeen_relayer;
GRANT UPDATE (status, lamports, slot, swept_at) ON creator_fee_sweeps TO unzeen_relayer;
GRANT USAGE ON SEQUENCE creator_fee_sweeps_id_seq TO unzeen_relayer;
`;

/** Store over the proposed `creator_fee_sweeps` (FEE_SWEEP_STORE=postgres once core has it). */
export class PgFeeSweepStore implements FeeSweepStore {
  private quoteCols: Promise<boolean> | null = null;
  constructor(private readonly pool: Pool) {}

  /** core 0019: quote_mint (INSERT, SELECT) / quote_amount (UPDATE). Cached. */
  supportsQuote(): Promise<boolean> {
    this.quoteCols ??= this.pool
      .query<{ ok: boolean }>(
        `SELECT has_column_privilege(current_user, 'creator_fee_sweeps', 'quote_mint', 'INSERT')
                AND has_column_privilege(current_user, 'creator_fee_sweeps', 'quote_mint', 'SELECT')
                AND has_column_privilege(current_user, 'creator_fee_sweeps', 'quote_amount', 'UPDATE') AS ok`,
      )
      .then((r) => r.rows[0]?.ok === true)
      .catch(() => false);
    return this.quoteCols;
  }

  async recordSent(r: Omit<FeeSweepRow, "status" | "lamports" | "slot" | "sweptAt" | "quoteAmount">): Promise<void> {
    if (r.quoteMint) {
      if (!(await this.supportsQuote())) throw new Error("creator_fee_sweeps has no quote columns (core 0019)");
      await this.pool.query(
        `INSERT INTO creator_fee_sweeps (network, venue, kind, mint, authority, signature, last_valid_block_height, quote_mint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (signature) DO NOTHING`,
        [r.network, r.venue, r.kind, r.mint, r.authority, r.signature, r.lastValidBlockHeight, r.quoteMint],
      );
      return;
    }
    await this.pool.query(
      `INSERT INTO creator_fee_sweeps (network, venue, kind, mint, authority, signature, last_valid_block_height)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (signature) DO NOTHING`,
      [r.network, r.venue, r.kind, r.mint, r.authority, r.signature, r.lastValidBlockHeight],
    );
  }
  async confirm(signature: string, lamports: bigint, slot: number, sweptAt: number | null, quoteAmount: bigint | null = null): Promise<void> {
    if (quoteAmount !== null) {
      await this.pool.query(
        `UPDATE creator_fee_sweeps SET status = 'confirmed', lamports = $2, slot = $3, quote_amount = $5,
                swept_at = CASE WHEN $4::bigint IS NULL THEN NULL ELSE to_timestamp($4::bigint) END
          WHERE signature = $1 AND status = 'sent'`,
        [signature, lamports.toString(), slot, sweptAt, quoteAmount.toString()],
      );
      return;
    }
    await this.pool.query(
      `UPDATE creator_fee_sweeps SET status = 'confirmed', lamports = $2, slot = $3,
              swept_at = CASE WHEN $4::bigint IS NULL THEN NULL ELSE to_timestamp($4::bigint) END
        WHERE signature = $1 AND status = 'sent'`,
      [signature, lamports.toString(), slot, sweptAt],
    );
  }
  async fail(signature: string): Promise<void> {
    await this.pool.query(`UPDATE creator_fee_sweeps SET status = 'failed' WHERE signature = $1 AND status = 'sent'`, [signature]);
  }
  async pending(network: SolanaNetwork): Promise<FeeSweepRow[]> {
    const q = await this.supportsQuote();
    const r = await this.pool.query<{ venue: FeeVenueId; kind: FeeKind; mint: string; authority: string; signature: string; lvbh: string; quote_mint: string | null }>(
      `SELECT venue, kind, mint, authority, signature, last_valid_block_height AS lvbh, ${q ? "quote_mint" : "NULL::text AS quote_mint"}
         FROM creator_fee_sweeps WHERE network = $1 AND status = 'sent'`,
      [network],
    );
    return r.rows.map((x) => ({
      quoteMint: x.quote_mint,
      network,
      venue: x.venue,
      kind: x.kind,
      mint: x.mint,
      authority: x.authority,
      signature: x.signature,
      lastValidBlockHeight: Number(x.lvbh),
      status: "sent",
      lamports: null,
      slot: null,
      sweptAt: null,
    }));
  }
  async totals(network: SolanaNetwork): Promise<{ venue: FeeVenueId; kind: FeeKind; mint: string; lamports: bigint }[]> {
    const r = await this.pool.query<{ venue: FeeVenueId; kind: FeeKind; mint: string; lamports: string }>(
      `SELECT venue, kind, mint, sum(lamports)::text AS lamports FROM creator_fee_sweeps
        WHERE network = $1 AND status = 'confirmed' GROUP BY venue, kind, mint`,
      [network],
    );
    return r.rows.map((x) => ({ ...x, lamports: BigInt(x.lamports) }));
  }
}

// ---------------------------------------------------------------------------
// schedule
// ---------------------------------------------------------------------------

export interface SweepSchedule {
  /** Random interval between runs (inclusive bounds, ms). */
  intervalMinMs: number;
  intervalMaxMs: number;
  /** Random pause between two targets of one run (ms). */
  pauseMinMs: number;
  pauseMaxMs: number;
}

/** 6-12 h between runs, 20 s - 5 min between targets. */
export const DEFAULT_SWEEP_SCHEDULE: SweepSchedule = {
  intervalMinMs: 6 * 3_600_000,
  intervalMaxMs: 12 * 3_600_000,
  pauseMinMs: 20_000,
  pauseMaxMs: 300_000,
};

export function nextSweepDelay(rng: Rng, s: SweepSchedule = DEFAULT_SWEEP_SCHEDULE): number {
  return rng.int(s.intervalMinMs, s.intervalMaxMs);
}

/** Fisher-Yates with the injected RNG (CSPRNG in production). */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ---------------------------------------------------------------------------
// H7 guard
// ---------------------------------------------------------------------------

/**
 * Refuses any fee tx that is not "one vault + one fee authority": every signer
 * an instruction asks for must be the paying vault or this target's authority.
 * Two creators (or creator + partner) in one tx would publicly link launches.
 */
export function assertSingleAuthority(ixs: readonly TransactionInstruction[], vault: PublicKey, authority: PublicKey): void {
  for (const ix of ixs) {
    for (const k of ix.keys) {
      if (k.isSigner && !k.pubkey.equals(vault) && !k.pubkey.equals(authority)) {
        throw new Error("fee tx would need a second fee authority (H7): refused");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// sweeper
// ---------------------------------------------------------------------------

/** Chain access of the sweeper (RPC in production, fakes in tests). */
export interface SweepChain {
  sign(ixs: TransactionInstruction[], payer: Signer, authority: Signer, computeUnits: number): Promise<SignedTx>;
  /** Broadcast + confirm; throws when it did not land (or landed with an error). */
  submit(tx: SignedTx): Promise<{ slot: number }>;
  fetch(signature: string): Promise<VersionedTransactionResponse | null>;
  state(signature: string, lastValidBlockHeight: number): Promise<SignatureState>;
}

export class RpcSweepChain implements SweepChain {
  constructor(
    private readonly connection: Connection,
    private readonly price: PriorityPrice,
    private readonly pipeline: TxPipeline,
  ) {}
  sign(ixs: TransactionInstruction[], payer: Signer, authority: Signer, computeUnits: number): Promise<SignedTx> {
    return signTx(this.connection, ixs, payer, [authority], {
      computeUnits,
      priorityMicroLamports: this.price.microLamports(),
      tip: this.pipeline.tip,
    });
  }
  async submit(tx: SignedTx): Promise<{ slot: number }> {
    return broadcastAndConfirm(this.connection, tx, this.pipeline.broadcaster);
  }
  fetch(signature: string): Promise<VersionedTransactionResponse | null> {
    return fetchTx(this.connection, signature, 10);
  }
  async state(signature: string, lastValidBlockHeight: number): Promise<SignatureState> {
    return signatureState(this.connection, signature, lastValidBlockHeight);
  }
}

/**
 * Values quote-token fees for the threshold (RELAYER v8 A8). Priced quotes (USDC / USD1): SOL
 * value on pool A. Stock-only quotes (ZEC SPL): no SOL value here -> a minimum in units.
 */
export interface QuoteValuer {
  /**
   * SOL value of `units` of `mint` (pool A, now); null = no price by design (stock-only ZEC SPL).
   * Throws when a priced quote cannot be valued right now.
   */
  lamports(mint: string, units: bigint): Promise<bigint | null>;
  /** Minimum units worth a tx when there is no price; null = never collect. */
  minUnits(mint: string): bigint | null;
}

export interface FeeSweeperOptions {
  network: SolanaNetwork;
  venues: readonly FeeVenue[];
  pool: VaultPool;
  chain: SweepChain;
  store: FeeSweepStore;
  rng: Rng;
  /** Current compute unit price (pool-wide cache) and tip, for the cost estimate. */
  price: PriorityPrice;
  tipLamports: bigint;
  threshold?: ThresholdPolicy;
  schedule?: SweepSchedule;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Counts / totals only (never mint + amount + signature together in production logs). */
  log?: (msg: string) => void;
  /**
   * RELAYER v4: true while a Verify snapshot freezes the pool. The sweep moves
   * SOL between pool addresses outside relayer_jobs; it stops for the rest of
   * the run (the next run picks the targets up).
   */
  paused?: () => Promise<boolean>;
  /** Detail sink for devnet scripts (explorer links); not used by the daemon. */
  onTx?: (e: { target: FeeTarget; signature: string; lamports: bigint | null; vault: string; ok: boolean; error?: string }) => void;
  /** Quote-token fees: valuation for the threshold; without it quote targets are never collected. */
  quoteValuer?: QuoteValuer;
}

export interface SweepReport {
  considered: number;
  belowThreshold: number;
  sent: number;
  confirmed: number;
  failed: number;
  skipped: number;
  lamports: bigint;
  /** Lamports per mint collected in this run (creator + partner kinds separately). */
  byMint: { venue: FeeVenueId; kind: FeeKind; mint: string; lamports: bigint }[];
  /** Quote units collected in this run, per quote mint (they became vault quote stock). */
  quote: { mint: string; units: bigint }[];
  resolvedPending: number;
}

const SIGNATURES_PER_FEE_TX = 2; // vault + one authority

export class FeeSweeper {
  private readonly o: Required<Omit<FeeSweeperOptions, "onTx" | "paused" | "quoteValuer">> & Pick<FeeSweeperOptions, "onTx" | "paused" | "quoteValuer">;

  constructor(o: FeeSweeperOptions) {
    this.o = {
      threshold: DEFAULT_THRESHOLD,
      schedule: DEFAULT_SWEEP_SCHEDULE,
      sleep: abortableSleep,
      now: Date.now,
      log: () => undefined,
      ...o,
    };
  }

  /** Claimable targets above their threshold, in random order: one tx each. */
  async plan(): Promise<{ targets: FeeTarget[]; considered: number; belowThreshold: number }> {
    const all: FeeTarget[] = [];
    for (const v of this.o.venues) all.push(...(await v.discover()));
    const price = this.o.price.microLamports();
    const quoteOk = all.some((t) => t.quote) ? await this.o.store.supportsQuote().catch(() => false) : false;
    const keep: FeeTarget[] = [];
    for (const t of all) {
      if (t.quote && !quoteOk) continue; // core 0019 missing: never sweep what core cannot see
      if (await this.eligible(t, price)) keep.push(t);
    }
    return { targets: shuffle(keep, this.o.rng), considered: all.length, belowThreshold: all.length - keep.length };
  }

  /** Worth a tx: SOL above its threshold; quote units valued on pool A, or above the unit minimum. */
  async eligible(t: FeeTarget, microLamports: number = this.o.price.microLamports()): Promise<boolean> {
    const threshold = this.thresholdOf(t, microLamports);
    if (!t.quote) return t.lamports >= threshold;
    if (t.quote.units <= 0n || !this.o.quoteValuer) return false;
    const value = await this.o.quoteValuer.lamports(t.quote.mint, t.quote.units).catch(() => null);
    if (value !== null) return value >= threshold;
    const min = this.o.quoteValuer.minUnits(t.quote.mint);
    return min !== null && t.quote.units >= min;
  }

  thresholdOf(t: FeeTarget, microLamports: number = this.o.price.microLamports()): bigint {
    const venue = this.venueOf(t);
    const cu = venue.venue === "pumpfun" ? PUMP_FEE_CU : venue.venue === "raydium-launchlab" ? LL_FEE_CU : DBC_FEE_CU;
    const cost = feeTxCost({ signatures: SIGNATURES_PER_FEE_TX, computeUnits: cu, microLamportsPerCu: microLamports, tipLamports: this.o.tipLamports });
    return sweepThreshold(cost, t.lockedRent, this.o.threshold);
  }

  /** One full sweep now (devnet "by command"; the daemon calls it on schedule). */
  async runOnce(signal?: AbortSignal): Promise<SweepReport> {
    const resolvedPending = await this.resolvePending();
    const { targets, considered, belowThreshold } = await this.plan();
    const report: SweepReport = { considered, belowThreshold, sent: 0, confirmed: 0, failed: 0, skipped: 0, lamports: 0n, byMint: [], quote: [], resolvedPending };
    const by = new Map<string, { venue: FeeVenueId; kind: FeeKind; mint: string; lamports: bigint }>();
    const byQuote = new Map<string, bigint>();
    for (let i = 0; i < targets.length; i++) {
      if (signal?.aborted) break;
      if (i > 0) await this.o.sleep(this.o.rng.int(this.o.schedule.pauseMinMs, this.o.schedule.pauseMaxMs), signal);
      if (signal?.aborted) break;
      if (this.o.paused && (await this.o.paused().catch(() => true))) {
        report.skipped += targets.length - i;
        break;
      }
      const r = await this.sweepOne(targets[i]!);
      if (r === "skipped") {
        report.skipped++;
        continue;
      }
      report.sent++;
      if (r.ok) {
        report.confirmed++;
        const qt = targets[i]!.quote;
        if (qt && r.lamports !== null) {
          byQuote.set(qt.mint, (byQuote.get(qt.mint) ?? 0n) + r.lamports);
        } else if (r.lamports !== null) {
          report.lamports += r.lamports;
          const t = targets[i]!;
          const k = `${t.venue}|${t.kind}|${t.mint}`;
          const cur = by.get(k) ?? { venue: t.venue, kind: t.kind, mint: t.mint, lamports: 0n };
          cur.lamports += r.lamports;
          by.set(k, cur);
        }
      } else {
        report.failed++;
      }
    }
    report.byMint = [...by.values()];
    report.quote = [...byQuote].map(([mint, units]) => ({ mint, units }));
    this.o.log(
      `fee sweep: ${report.considered} considered, ${report.belowThreshold} below threshold, ${report.sent} sent, ` +
        `${report.confirmed} confirmed, ${report.failed} failed, ${report.skipped} skipped, ${report.lamports} lamports` +
        (report.quote.length ? `, quote in ${report.quote.length} mint(s)` : ""),
    );
    return report;
  }

  /** Daemon: wait a random 6-12 h, sweep, repeat (first run also after a random wait). */
  async runForever(signal: AbortSignal, onError: (e: unknown) => void = () => undefined): Promise<void> {
    while (!signal.aborted) {
      await this.o.sleep(nextSweepDelay(this.o.rng, this.o.schedule), signal);
      if (signal.aborted) break;
      try {
        await this.runOnce(signal);
      } catch (e) {
        onError(e);
      }
    }
  }

  /** One target = one transaction, signed by one vault and one fee authority. */
  private async sweepOne(t: FeeTarget): Promise<{ ok: boolean; lamports: bigint | null } | "skipped"> {
    const venue = this.venueOf(t);
    let vault: Signer;
    try {
      vault = await this.o.pool.acquire({ minSol: t.frontLamports + t.lockedRent + 1_000_000n });
    } catch (e) {
      if (e instanceof VaultsBusyError) return "skipped"; // next run picks it up
      this.o.log(`fee sweep: no vault with enough SOL`);
      return "skipped";
    }
    const vaultKey = vault.publicKey.toBase58();
    let signed: SignedTx | null = null;
    try {
      const plan: FeeTxPlan | null = await venue.build(t, vault.publicKey);
      if (!plan || !(await this.eligible(plan.target))) return "skipped";
      assertSingleAuthority(plan.instructions, vault.publicKey, plan.authority.publicKey);
      if (plan.authority.publicKey.toBase58() !== t.authority) throw new Error("plan authority differs from target");
      signed = await this.o.chain.sign(plan.instructions, vault, plan.authority, plan.computeUnits);
      await this.o.store.recordSent({
        network: this.o.network,
        venue: t.venue,
        kind: t.kind,
        mint: t.mint,
        authority: t.authority,
        signature: signed.signature,
        lastValidBlockHeight: signed.lastValidBlockHeight,
        ...(plan.target.quote ? { quoteMint: plan.target.quote.mint } : {}),
      });
      await this.o.pool.markUsed(vaultKey, this.o.now());
      let slot: number;
      try {
        ({ slot } = await this.o.chain.submit(signed));
      } catch (e) {
        // Outcome may be unknown (timeout): leave `sent`, the next run resolves it.
        const st = await this.o.chain.state(signed.signature, signed.lastValidBlockHeight).catch(() => ({ state: "pending" as const }));
        if (st.state === "expired" || (st.state === "landed" && st.err !== null) || isPreflight(e)) {
          await this.o.store.fail(signed.signature);
        }
        this.o.onTx?.({ target: t, signature: signed.signature, lamports: null, vault: vaultKey, ok: false, error: errMsg(e) });
        return { ok: false, lamports: null };
      }
      const tx = await this.o.chain.fetch(signed.signature).catch(() => null);
      // Quote targets: `lamports` here are quote units (row: quote_amount = units, lamports = their value).
      const lamports = (tx ? venue.collected(tx, plan.target) : null) ?? plan.expectedLamports;
      if (plan.target.quote) {
        const value = await this.quoteLamports(plan.target.quote.mint, lamports);
        // Not valuable now: the row stays `sent`, the next run's resolvePending values and confirms it.
        if (value !== null) await this.o.store.confirm(signed.signature, value, slot, tx?.blockTime ?? null, lamports);
      } else await this.o.store.confirm(signed.signature, lamports, slot, tx?.blockTime ?? null);
      this.o.onTx?.({ target: plan.target, signature: signed.signature, lamports, vault: vaultKey, ok: true });
      return { ok: true, lamports };
    } catch (e) {
      if (signed) {
        this.o.onTx?.({ target: t, signature: signed.signature, lamports: null, vault: vaultKey, ok: false, error: errMsg(e) });
        return { ok: false, lamports: null };
      }
      this.o.onTx?.({ target: t, signature: "", lamports: null, vault: vaultKey, ok: false, error: errMsg(e) });
      return "skipped";
    } finally {
      await this.o.pool.release(vault);
    }
  }

  /** Rows left `sent` by a crash / timeout: landed -> confirm with the read amount, expired -> failed. */
  async resolvePending(): Promise<number> {
    let n = 0;
    for (const row of await this.o.store.pending(this.o.network)) {
      const st = await this.o.chain.state(row.signature, row.lastValidBlockHeight).catch(() => null);
      if (!st || st.state === "pending") continue;
      if (st.state === "expired" || st.err !== null) {
        await this.o.store.fail(row.signature);
        n++;
        continue;
      }
      const tx = await this.o.chain.fetch(row.signature).catch(() => null);
      const venue = this.o.venues.find((v) => v.venue === row.venue);
      const target: FeeTarget = {
        venue: row.venue, kind: row.kind, mint: row.mint, authority: row.authority, lamports: 0n, lockedRent: 0n, frontLamports: 0n,
        ...(row.quoteMint ? { quote: { mint: row.quoteMint, units: 0n } } : {}),
      };
      const lamports = tx && venue ? venue.collected(tx, target) : null;
      if (lamports === null) continue; // landed but unreadable yet: retry next run, never guess
      if (row.quoteMint) {
        const value = await this.quoteLamports(row.quoteMint, lamports);
        if (value === null) continue; // priced quote not valuable now: next run
        await this.o.store.confirm(row.signature, value, st.slot, tx?.blockTime ?? null, lamports);
      } else await this.o.store.confirm(row.signature, lamports, st.slot, tx?.blockTime ?? null);
      n++;
    }
    return n;
  }

  /**
   * RELAYER v9 §2: `lamports` of a quote row. USDC / USD1: SOL value of the units on pool A at
   * collection (core credits exactly this; 0 would never be credited). ZEC SPL: 0 (core credits
   * the units 1:1 in zat). null = a priced quote that cannot be valued right now.
   */
  private async quoteLamports(mint: string, units: bigint): Promise<bigint | null> {
    if (!this.o.quoteValuer) return null;
    try {
      return (await this.o.quoteValuer.lamports(mint, units)) ?? 0n;
    } catch {
      this.o.log("fee sweep: quote valuation unavailable, row left for the next run");
      return null;
    }
  }

  private venueOf(t: FeeTarget): FeeVenue {
    const v = this.o.venues.find((x) => x.venue === t.venue);
    if (!v) throw new Error(`no fee venue ${t.venue}`);
    return v;
  }
}

function isPreflight(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { stage?: string }).stage === "preflight";
}

function errMsg(e: unknown): string {
  const inner = typeof e === "object" && e !== null && "error" in e ? (e as { error: unknown }).error : e;
  return (inner instanceof Error ? inner.message : String(inner)).split("\n", 1)[0]!.slice(0, 200);
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// ---------------------------------------------------------------------------
// candidate mints (pump.fun creators are not visible on chain until a claim)
// ---------------------------------------------------------------------------

/** Mints the pool touched: pins (`mint_vaults`, every create is pinned) + recorded creates. Relayer role grants suffice. */
export class PgMintSource {
  constructor(
    private readonly pool: Pool,
    private readonly network: SolanaNetwork,
  ) {}
  async mints(): Promise<string[]> {
    const r = await this.pool.query<{ mint: string }>(
      `SELECT mint FROM mint_vaults WHERE network = $1
       UNION SELECT mint FROM trades WHERE kind = 'create' AND venue = 'pumpfun'`,
      [this.network],
    );
    return r.rows.map((x) => x.mint);
  }
}

/** RELAYER v8 A6: quote mints of the pool (core's `pool_quotes`); none before core 0019. Errors propagate. */
export class PgPoolQuoteMintSource {
  constructor(
    private readonly pool: Pool,
    private readonly network: SolanaNetwork,
  ) {}
  async mints(): Promise<string[]> {
    const t = await this.pool.query<{ ok: boolean }>(`SELECT to_regclass('pool_quotes') IS NOT NULL AS ok`);
    if (t.rows[0]?.ok !== true) return [];
    const r = await this.pool.query<{ mint: string }>(`SELECT mint FROM pool_quotes WHERE network = $1`, [this.network]);
    return r.rows.map((x) => x.mint);
  }
}

/** Union that FAILS CLOSED (Verify: a source error aborts the snapshot, never under-report). */
export class AllMintSources {
  constructor(private readonly sources: readonly { mints(): Promise<string[]> }[]) {}
  async mints(): Promise<string[]> {
    const all = await Promise.all(this.sources.map((s) => s.mints()));
    return [...new Set(all.flat())];
  }
}

/** Mints pinned in the relayer's file (`mint-vaults.json`, RELAYER_MINT_VAULTS=file / older devnet runs). */
export class FileMintSource {
  constructor(private readonly file: string) {}
  async mints(): Promise<string[]> {
    if (!fs.existsSync(this.file)) return [];
    return Object.keys(JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, string>);
  }
}

/** Highest creator index in use: max of the file counter and the Postgres counter (when readable). */
export async function creatorCount(fileNext: number, pool: Pool | null, network: SolanaNetwork): Promise<number> {
  if (!pool) return fileNext;
  const r = await pool
    .query<{ n: number }>(`SELECT next_index AS n FROM relayer_creator_counter WHERE network = $1`, [network])
    .catch(() => null);
  return Math.max(fileNext, r?.rows[0]?.n ?? 0);
}
