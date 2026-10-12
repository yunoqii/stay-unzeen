import {
  GLOBAL_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurvePda,
  canonicalPumpPoolPda,
  getTokenVaultPda,
  isBondingCurveMigrated,
  type BondingCurve,
  type Global,
} from "@pump-fun/pump-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { priceAndCap } from "../pumpfun";
import type { Rng } from "../relayer/random";
import type { FullIntel } from "./full";
import {
  METAPLEX_METADATA_PROGRAM_ID,
  curveProgress,
  holderStats,
  lpBurnedPct,
  metaplexMetadataPda,
  mintFacts,
  parseMetaplexMetadata,
  parsePumpPool,
  type LargestAccount,
} from "./metrics";
import { fetchOffchain, type OffchainDeps } from "./offchain";
import { isMintAddress, type ChainReader } from "./reader";
import { BATCH_SIZE, MAX_REAL_PER_BATCH, SubscriptionPlanner, assembleBatch, nextTickDelay, pickWarmDue, tickBoundary } from "./schedule";
import type { CurveUpdate, IntelStore, OffchainInfo, TickCommit, TokenCard, TokenSafety } from "./types";

/**
 * Intel indexer (pnpm intel:run), contract: docs/INTEL.md v1.
 *
 * Every tick (uniform 45–75 s, own timer, never woken by a request):
 * 1. a batch of EXACTLY 8 mints is snapshotted, even when the queue is empty:
 *    up to 4 queued CAs, the rest random decoys (recent pump.fun mints and
 *    warm set), shuffled; every mint gets the same calls and its snapshot is
 *    written (real or decoy is never recorded anywhere);
 * 2. up to 20 warm set mints due by snapshot age (5 / 30 min);
 * 3. the curve subscription set changes by a fixed number of additions
 *    (hot warm curves first, decoys fill), curve updates are buffered;
 * 4. everything is written in one transaction (store.commitTick), with
 *    as_of = minute of the tick start and next_tick_at.
 * Logs and TickReport: batch size, warm count, durations, error counts only.
 */

export interface CurveWatcher {
  subscribe(curve: PublicKey, onData: (data: Buffer, slot: number) => void): Promise<number> | number;
  unsubscribe(id: number): Promise<void>;
}

/** accountSubscribe over the read provider's WebSocket (web3.js handles reconnects). */
export class ConnectionCurveWatcher implements CurveWatcher {
  constructor(private readonly connection: Connection) {}
  subscribe(curve: PublicKey, onData: (data: Buffer, slot: number) => void): number {
    return this.connection.onAccountChange(curve, (info, ctx) => onData(info.data, ctx.slot), { commitment: "confirmed", encoding: "base64" });
  }
  async unsubscribe(id: number): Promise<void> {
    await this.connection.removeAccountChangeListener(id).catch(() => undefined);
  }
}

/**
 * Fallback when the read provider's WS is unavailable (Shyft Free: handshake
 * 503 / 429 from our host, 12.10): ONE getMultipleAccounts over the current
 * subscription set every `everyMs` (± jitter), regardless of activity. The
 * set itself still changes only on the tick (SubscriptionPlanner), so the
 * polled address list leaks no more than accountSubscribe would.
 */
export class PollingCurveWatcher implements CurveWatcher {
  private readonly subs = new Map<number, { key: PublicKey; onData: (d: Buffer, slot: number) => void; last: string | null }>();
  private nextId = 1;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly read: Pick<Connection, "getMultipleAccountsInfoAndContext">,
    private readonly rng: Rng,
    private readonly everyMs = 15_000,
    private readonly jitterMs = 3_000,
  ) {}

  subscribe(curve: PublicKey, onData: (data: Buffer, slot: number) => void): number {
    const id = this.nextId++;
    this.subs.set(id, { key: curve, onData, last: null });
    this.ensureLoop();
    return id;
  }

  async unsubscribe(id: number): Promise<void> {
    this.subs.delete(id);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One poll (exported for tests). */
  async poll(): Promise<void> {
    const entries = [...this.subs.values()];
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      const r = await this.read.getMultipleAccountsInfoAndContext(chunk.map((e) => e.key)).catch(() => null);
      if (!r) continue;
      r.value.forEach((info, k) => {
        const e = chunk[k]!;
        if (!info) return;
        const h = info.data.toString("base64");
        if (h === e.last) return;
        e.last = h;
        e.onData(info.data, r.context.slot);
      });
    }
  }

  private ensureLoop(): void {
    if (this.timer) return;
    const loop = () => {
      this.timer = setTimeout(() => {
        void this.poll().finally(() => {
          if (this.timer) loop();
        });
      }, this.everyMs + this.rng.int(-this.jitterMs, this.jitterMs));
      this.timer.unref?.();
    };
    loop();
  }
}

export interface IndexerOptions {
  store: IntelStore;
  reader: ChainReader;
  rng: Rng;
  now?: () => number;
  /** Off-chain metadata (uri JSON, image -> media). null = skip. */
  offchain?: OffchainDeps | null;
  /** Curve updates of hot warm mints. null = none. */
  watcher?: CurveWatcher | null;
  /** INTEL_FULL=1 only. */
  full?: FullIntel | null;
  /** Refresh the decoy pool of recent pump.fun mints every N ticks (and every tick while it is small). */
  decoyRefreshTicks?: number;
  /** Retry failed off-chain fetches (process memory) after this long. */
  offchainRetryMs?: number;
}

/** Counts only: nothing here tells a request from a decoy. */
export interface TickReport {
  tick: number;
  batch: number;
  warm: number;
  saved: number;
  missing: number;
  subsAdded: number;
  subsRemoved: number;
  errors: number;
  ms: number;
  nextInMs: number;
}

const WSOL = "So11111111111111111111111111111111111111112";
const RECENT_MAX = 50;

interface MintState {
  decimals: number;
  onCurve: boolean;
}

/** Public pool facts for T1 and exclusions. */
export interface PoolSets {
  launches: ReadonlySet<string>;
  vaults: ReadonlySet<string>;
  creators: ReadonlySet<string>;
}

export class IntelIndexer {
  private readonly now: () => number;
  private readonly subs: SubscriptionPlanner;
  private readonly subIds = new Map<string, number>(); // curve -> subscription id
  private readonly curveMint = new Map<string, string>(); // curve -> mint
  private readonly state = new Map<string, MintState>();
  private readonly pendingCurves = new Map<string, CurveUpdate>();
  private readonly recent: string[] = []; // decoy pool (recent pump.fun mints)
  private readonly offFailed = new Map<string, number>();
  private readonly firstBlocksDone = new Map<string, NonNullable<TokenSafety["firstBlocks"]>>();
  private readonly createUser = new Map<string, string>();
  private global: Global | null = null;
  private ticks = 0;
  private decoyCursor: string | null = null;

  constructor(private readonly o: IndexerOptions) {
    this.now = o.now ?? Date.now;
    this.subs = new SubscriptionPlanner(o.rng);
  }

  /** One tick. Never throws; returns counts and the delay to the next tick. */
  async tick(): Promise<TickReport> {
    const started = this.now();
    const asOf = tickBoundary(started);
    const nextInMs = nextTickDelay(this.o.rng);
    this.ticks++;
    const report: TickReport = { tick: this.ticks, batch: 0, warm: 0, saved: 0, missing: 0, subsAdded: 0, subsRemoved: 0, errors: 0, ms: 0, nextInMs };
    const commit: TickCommit = {
      asOf,
      tickStartedAt: started,
      nextTickAt: started + nextInMs,
      rows: [],
      cards: [],
      missing: [],
      batch: [],
      consumed: [],
      curveUpdates: [],
      subscriptions: [],
    };
    try {
      const [warm, launches, vaults, creators] = await Promise.all([
        this.o.store.warmSet(),
        this.o.store.unzeenLaunches(),
        this.o.store.poolVaults(),
        this.o.store.poolCreators(),
      ]);
      const pool: PoolSets = { launches, vaults, creators };
      if ((this.ticks - 1) % (this.o.decoyRefreshTicks ?? 10) === 0 || this.recent.length < 2 * BATCH_SIZE) {
        await this.refreshDecoyPool().catch(() => report.errors++);
      }

      // 1. The batch: always 8 when the pools allow it, queue or not.
      const real = [...new Set((await this.o.store.peekLookups(MAX_REAL_PER_BATCH)).filter(isMintAddress))];
      const queued = new Set(real);
      const b = assembleBatch(real, [...this.recent, ...warm.map((w) => w.mint)], this.o.rng, BATCH_SIZE);
      report.batch = b.mints.length;
      if (b.mints.length > 0) {
        try {
          const r = await this.snapshot(b.mints, asOf, pool);
          commit.rows.push(...r.rows);
          commit.cards.push(...r.cards);
          commit.missing.push(...r.missing);
          commit.batch = b.mints.filter((m) => !r.failed.has(m));
          // Malformed queue entries are dropped too (core validates, this is a safety net).
          commit.consumed = real.filter((m) => !r.failed.has(m));
          report.errors += r.failed.size;
        } catch {
          report.errors++; // whole batch failed: nothing written for it, requests stay queued
        }
      }
      const malformed = (await this.o.store.peekLookups(MAX_REAL_PER_BATCH)).filter((m) => !isMintAddress(m) && !queued.has(m));
      commit.consumed.push(...malformed);

      // 2. Warm set by snapshot age.
      const due = pickWarmDue(warm, started, this.o.rng, new Set(b.mints));
      report.warm = due.length;
      for (let i = 0; i < due.length; i += BATCH_SIZE) {
        try {
          const r = await this.snapshot(due.slice(i, i + BATCH_SIZE), asOf, pool);
          commit.rows.push(...r.rows);
          commit.cards.push(...r.cards);
          commit.missing.push(...r.missing);
          report.errors += r.failed.size;
        } catch {
          report.errors++;
        }
      }

      // 3. Subscriptions (hot warm mints on a live curve), buffered curve updates.
      if (this.o.watcher) {
        const s = await this.applySubscriptions(warm.filter((w) => w.hot).map((w) => w.mint), new Set(warm.map((w) => w.mint)));
        report.subsAdded = s.added;
        report.subsRemoved = s.removed;
        commit.subscriptions = [...this.subIds.keys()].map((account) => ({ account, mint: this.curveMint.get(account) ?? "", kind: "pump_curve" as const }));
        const fresh = new Set(commit.rows.map((r) => r.mint));
        commit.curveUpdates = [...this.pendingCurves.values()].filter((u) => !fresh.has(u.mint));
        this.pendingCurves.clear();
      }
    } catch {
      report.errors++;
    }
    // 4. One transaction. Even when everything failed, next_tick_at is published.
    try {
      await this.o.store.commitTick(commit);
      report.saved = commit.rows.length;
      report.missing = commit.missing.length;
    } catch {
      report.errors++;
    }
    report.ms = this.now() - started;
    return report;
  }

  /** Runs ticks until `signal` aborts. `onTick` gets counts only. */
  async run(signal: AbortSignal, onTick: (r: TickReport) => void = () => undefined): Promise<void> {
    while (!signal.aborted) {
      const r = await this.tick();
      onTick(r);
      const delay = Math.max(1_000, r.nextInMs - r.ms);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    }
    for (const id of this.subIds.values()) await this.o.watcher?.unsubscribe(id);
    this.subIds.clear();
  }

  private async refreshDecoyPool(): Promise<void> {
    const small = this.recent.length < 2 * BATCH_SIZE;
    // Small pool (devnet): continue further back in history instead of re-reading the same page.
    const res = await this.o.reader.recentPumpMints(small ? 12 : 5, small ? (this.decoyCursor ?? undefined) : undefined);
    const fresh = Array.isArray(res) ? res : res.mints;
    this.decoyCursor = Array.isArray(res) ? null : small ? res.oldest : null;
    for (const m of fresh) {
      if (m === WSOL || !isMintAddress(m)) continue;
      const i = this.recent.indexOf(m);
      if (i >= 0) this.recent.splice(i, 1);
      this.recent.push(m);
    }
    if (this.recent.length > RECENT_MAX) this.recent.splice(0, this.recent.length - RECENT_MAX);
  }

  /**
   * Same calls for every mint of the group, in the group's (random) order.
   * Per-mint RPC failure -> that mint is in `failed` (no snapshot, request
   * stays queued); a failure of the shared reads throws (whole group).
   */
  async snapshot(
    mints: readonly string[],
    asOf: number,
    ps: PoolSets,
  ): Promise<{ rows: TokenSafety[]; cards: TokenCard[]; missing: string[]; failed: Set<string> }> {
    const vaults = ps.vaults;
    const failed = new Set<string>();
    const pks = mints.map((m) => new PublicKey(m));
    const per = pks.map((mint) => ({ mint, curve: bondingCurvePda(mint), meta: metaplexMetadataPda(mint), pool: canonicalPumpPoolPda(mint) }));
    const accs = await this.o.reader.getMultipleAccounts([GLOBAL_PDA, ...per.flatMap((p) => [p.mint, p.curve, p.meta, p.pool])]);
    const g = accs[0];
    if (g && g.owner.equals(PUMP_PROGRAM_ID)) this.global = safe(() => PUMP_SDK.decodeGlobal(g)) ?? this.global;

    interface Work {
      mint: PublicKey;
      key: string;
      facts: NonNullable<ReturnType<typeof mintFacts>>;
      curvePda: PublicKey;
      curve: BondingCurve | null;
      poolPda: PublicKey;
      pool: ReturnType<typeof parsePumpPool>;
      meta: ReturnType<typeof parseMetaplexMetadata>;
      unzeen: boolean;
      devs: string[];
      devAtas: PublicKey[];
      largest: LargestAccount[] | null;
    }
    const work: Work[] = [];
    const missing: string[] = [];
    per.forEach((p, i) => {
      const a = (k: number) => accs[1 + i * 4 + k] ?? null;
      const key = p.mint.toBase58();
      const facts = mintFacts(p.mint, a(0));
      if (!facts) {
        missing.push(key); // no account / not an SPL mint -> 404 (token_safety.missing)
        return;
      }
      const ci = a(1);
      const curve = ci && ci.owner.equals(PUMP_PROGRAM_ID) ? safe(() => PUMP_SDK.decodeBondingCurveNullable(ci as AccountInfo<Buffer>)) : null;
      const pi = a(3);
      const pool = pi && pi.owner.equals(PUMP_AMM_PROGRAM_ID) ? parsePumpPool(pi.data) : null;
      const mi = a(2);
      const meta = facts.tokenMetadata ?? (mi && mi.owner.equals(METAPLEX_METADATA_PROGRAM_ID) ? parseMetaplexMetadata(mi.data) : null);
      // Unzeen launch (T1): create recorded in trades, OR the curve's creator is one of our
      // derived creator addresses / a pool vault, OR the create was signed by a pool vault
      // (INTEL_FULL) — covers the window before the relayer writes `trades`.
      const creator = curve?.creator.toBase58();
      const signer = this.createUser.get(key);
      const unzeen =
        ps.launches.has(key) ||
        (!!creator && (ps.creators.has(creator) || ps.vaults.has(creator))) ||
        (!!signer && ps.vaults.has(signer));
      // T1: no dev for Unzeen launches, not even computed. Dev = CreateEvent.user (INTEL_FULL) and BondingCurve.creator.
      const devs = unzeen
        ? []
        : [...new Set([this.createUser.get(key), curve?.creator.toBase58()].filter((d): d is string => !!d && d !== PublicKey.default.toBase58()))];
      const devAtas = devs.map((d) => getAssociatedTokenAddressSync(p.mint, new PublicKey(d), true, facts.tokenProgram));
      work.push({ mint: p.mint, key, facts, curvePda: p.curve, curve, poolPda: p.pool, pool, meta, unzeen, devs, devAtas, largest: null });
    });

    // Index provider: one getTokenLargestAccounts per mint, decoys included.
    if (this.o.reader.hasIndex) {
      for (const w of work) {
        try {
          w.largest = await this.o.reader.getTokenLargestAccounts(w.mint);
        } catch {
          failed.add(w.key);
        }
      }
    }

    // Owners of the largest accounts, dev ATAs, LP mints: one batched read.
    const second: PublicKey[] = [];
    const idx = new Map<string, number>();
    const want = (k: PublicKey) => {
      const s = k.toBase58();
      if (!idx.has(s)) {
        idx.set(s, second.length);
        second.push(k);
      }
    };
    for (const w of work) {
      if (failed.has(w.key)) continue;
      for (const l of w.largest ?? []) want(new PublicKey(l.address));
      if (w.largest) w.devAtas.forEach(want);
      if (w.pool) want(w.pool.lpMint);
    }
    const accs2 = second.length > 0 ? await this.o.reader.getMultipleAccounts(second) : [];
    const acc2 = (k: PublicKey | string) => accs2[idx.get(typeof k === "string" ? k : k.toBase58()) ?? -1] ?? null;

    const rows: TokenSafety[] = [];
    const cards: TokenCard[] = [];
    for (const w of work) {
      if (failed.has(w.key)) continue;
      try {
        const { row, card } = await this.buildRow(w, asOf, vaults, acc2);
        rows.push(row);
        cards.push(card);
      } catch {
        failed.add(w.key);
      }
    }
    return { rows, cards, missing, failed };
  }

  private async buildRow(
    w: {
      mint: PublicKey;
      key: string;
      facts: NonNullable<ReturnType<typeof mintFacts>>;
      curvePda: PublicKey;
      curve: BondingCurve | null;
      poolPda: PublicKey;
      pool: ReturnType<typeof parsePumpPool>;
      meta: ReturnType<typeof parseMetaplexMetadata>;
      unzeen: boolean;
      devs: string[];
      devAtas: PublicKey[];
      largest: LargestAccount[] | null;
    },
    asOf: number,
    vaults: ReadonlySet<string>,
    acc2: (k: PublicKey | string) => AccountInfo<Buffer> | null,
  ): Promise<{ row: TokenSafety; card: TokenCard }> {
    const onCurve = !!w.curve && !(w.curve.complete || isBondingCurveMigrated(w.curve));
    const status: TokenSafety["market"]["status"] = w.curve ? (onCurve ? "curve" : "graduated") : w.pool ? "graduated" : "unknown";
    const market: TokenSafety["market"] = { venue: w.curve || w.pool ? "pumpfun" : null, status };
    if (w.curve && onCurve && this.global) market.curveProgressPct = curveProgress(w.curve, this.global).progressPct;
    this.state.set(w.key, { decimals: w.facts.decimals, onCurve });
    if (w.pool) {
      const lpm = acc2(w.pool.lpMint);
      const lpSupply = lpm && lpm.data.length >= 44 ? lpm.data.readBigUInt64LE(36) : null;
      const burned = lpSupply !== null ? lpBurnedPct(w.pool.lpSupply, lpSupply) : undefined;
      if (burned !== undefined) market.lpBurnedPct = burned;
    }

    const row: TokenSafety = {
      mint: w.key,
      asOf,
      program: w.facts.program,
      authorities: {
        mintRevoked: w.facts.mintRevoked,
        freezeRevoked: w.facts.freezeRevoked,
        metadataImmutable: w.meta ? w.meta.immutable : null,
        riskyExtensions: w.facts.riskyExtensions,
      },
      market,
    };
    if (w.meta?.name) row.name = w.meta.name.slice(0, 64);
    if (w.meta?.symbol) row.symbol = w.meta.symbol.slice(0, 16);
    if (w.unzeen) row.unzeen = { launch: true };

    if (w.largest) {
      const owners = new Map<string, string>();
      for (const l of w.largest) {
        const ta = acc2(l.address);
        if (ta && ta.data.length >= 64) owners.set(l.address, new PublicKey(ta.data.subarray(32, 64)).toBase58());
      }
      let devBalance: bigint | null = null;
      for (const ata of w.devAtas) {
        const ta = acc2(ata);
        if (ta && ta.data.length >= 72) devBalance = (devBalance ?? 0n) + ta.data.readBigUInt64LE(64);
      }
      const curveAta = getAssociatedTokenAddressSync(w.mint, w.curvePda, true, w.facts.tokenProgram).toBase58();
      const stats = holderStats({
        largest: w.largest,
        owners,
        supply: w.facts.supply,
        excludedOwners: new Set([w.curvePda.toBase58(), w.poolPda.toBase58()]),
        excludedAccounts: new Set([curveAta, getTokenVaultPda(w.mint).toBase58(), ...(w.pool ? [w.pool.baseVault.toBase58()] : [])]),
        poolVaults: vaults,
        devOwners: new Set(w.devs),
        devBalance,
      });
      row.holders = { ...stats, devPct: w.unzeen ? null : stats.devPct, asOf };
    }

    const off = await this.offchainFor(w.key, w.meta?.uri ?? null);
    if (off?.socials) row.socials = off.socials;
    if (off?.image) row.image = off.image;

    if (this.o.full && w.curve) await this.fullTier(w.mint, w.key, w.facts.supply, vaults, row, w.unzeen);

    const pc = w.curve && onCurve ? priceAndCap(w.curve, w.facts.decimals) : { priceSol: "0", marketCapSol: "0" };
    const card: TokenCard = {
      mint: w.key,
      venue: w.curve || w.pool ? "pumpfun" : "jupiter",
      symbol: row.symbol ?? "",
      name: row.name ?? "",
      image: row.image ?? null,
      decimals: w.facts.decimals,
      status: status === "curve" ? "curve" : "graduated",
      priceSol: pc.priceSol,
      marketCapSol: pc.marketCapSol,
      createdAt: asOf,
    };
    return { row, card };
  }

  private async offchainFor(mint: string, uri: string | null): Promise<OffchainInfo | null> {
    if (!this.o.offchain || !uri) return null;
    const cached = await this.o.store.offchain(mint);
    if (cached) return cached;
    const failedAt = this.offFailed.get(mint);
    if (failedAt !== undefined && this.now() - failedAt < (this.o.offchainRetryMs ?? 6 * 3600_000)) return null;
    const info = await fetchOffchain(uri, this.o.offchain).catch(() => ({ fetchedAt: this.now(), ok: false }) as OffchainInfo);
    if (!info.ok) this.offFailed.set(mint, this.now());
    else this.offFailed.delete(mint);
    return info;
  }

  /** INTEL_FULL=1 only: first blocks once per mint, dev history (never for Unzeen launches, T1). */
  private async fullTier(mint: PublicKey, key: string, supply: bigint, vaults: ReadonlySet<string>, row: TokenSafety, isUnzeen: boolean): Promise<void> {
    let unzeen = isUnzeen;
    const full = this.o.full!;
    if (!this.firstBlocksDone.has(key)) {
      const r = await full.firstBlocks(mint, { supply, poolVaults: vaults, unzeenLaunch: unzeen }).catch(() => null);
      if (r) {
        this.firstBlocksDone.set(key, r.firstBlocks);
        if (r.createUser) this.createUser.set(key, r.createUser);
      }
    }
    // Create signed by a pool vault: an Unzeen launch found only now (T1). Drop every dev field.
    const signer = this.createUser.get(key);
    if (!unzeen && signer && vaults.has(signer)) {
      unzeen = true;
      row.unzeen = { launch: true };
      if (row.holders) row.holders.devPct = null;
    }
    const fb = this.firstBlocksDone.get(key);
    if (fb) row.firstBlocks = unzeen ? { ...fb, unzeenLaunchBuy: true } : fb;
    if (unzeen) return;
    const dev = this.createUser.get(key);
    if (dev) {
      const h = await full.devHistory(dev).catch(() => null);
      if (h) row.dev = h;
    }
  }

  private async applySubscriptions(hotMints: readonly string[], warmMints: ReadonlySet<string>): Promise<{ added: number; removed: number }> {
    const watcher = this.o.watcher!;
    const desired = new Set<string>();
    for (const m of hotMints) {
      if (!this.state.get(m)?.onCurve) continue;
      const c = bondingCurvePda(new PublicKey(m)).toBase58();
      this.curveMint.set(c, m);
      desired.add(c);
    }
    const decoyCurves = this.recent.filter((m) => !warmMints.has(m)).map((m) => {
      const c = bondingCurvePda(new PublicKey(m)).toBase58();
      this.curveMint.set(c, m);
      return c;
    });
    const plan = this.subs.tick(desired, decoyCurves);
    for (const c of plan.remove) {
      const id = this.subIds.get(c);
      if (id !== undefined) await watcher.unsubscribe(id);
      this.subIds.delete(c);
    }
    for (const c of plan.add) {
      const id = await watcher.subscribe(new PublicKey(c), (data, slot) => this.onCurveData(c, data, slot));
      this.subIds.set(c, id);
    }
    return { added: plan.add.length, removed: plan.remove.length };
  }

  /** Buffered until the next tick's transaction (INTEL.md privacy rule 5). Decoy updates are dropped. */
  private onCurveData(curveKey: string, data: Buffer, slot: number): void {
    if (this.subs.isDecoy(curveKey)) return;
    const mint = this.curveMint.get(curveKey);
    const st = mint ? this.state.get(mint) : undefined;
    if (!mint || !st || !this.global) return;
    const curve = safe(() => PUMP_SDK.decodeBondingCurve({ data, owner: PUMP_PROGRAM_ID, executable: false, lamports: 0 }));
    if (!curve) return;
    const p = curveProgress(curve, this.global);
    const pc = priceAndCap(curve, st.decimals);
    const prev = this.pendingCurves.get(mint);
    if (prev && prev.slot > slot) return;
    this.pendingCurves.set(mint, {
      mint,
      progressPct: p.progressPct,
      graduated: p.graduated || isBondingCurveMigrated(curve),
      priceSol: pc.priceSol,
      marketCapSol: pc.marketCapSol,
      slot,
    });
  }
}

function safe<T>(f: () => T): T | null {
  try {
    return f() ?? null;
  } catch {
    return null;
  }
}
