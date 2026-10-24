import { GLOBAL_PDA, PUMP_PROGRAM_ID, PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda, isLegacyQuoteMint, normalizeQuoteMint, type Global } from "@pump-fun/pump-sdk";
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DAMM_V2_PROGRAM_ID, createDammV2Program, deriveDammV2PoolAddress, type PoolConfig, type VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection, PublicKey, type AccountInfo, type Logs, type VersionedTransactionResponse } from "@solana/web3.js";
import type BN from "bn.js";
import { extractCreateEvents } from "../events";
import { DBC_PROGRAM_ID, dbcCoder, dbcPriceAndCap, dbcProgressPct, dbcStatus } from "../meteora";
import { curveStatus, priceAndCap } from "../pumpfun";
import type { Rng } from "../relayer/random";
import { ammPriceAndCap, curveProgress, metaplexMetadataPda, mintFacts, parseMetaplexMetadata, parsePumpPool, pumpPoolQuoteMint, tokenAccountAmount } from "./metrics";
import { LaunchpadPool, getPdaLaunchpadPoolId } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT } from "@solana/spl-token";
import { formatUnits } from "../math";
import { launchLabProgress } from "./curves";
import { nextTickDelay, tickBoundary } from "./schedule";

/**
 * Discovery mode of /tokens (FEATURES.md 9, decision 13.10): ALL fresh tokens of
 * pump.fun and Meteora DBC, not only pool tokens. OFF unless INTEL_DISCOVERY=1
 * (it costs provider credits); on for the video and tests.
 *
 * Privacy: a pure public stream. Nothing here depends on users: no request, no
 * view, no search ever triggers a read. Candidates come from the chain; the
 * fast pass (~4 s, own timer) admits new creates and reads only their metrics,
 * the metrics pass (45–75 s, own timer) reads the whole candidate set at once.
 * Logs carry counts only (one aggregated line per metrics pass).
 *
 * Sources (measured on mainnet 13.10, read-only):
 * - pump.fun: every create / create_v2 touches the `mint-authority` PDA and
 *   nothing else does (~1 400 creates/h). Default: poll that PDA's signatures
 *   once per tick and fetch only the creates we accept (quota). Optional:
 *   logsSubscribe(mentions = that PDA): CreateEvent is in the logs ("Program
 *   data:"), no extra request (~13 MB/h of WS data on Helius = ~270 credits/h).
 * - Meteora DBC: no create-only account (~69 000 program tx/h), so neither
 *   polling nor logsSubscribe is affordable. Helius Parsed Streams
 *   (`parsedTransactionSubscribe`, programs = DBC, instructionNames =
 *   initialize_virtual_pool_*) pushes only creates, 1 credit per event.
 *
 * Limits: at most `max` candidates in the `windowMs` window (default 200 / 6 h),
 * admitted through a token bucket (smooth ~33/h, burst 10), newest first.
 */

export type DiscoveryVenue = "pumpfun" | "meteora-dbc" | "raydium-launchlab";

/** A create seen on chain (public). `mint` may be unknown until resolved (pump poll). */
export interface CreateSeen {
  /** LaunchLab creates are discovery candidates only with `launchLabProgram` set (API v0.28); always in the dev index. */
  venue: DiscoveryVenue;
  /** Launcher (pump: CreateEvent.user; DBC / LaunchLab: the instruction's `creator`), for the dev index. */
  creator?: string;
  signature: string;
  slot: number;
  /** unix ms (event timestamp / blockTime); null = unknown. */
  createdAt: number | null;
  mint?: string;
  name?: string;
  symbol?: string;
  /** DBC: pool + config (metrics). */
  pool?: string;
  config?: string;
}

/** Public candidate row (proposed core table `intel_discovery`). */
export interface DiscoveryCandidate {
  mint: string;
  venue: DiscoveryVenue;
  /** unix ms. */
  createdAt: number;
  name: string | null;
  symbol: string | null;
  status: "curve" | "graduated";
  priceSol: string;
  marketCapSol: string;
  /** 0..100, 2 decimals; null after graduation / unknown. */
  progressPct: string | null;
  /** Minute of the tick that read these metrics (unix ms). */
  asOf: number;
  /** DBC only (not public API): where the metrics come from. */
  pool?: string;
  config?: string;
}

export interface DiscoveryCommit {
  asOf: number;
  upserts: DiscoveryCandidate[];
  /** Left the window (or vanished): deleted. */
  removed: string[];
}

/** Where candidates live (core: `intel_discovery`; until then memory). */
export interface DiscoveryStore {
  /** Candidates of this network (restart continuity). */
  load(): Promise<DiscoveryCandidate[]>;
  /** ONE transaction per tick. */
  commit(c: DiscoveryCommit): Promise<void>;
}

export class MemoryDiscoveryStore implements DiscoveryStore {
  readonly rows = new Map<string, DiscoveryCandidate>();
  commits = 0;
  async load(): Promise<DiscoveryCandidate[]> {
    return [...this.rows.values()];
  }
  async commit(c: DiscoveryCommit): Promise<void> {
    for (const m of c.removed) this.rows.delete(m);
    for (const r of c.upserts) this.rows.set(r.mint, { ...r });
    this.commits++;
  }
  /** What the public list would show: newest first. */
  list(): DiscoveryCandidate[] {
    return [...this.rows.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}

/** A stream of creates. `drain` is called once per tick and returns what arrived since. */
export interface CreateSource {
  readonly name: string;
  drain(): Promise<CreateSeen[]>;
  stop?(): void;
}

export interface DiscoveryChain {
  getMultipleAccounts(keys: readonly PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]>;
  /**
   * Log messages of a confirmed tx (pump poll: the CreateEvent is in "Program
   * data:"). Must accept v1 transactions (seen on mainnet 13.10). null = not readable.
   */
  getLogs(signature: string): Promise<string[] | null>;
}

/** pump CreateEvent from plain log lines (shared by the WS and poll sources). */
function createEventFromLogs(logs: readonly string[]) {
  const fake = { meta: { logMessages: logs, innerInstructions: null }, transaction: { message: { getAccountKeys: () => ({ get: () => undefined }) } } };
  return extractCreateEvents(fake as unknown as VersionedTransactionResponse, PUMP_PROGRAM_ID)[0];
}

export const PUMP_MINT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PUMP_PROGRAM_ID)[0];

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

/**
 * pump.fun by polling the `mint-authority` PDA (create-only): ONE
 * getSignaturesForAddress per tick (newest first, up to `limit`, `until` the
 * newest seen). Mints are resolved later, only for admitted creates.
 */
export class PumpPollSource implements CreateSource {
  readonly name = "pump-poll";
  private cursor: string | null = null;
  constructor(
    private readonly conn: Pick<Connection, "getSignaturesForAddress">,
    private readonly limit = 50,
  ) {}
  async drain(): Promise<CreateSeen[]> {
    const sigs = await this.conn.getSignaturesForAddress(PUMP_MINT_AUTHORITY, { limit: this.limit, ...(this.cursor ? { until: this.cursor } : {}) }, "confirmed");
    if (sigs[0]) this.cursor = sigs[0].signature;
    return sigs
      .filter((s) => s.err === null)
      .map((s) => ({ venue: "pumpfun" as const, signature: s.signature, slot: s.slot, createdAt: s.blockTime ? s.blockTime * 1000 : null }));
  }
}

/** pump.fun CreateEvent from "Program data:" log lines (no extra request). */
export function pumpCreateFromLogs(logs: Logs): CreateSeen | null {
  if (logs.err !== null) return null;
  const ev = createEventFromLogs(logs.logs);
  if (!ev) return null;
  const ts = Number(ev.timestamp?.toString?.(10) ?? 0);
  return {
    venue: "pumpfun",
    signature: logs.signature,
    slot: 0,
    createdAt: ts > 0 ? ts * 1000 : null,
    mint: ev.mint.toBase58(),
    name: ev.name,
    symbol: ev.symbol,
    creator: ev.user.toBase58(),
  };
}

/** pump.fun via logsSubscribe(mentions = mint-authority PDA): creates only, parsed from logs. Bounded buffer. */
export class PumpLogsSource implements CreateSource {
  readonly name = "pump-logs";
  private buf: CreateSeen[] = [];
  private id: number | null = null;
  constructor(
    private readonly conn: Pick<Connection, "onLogs" | "removeOnLogsListener">,
    private readonly maxBuffer = 500,
  ) {
    this.id = conn.onLogs(PUMP_MINT_AUTHORITY, (l, ctx) => {
      const c = pumpCreateFromLogs(l);
      if (!c) return;
      this.buf.push({ ...c, slot: ctx.slot });
      if (this.buf.length > this.maxBuffer) this.buf.splice(0, this.buf.length - this.maxBuffer);
    }, "confirmed");
  }
  async drain(): Promise<CreateSeen[]> {
    const out = this.buf;
    this.buf = [];
    return out;
  }
  stop(): void {
    if (this.id !== null) void this.conn.removeOnLogsListener(this.id).catch(() => undefined);
    this.id = null;
  }
}

/** Instruction names of DBC pool creation (Helius catalog matches case/separator-insensitively). */
export const DBC_CREATE_IX = [
  "initialize_virtual_pool_with_spl_token",
  "initialize_virtual_pool_with_token2022",
  "initialize_virtual_pool_with_token2022_transfer_hook",
] as const;

export function dbcStreamRequest(): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "parsedTransactionSubscribe",
    params: [
      { programs: [DBC_PROGRAM_ID.toBase58()], instructionNames: [...DBC_CREATE_IX], includeFailed: false, includeCpi: true },
      // "matched": only the create instruction (decoded accounts), ~3x smaller than "full".
      { commitment: "confirmed", details: "matched" },
    ],
  };
}

/** A Parsed Streams notification -> DBC creates (base_mint / pool / config from decoded accounts). */
export function dbcCreatesFromNotification(msg: unknown): CreateSeen[] {
  const m = msg as { method?: string; params?: { result?: { context?: { slot?: number }; value?: unknown } } };
  if (m?.method !== "parsedTransactionNotification") return [];
  const v = m.params?.result?.value as
    | {
        transaction?: { signature?: string; slot?: number; blockTime?: number | null; status?: string };
        instructions?: Array<{ programId?: string; instructionName?: string; decoded?: { accounts?: Array<{ name?: string; pubkey?: string }>; args?: unknown } }>;
      }
    | undefined;
  const tx = v?.transaction;
  if (!tx?.signature || (tx.status && tx.status !== "ok")) return [];
  const out: CreateSeen[] = [];
  for (const ix of v?.instructions ?? []) {
    if (ix.programId !== DBC_PROGRAM_ID.toBase58()) continue;
    const name = (ix.instructionName ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!DBC_CREATE_IX.some((n) => n.replace(/_/g, "") === name)) continue;
    const acc = (k: string) => ix.decoded?.accounts?.find((a) => a.name === k)?.pubkey;
    const mint = acc("base_mint");
    if (!mint || !isKey(mint)) continue;
    const args = (ix.decoded?.args ?? {}) as { params?: { name?: unknown; symbol?: unknown }; name?: unknown; symbol?: unknown };
    const nm = args.params?.name ?? args.name;
    const sy = args.params?.symbol ?? args.symbol;
    const pool = acc("pool");
    const config = acc("config");
    const creator = acc("creator");
    out.push({
      ...(creator && isKey(creator) ? { creator } : {}),
      venue: "meteora-dbc",
      signature: tx.signature,
      slot: tx.slot ?? m.params?.result?.context?.slot ?? 0,
      createdAt: tx.blockTime ? tx.blockTime * 1000 : null,
      mint,
      ...(typeof nm === "string" ? { name: nm.slice(0, 64) } : {}),
      ...(typeof sy === "string" ? { symbol: sy.slice(0, 16) } : {}),
      ...(pool && isKey(pool) ? { pool } : {}),
      ...(config && isKey(config) ? { config } : {}),
    });
  }
  return out;
}

/** Raydium LaunchLab pool creation (Helius catalog names). */
export const LAUNCHLAB_CREATE_IX = ["initialize", "initialize_v2", "initialize_with_token_2022"] as const;
export const LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

export function launchLabStreamRequest(): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "parsedTransactionSubscribe",
    params: [
      { programs: [LAUNCHLAB_PROGRAM], instructionNames: [...LAUNCHLAB_CREATE_IX], includeFailed: false, includeCpi: true },
      { commitment: "confirmed", details: "matched" },
    ],
  };
}

/** A Parsed Streams notification -> LaunchLab creates (base_mint / creator / pool_state; mainnet sample 13.10). */
export function launchLabCreatesFromNotification(msg: unknown): CreateSeen[] {
  const m = msg as { method?: string; params?: { result?: { context?: { slot?: number }; value?: unknown } } };
  if (m?.method !== "parsedTransactionNotification") return [];
  const v = m.params?.result?.value as
    | { transaction?: { signature?: string; slot?: number; blockTime?: number | null; status?: string }; instructions?: Array<{ programId?: string; instructionName?: string; decoded?: { accounts?: Array<{ name?: string; pubkey?: string }>; args?: unknown } }> }
    | undefined;
  const tx = v?.transaction;
  if (!tx?.signature || (tx.status && tx.status !== "ok")) return [];
  const out: CreateSeen[] = [];
  for (const ix of v?.instructions ?? []) {
    if (ix.programId !== LAUNCHLAB_PROGRAM) continue;
    const name = (ix.instructionName ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!LAUNCHLAB_CREATE_IX.some((n) => n.replace(/_/g, "") === name)) continue;
    const acc = (k: string) => ix.decoded?.accounts?.find((a) => a.name === k)?.pubkey;
    const mint = acc("base_mint");
    const creator = acc("creator");
    if (!mint || !isKey(mint)) continue;
    const p = (ix.decoded?.args ?? {}) as { base_mint_param?: { name?: unknown; symbol?: unknown } };
    out.push({
      venue: "raydium-launchlab",
      signature: tx.signature,
      slot: tx.slot ?? m.params?.result?.context?.slot ?? 0,
      createdAt: tx.blockTime ? tx.blockTime * 1000 : null,
      mint,
      ...(creator && isKey(creator) ? { creator } : {}),
      ...(typeof p.base_mint_param?.name === "string" ? { name: p.base_mint_param.name.slice(0, 64) } : {}),
      ...(typeof p.base_mint_param?.symbol === "string" ? { symbol: p.base_mint_param.symbol.slice(0, 16) } : {}),
    });
  }
  return out;
}

type WsLike = {
  send(d: string): void;
  close(): void;
  addEventListener(t: "open" | "message" | "close" | "error", f: (e: { data?: unknown }) => void): void;
};

/**
 * DBC creates over Helius Parsed Streams (WS, 1 credit per delivered create).
 * Reconnects with backoff; a hard cap of events per hour (budget guard)
 * closes the stream until the next hour. The URL carries the API key: never logged.
 */
export class DbcStreamSource implements CreateSource {
  readonly name: string = "dbc-stream";
  private buf: CreateSeen[] = [];
  private ws: WsLike | null = null;
  private stopped = false;
  private hourStart = 0;
  private hourEvents = 0;
  private backoffMs = 5_000;
  private pausedUntil = 0;
  /** Diagnostics (counts only). */
  events = 0;
  reconnects = 0;

  constructor(
    private readonly url: string,
    private readonly o: {
      maxPerHour?: number;
      maxBuffer?: number;
      now?: () => number;
      connect?: (url: string) => WsLike;
      /** Another venue's creates over the same transport (default: DBC). */
      request?: unknown;
      parse?: (msg: unknown) => CreateSeen[];
      name?: string;
    } = {},
  ) {
    if (o.name) (this as { name: string }).name = o.name;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    const now = (this.o.now ?? Date.now)();
    if (now < this.pausedUntil) {
      setTimeout(() => this.open(), this.pausedUntil - now).unref?.();
      return;
    }
    const ws = (this.o.connect ?? ((u: string) => new WebSocket(u) as unknown as WsLike))(this.url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.backoffMs = 5_000;
      ws.send(JSON.stringify(this.o.request ?? dbcStreamRequest()));
    });
    ws.addEventListener("message", (e) => this.onMessage(e.data));
    ws.addEventListener("close", () => {
      if (this.ws !== ws || this.stopped) return;
      this.ws = null;
      this.reconnects++;
      const wait = Math.max(this.backoffMs, this.pausedUntil - (this.o.now ?? Date.now)());
      this.backoffMs = Math.min(this.backoffMs * 2, 300_000);
      setTimeout(() => this.open(), wait).unref?.();
    });
    ws.addEventListener("error", () => undefined); // close follows
  }

  /** Exposed for tests. */
  onMessage(data: unknown): void {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8"));
    } catch {
      return;
    }
    const creates = (this.o.parse ?? dbcCreatesFromNotification)(msg);
    if (creates.length === 0) return;
    const now = (this.o.now ?? Date.now)();
    if (now - this.hourStart >= 3_600_000) {
      this.hourStart = now;
      this.hourEvents = 0;
    }
    this.hourEvents++;
    this.events++;
    for (const c of creates) this.buf.push(c);
    const maxBuf = this.o.maxBuffer ?? 500;
    if (this.buf.length > maxBuf) this.buf.splice(0, this.buf.length - maxBuf);
    if (this.hourEvents >= (this.o.maxPerHour ?? 600)) {
      // Budget guard: stop paying for events until the hour is over.
      this.pausedUntil = this.hourStart + 3_600_000;
      this.ws?.close();
    }
  }

  async drain(): Promise<CreateSeen[]> {
    const out = this.buf;
    this.buf = [];
    return out;
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }
}

// ---------------------------------------------------------------------------
// discovery tick
// ---------------------------------------------------------------------------

export interface DiscoveryOptions {
  store: DiscoveryStore;
  chain: DiscoveryChain;
  /** Reads of the metrics pass (all candidates); default `chain`. Own limiter so a long batch never delays the fast pass. */
  metricsChain?: DiscoveryChain;
  sources: CreateSource[];
  rng: Rng;
  now?: () => number;
  /** Max candidates in the window (INTEL_DISCOVERY_MAX, default 200). */
  max?: number;
  /** Window (INTEL_DISCOVERY_WINDOW_H, default 6 h). */
  windowMs?: number;
  /** Admission bucket size (INTEL_DISCOVERY_BURST, default 10). */
  burst?: number;
  /** Fast pass period (INTEL_DISCOVERY_TICK_SECS, default 4 s), +-25 % jitter. */
  passMs?: number;
  /** Raydium LaunchLab program (API v0.28 Pulse): LaunchLab creates become candidates (SOL pools only). null = dev index only. */
  launchLabProgram?: PublicKey | null;
  /** Every create drained this tick (all venues, before admission): the dev index (INTEL_FULL). */
  onCreates?: (creates: readonly CreateSeen[]) => Promise<void> | void;
}

/** Counts only. */
export interface DiscoveryReport {
  tick: number;
  seen: number;
  admitted: number;
  active: number;
  removed: number;
  reads: number;
  errors: number;
  ms: number;
  nextInMs: number;
  /** Fast passes folded into this report (run()). */
  passes?: number;
  /** Admission delay after the on-chain create (public timestamps): mean / max ms of the admitted ones. */
  lagAvgMs?: number;
  lagMaxMs?: number;
}

interface Tracked extends DiscoveryCandidate {
  decimals: number;
  supply: bigint | null;
  /** Graduated pump.fun: PumpSwap pool vaults (base, quote), read once from the pool account. */
  ammVaults?: [string, string];
  /** Metrics read once (the venue account is what the create said). Unverified rows are never published. */
  verified: boolean;
}

export const DISCOVERY_PASS_MS = 4_000;

/**
 * Two passes (24.10). Fast pass (`collect`, every ~4 s): drain the create
 * sources, admit through the token bucket, read metrics of the admitted ones
 * only (one small batch) and commit them, so a new token is in
 * `intel_discovery` (Pulse) seconds after its create. Metrics pass (`refresh`,
 * 45–75 s): window, metrics of every candidate in one batched read, one commit.
 * Both are timers of their own; neither depends on users.
 */
export class Discovery {
  private readonly now: () => number;
  private readonly max: number;
  private readonly windowMs: number;
  private readonly burst: number;
  private readonly passMs: number;
  private allowance: number;
  private lastRefill: number;
  private readonly active = new Map<string, Tracked>();
  /** Signatures / mints already handled inside the window (dedupe across sources and ticks). */
  private readonly seen = new Map<string, number>();
  private readonly configs = new Map<string, PoolConfig>();
  private global: Global | null = null;
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private ticks = 0;

  constructor(private readonly o: DiscoveryOptions) {
    this.now = o.now ?? Date.now;
    this.max = o.max ?? 200;
    this.windowMs = o.windowMs ?? 6 * 3_600_000;
    this.burst = o.burst ?? 10;
    this.passMs = o.passMs ?? DISCOVERY_PASS_MS;
    if (this.max < 1 || this.windowMs < 60_000 || this.burst < 1 || this.passMs < 1_000) throw new RangeError("bad discovery limits");
    this.allowance = this.burst;
    this.lastRefill = this.now();
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      for (const c of await this.o.store.load()) this.active.set(c.mint, { ...c, decimals: 6, supply: null, verified: true });
    })().catch((e) => {
      this.loading = null;
      throw e;
    });
    return this.loading;
  }

  /** Store writes never overlap (fast and metrics pass run on their own timers). */
  private commit(c: DiscoveryCommit): Promise<void> {
    const w = this.writing.then(() => this.o.store.commit(c));
    this.writing = w.catch(() => undefined);
    return w;
  }

  /** Both passes once (smoke test, tests). Never throws. */
  async tick(): Promise<DiscoveryReport> {
    const a = await this.collect({ readFresh: false });
    const b = await this.refresh();
    return { ...b, seen: a.seen, admitted: a.admitted, reads: a.reads + b.reads, errors: a.errors + b.errors, ms: a.ms + b.ms, ...(a.lagMaxMs !== undefined ? { lagAvgMs: a.lagAvgMs, lagMaxMs: a.lagMaxMs } : {}) };
  }

  /** Fast pass: new creates -> admission -> metrics of the admitted -> commit of the admitted. Never throws. */
  async collect(opt: { readFresh?: boolean } = {}): Promise<DiscoveryReport> {
    const started = this.now();
    const asOf = tickBoundary(started);
    const r: DiscoveryReport = { tick: this.ticks, seen: 0, admitted: 0, active: 0, removed: 0, reads: 0, errors: 0, ms: 0, nextInMs: this.passMs + this.o.rng.int(-this.passMs / 4, this.passMs / 4) };
    try {
      await this.load();
      const horizon = started - this.windowMs;
      // 1. New creates from every source (a failing source does not stop the others).
      const fresh: CreateSeen[] = [];
      const drained: CreateSeen[] = [];
      for (const s of this.o.sources) {
        try {
          for (const c of await s.drain()) {
            drained.push(c);
            if (c.venue === "raydium-launchlab" && !this.o.launchLabProgram) continue; // dev index only
            if (this.seen.has(c.signature) || (c.mint && (this.seen.has(c.mint) || this.active.has(c.mint)))) continue;
            if (c.createdAt !== null && c.createdAt < horizon) continue;
            fresh.push(c);
          }
          if (s.name === "pump-poll") r.reads++;
        } catch {
          r.errors++;
        }
      }
      r.seen = fresh.length;
      if (this.o.onCreates && drained.length > 0) await Promise.resolve(this.o.onCreates(drained)).catch(() => r.errors++);

      // 2. Admission: token bucket (max / window), never above `max` active; newest first.
      this.refill(started);
      fresh.sort((a, b) => (b.createdAt ?? started) - (a.createdAt ?? started));
      const admitted: Tracked[] = [];
      for (const c of fresh) {
        if (this.allowance < 1 || this.active.size + admitted.length >= this.max) break;
        this.seen.set(c.signature, started);
        let full = c;
        if (!full.mint) {
          r.reads++;
          const logs = await this.o.chain.getLogs(c.signature).catch(() => null);
          const ev = logs ? createEventFromLogs(logs) : undefined;
          if (!ev) {
            r.errors++;
            continue; // unreadable: skipped, costs no allowance
          }
          const ts = Number(ev.timestamp?.toString?.(10) ?? 0);
          full = { ...c, mint: ev.mint.toBase58(), name: ev.name, symbol: ev.symbol, createdAt: ts > 0 ? ts * 1000 : c.createdAt };
        }
        const mint = full.mint!;
        if (this.seen.has(mint) || this.active.has(mint)) continue;
        this.seen.set(mint, started);
        this.allowance -= 1;
        admitted.push({
          mint,
          venue: full.venue,
          createdAt: full.createdAt ?? asOf,
          name: clean(full.name),
          symbol: clean(full.symbol),
          status: "curve",
          priceSol: "0",
          marketCapSol: "0",
          progressPct: "0.00",
          asOf,
          decimals: 6,
          supply: null,
          verified: false,
          ...(full.pool ? { pool: full.pool } : {}),
          ...(full.config ? { config: full.config } : {}),
        });
      }
      for (const a of admitted) this.active.set(a.mint, a);
      r.admitted = admitted.length;

      // 3. Metrics of the admitted only (one small batch), then their commit.
      if (opt.readFresh !== false && admitted.length > 0) {
        const reads = await this.refreshMetrics(this.o.chain, asOf, admitted);
        r.reads += reads.calls;
        r.errors += reads.errors;
        for (const m of reads.gone) this.active.delete(m);
        const ok = admitted.filter((a) => a.verified && this.active.has(a.mint));
        if (ok.length > 0) {
          await this.commit({ asOf, upserts: ok.map(publicRow), removed: [] });
          const t = this.now();
          const lags = ok.map((a) => Math.max(0, t - a.createdAt));
          r.lagMaxMs = Math.max(...lags);
          r.lagAvgMs = Math.round(lags.reduce((x, y) => x + y, 0) / lags.length);
        }
      }
    } catch {
      r.errors++;
    }
    r.active = this.active.size;
    r.ms = this.now() - started;
    return r;
  }

  /** Metrics pass: window, metrics of EVERY candidate (one batched read), one commit. Never throws. */
  async refresh(): Promise<DiscoveryReport> {
    const started = this.now();
    const asOf = tickBoundary(started);
    const nextInMs = nextTickDelay(this.o.rng);
    this.ticks++;
    const r: DiscoveryReport = { tick: this.ticks, seen: 0, admitted: 0, active: 0, removed: 0, reads: 0, errors: 0, ms: 0, nextInMs };
    try {
      await this.load();
      // 1. Window: drop old candidates and old dedupe keys.
      const horizon = started - this.windowMs;
      const removed: string[] = [];
      for (const [m, c] of this.active) {
        if (c.createdAt < horizon) {
          this.active.delete(m);
          removed.push(m);
        }
      }
      for (const [k, t] of this.seen) if (t < horizon) this.seen.delete(k);
      // 2. Metrics of every candidate.
      const reads = await this.refreshMetrics(this.o.metricsChain ?? this.o.chain, asOf, [...this.active.values()]);
      r.reads += reads.calls;
      r.errors += reads.errors;
      for (const m of reads.gone) {
        if (this.active.delete(m)) removed.push(m);
      }
      // 3. One commit (verified rows only; an admitted candidate the fast pass could not read yet waits).
      await this.commit({ asOf, upserts: [...this.active.values()].filter((c) => c.verified).map(publicRow), removed });
      r.removed = removed.length;
    } catch {
      r.errors++;
    }
    r.active = this.active.size;
    r.ms = this.now() - started;
    return r;
  }

  /** Published candidates, newest first (public stream; the indexer keeps them in its warm set). */
  activeMints(): string[] {
    return [...this.active.values()].filter((c) => c.verified).sort((a, b) => b.createdAt - a.createdAt).map((c) => c.mint);
  }

  /**
   * Fast pass every ~passMs, metrics pass every 45–75 s, each on its own timer.
   * `onTick` gets ONE aggregated report per metrics pass (fast passes folded in),
   * so the log keeps one discovery line per minute.
   */
  async run(signal: AbortSignal, onTick?: (r: DiscoveryReport) => void): Promise<void> {
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(250, ms));
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });
    const agg = { passes: 0, seen: 0, admitted: 0, reads: 0, errors: 0, ms: 0, lagSum: 0, lagN: 0, lagMax: 0 };
    const fast = (async () => {
      while (!signal.aborted) {
        const p = await this.collect();
        agg.passes++;
        agg.seen += p.seen;
        agg.admitted += p.admitted;
        agg.reads += p.reads;
        agg.errors += p.errors;
        agg.ms = Math.max(agg.ms, p.ms);
        if (p.lagMaxMs !== undefined) {
          agg.lagSum += (p.lagAvgMs ?? 0) * p.admitted;
          agg.lagN += p.admitted;
          agg.lagMax = Math.max(agg.lagMax, p.lagMaxMs);
        }
        await sleep(p.nextInMs - p.ms);
      }
    })();
    const slow = (async () => {
      while (!signal.aborted) {
        const m = await this.refresh();
        onTick?.({
          ...m,
          passes: agg.passes,
          seen: agg.seen,
          admitted: agg.admitted,
          reads: m.reads + agg.reads,
          errors: m.errors + agg.errors,
          ms: Math.max(m.ms, agg.ms),
          ...(agg.lagN > 0 ? { lagAvgMs: Math.round(agg.lagSum / agg.lagN), lagMaxMs: agg.lagMax } : {}),
        });
        Object.assign(agg, { passes: 0, seen: 0, admitted: 0, reads: 0, errors: 0, ms: 0, lagSum: 0, lagN: 0, lagMax: 0 });
        await sleep(m.nextInMs - m.ms);
      }
    })();
    await Promise.all([fast, slow]);
    for (const s of this.o.sources) s.stop?.();
  }

  private refill(now: number): void {
    const dt = Math.max(0, now - this.lastRefill);
    this.lastRefill = now;
    this.allowance = Math.min(this.burst, this.allowance + (this.max * dt) / this.windowMs);
  }

  /**
   * pump: bonding curve PDA (+ Global, refreshed every tick in the same call);
   * DBC: pool, its config (once per config), the mint (+ Metaplex metadata) once
   * per new candidate. <= 100 keys per getMultipleAccounts.
   */
  private async refreshMetrics(chain: DiscoveryChain, asOf: number, list: readonly Tracked[]): Promise<{ calls: number; errors: number; gone: string[] }> {
    const keys: PublicKey[] = [GLOBAL_PDA];
    const plan: Array<{ c: Tracked; idx: Record<string, number> }> = [];
    const add = (k: PublicKey) => keys.push(k) - 1;
    const wantConfig = new Map<string, number>();
    for (const c of list) {
      const idx: Record<string, number> = {};
      const mintPk = new PublicKey(c.mint);
      if (c.venue === "pumpfun") {
        idx.curve = add(bondingCurvePda(mintPk));
        // Graduated: spot price from the PumpSwap pool (vaults once known, else the pool account).
        if (c.status === "graduated") {
          if (c.ammVaults) {
            idx.ab = add(new PublicKey(c.ammVaults[0]));
            idx.aq = add(new PublicKey(c.ammVaults[1]));
          } else idx.amm = add(canonicalPumpPoolPda(mintPk));
        }
      } else if (c.venue === "raydium-launchlab") {
        if (!this.o.launchLabProgram) continue;
        idx.ll = add(getPdaLaunchpadPoolId(this.o.launchLabProgram, mintPk, NATIVE_MINT).publicKey);
        if (!c.verified || c.supply === null) {
          idx.mint = add(mintPk);
          idx.meta = add(metaplexMetadataPda(mintPk));
        }
      } else {
        if (!c.pool) {
          c.verified = true; // unknown pool: never guess the PDA of a foreign config (row without metrics)
          continue;
        }
        idx.pool = add(new PublicKey(c.pool));
        if (c.config && !this.configs.has(c.config) && !wantConfig.has(c.config)) wantConfig.set(c.config, add(new PublicKey(c.config)));
        if (!c.verified || c.supply === null) {
          idx.mint = add(mintPk);
          idx.meta = add(metaplexMetadataPda(mintPk));
        }
        // Graduated to DAMM v2 (migrationOption 1): the pool the DBC migration created.
        const cfg = c.config ? this.configs.get(c.config) : undefined;
        if (c.status === "graduated" && cfg) {
          const damm = dammV2PoolOf(cfg, mintPk);
          if (damm) idx.damm = add(damm);
        }
      }
      plan.push({ c, idx });
    }
    let accs: (AccountInfo<Buffer> | null)[];
    try {
      accs = [];
      for (let i = 0; i < keys.length; i += 100) accs.push(...(await chain.getMultipleAccounts(keys.slice(i, i + 100))));
    } catch {
      return { calls: Math.ceil(keys.length / 100), errors: 1, gone: [] };
    }
    const calls = Math.ceil(keys.length / 100);
    const g = accs[0];
    if (g) this.global = safe(() => PUMP_SDK.decodeGlobal(g)) ?? this.global;
    for (const [cfg, i] of wantConfig) {
      const a = accs[i];
      const dec = a && a.owner.equals(DBC_PROGRAM_ID) ? safe(() => dbcCoder().accounts.decode("poolConfig", a.data) as PoolConfig) : null;
      if (dec) this.configs.set(cfg, dec);
    }
    let errors = 0;
    const gone: string[] = [];
    /** Pump candidates whose PumpSwap vaults were just learned: one small follow-up read in the same pass. */
    const followUp: Tracked[] = [];
    for (const { c, idx } of plan) {
      c.asOf = asOf;
      if (c.venue === "pumpfun") {
        const a = accs[idx.curve!];
        const decoded = a && a.owner.equals(PUMP_PROGRAM_ID) ? safe(() => PUMP_SDK.decodeBondingCurve(a)) : null;
        // SOL-quoted curves only (as the trading adapter): a USDC / pump-coin quote would read as SOL.
        const curve = decoded && isLegacyQuoteMint(normalizeQuoteMint(decoded.quoteMint)) ? decoded : null;
        if (!curve) {
          if (!c.verified) gone.push(c.mint); // not a SOL pump curve after all
          else errors++;
          continue;
        }
        const pc = priceAndCap(curve, 6);
        const st = curveStatus(curve);
        c.status = st;
        c.priceSol = pc.priceSol;
        c.marketCapSol = pc.marketCapSol;
        c.progressPct = st === "curve" && this.global ? curveProgress(curve, this.global).progressPct : null;
        c.verified = true;
        if (st === "graduated") {
          const amm = idx.amm !== undefined ? accs[idx.amm] : null;
          if (amm && !c.ammVaults) {
            const pp = parsePumpPool(amm.data);
            if (pp && pumpPoolQuoteMint(amm.data)?.equals(NATIVE_MINT)) {
              c.ammVaults = [pp.baseVault.toBase58(), pp.quoteVault.toBase58()];
              followUp.push(c);
            }
          }
          const ap = idx.ab !== undefined ? ammPriceAndCap(tokenAccountAmount(accs[idx.ab]) ?? 0n, tokenAccountAmount(accs[idx.aq!]) ?? 0n, c.decimals, c.supply ?? PUMP_SUPPLY) : null;
          if (ap) Object.assign(c, ap);
        }
      } else {
        if (idx.mint !== undefined) {
          const f = mintFacts(new PublicKey(c.mint), accs[idx.mint] ?? null);
          if (f) {
            c.decimals = f.decimals;
            c.supply = f.supply;
            const md = f.tokenMetadata ?? (accs[idx.meta!] ? parseMetaplexMetadata(accs[idx.meta!]!.data) : null);
            c.name ??= clean(md?.name);
            c.symbol ??= clean(md?.symbol);
          }
        }
        if (c.venue === "raydium-launchlab") {
          const la = accs[idx.ll!];
          const pool = la && this.o.launchLabProgram && la.owner.equals(this.o.launchLabProgram) ? safe(() => LaunchpadPool.decode(la.data)) : null;
          if (!pool || !pool.mintA.equals(new PublicKey(c.mint)) || !pool.mintB.equals(NATIVE_MINT)) {
            if (!c.verified) gone.push(c.mint); // not a SOL LaunchLab pool
            else errors++;
            continue;
          }
          const onCurve = Number(pool.status) === 0;
          c.status = onCurve ? "curve" : "graduated";
          c.progressPct = onCurve ? launchLabProgress(pool) : null;
          c.verified = true;
          const sq = BigInt(pool.virtualB.toString()) + BigInt(pool.realB.toString());
          const tq = BigInt(pool.virtualA.toString()) - BigInt(pool.realA.toString());
          if (sq > 0n && tq > 0n) {
            const price18 = (sq * 10n ** BigInt(c.decimals) * 10n ** 18n) / (tq * 1_000_000_000n);
            c.priceSol = formatUnits(price18, 18);
            if (c.supply !== null) c.marketCapSol = formatUnits((sq * c.supply) / tq, 9);
          }
          continue;
        }
        const a = accs[idx.pool!];
        const st = a && a.owner.equals(DBC_PROGRAM_ID) ? safe(() => (dbcCoder().accounts.decode("virtualPool", a.data) as VirtualPool).poolState) : null;
        const cfg = c.config ? this.configs.get(c.config) : undefined;
        if (!st || !st.baseMint.equals(new PublicKey(c.mint))) {
          if (!c.verified) gone.push(c.mint);
          else errors++;
          continue;
        }
        // SOL-quoted configs only (as pump / LaunchLab): a USDC quote would read as SOL.
        if (cfg && !cfg.quoteMint.equals(NATIVE_MINT)) {
          gone.push(c.mint);
          continue;
        }
        c.verified = true;
        if (cfg) {
          const s = dbcStatus(st, cfg);
          c.status = s;
          c.progressPct = s === "curve" ? dbcProgressPct(st, cfg) : null;
        }
        if (c.supply !== null) {
          const pc = dbcPriceAndCap(st.sqrtPrice, c.supply, c.decimals);
          c.priceSol = pc.priceSol;
          c.marketCapSol = pc.marketCapSol;
          // Graduated: the DAMM v2 pool's price (same Q64 sqrt price as the curve).
          const da = idx.damm !== undefined ? accs[idx.damm] : null;
          const dp = da && da.owner.equals(DAMM_V2_PROGRAM_ID) ? safe(() => dammCoder().accounts.decode("pool", da.data) as { tokenAMint: PublicKey; tokenBMint: PublicKey; sqrtPrice: BN }) : null;
          if (dp && dp.tokenAMint.equals(new PublicKey(c.mint)) && dp.tokenBMint.equals(NATIVE_MINT) && !dp.sqrtPrice.isZero()) {
            const ap = dbcPriceAndCap(dp.sqrtPrice, c.supply, c.decimals);
            c.priceSol = ap.priceSol;
            c.marketCapSol = ap.marketCapSol;
          }
        }
      }
    }
    let more = 0;
    if (followUp.length > 0) {
      const vk = followUp.flatMap((c) => c.ammVaults!.map((k) => new PublicKey(k)));
      try {
        const va: (AccountInfo<Buffer> | null)[] = [];
        for (let i = 0; i < vk.length; i += 100) {
          more++;
          va.push(...(await chain.getMultipleAccounts(vk.slice(i, i + 100))));
        }
        followUp.forEach((c, i) => {
          const ap = ammPriceAndCap(tokenAccountAmount(va[2 * i]) ?? 0n, tokenAccountAmount(va[2 * i + 1]) ?? 0n, c.decimals, c.supply ?? PUMP_SUPPLY);
          if (ap) Object.assign(c, ap);
        });
      } catch {
        errors++;
      }
    }
    return { calls: calls + more, errors, gone };
  }
}

/** pump.fun total supply (1e9 tokens, 6 decimals): market cap of a graduated pump coin. */
const PUMP_SUPPLY = 1_000_000_000n * 10n ** 6n;

let sharedDammCoder: { accounts: { decode(name: string, data: Buffer): unknown } } | null = null;
function dammCoder() {
  sharedDammCoder ??= createDammV2Program(new Connection("http://127.0.0.1:8899")).coder as unknown as NonNullable<typeof sharedDammCoder>;
  return sharedDammCoder;
}

/** DAMM v2 pool a DBC launch migrates to (migrationOption 1), SOL quote; null otherwise. */
export function dammV2PoolOf(cfg: Pick<PoolConfig, "migrationOption" | "migrationFeeOption" | "quoteMint">, baseMint: PublicKey): PublicKey | null {
  if (Number(cfg.migrationOption) !== 1 || !cfg.quoteMint.equals(NATIVE_MINT)) return null;
  const feeCfg = DAMM_V2_MIGRATION_FEE_ADDRESS[Number(cfg.migrationFeeOption)];
  return feeCfg ? deriveDammV2PoolAddress(feeCfg, baseMint, cfg.quoteMint) : null;
}

function publicRow(c: Tracked): DiscoveryCandidate {
  const { decimals: _d, supply: _s, verified: _v, ammVaults: _a, ...row } = c;
  return row;
}

/** Display strings from chain data: trimmed, control chars stripped, bounded; empty -> null. */
function clean(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return t.length ? t : null;
}

function isKey(s: string): boolean {
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

function safe<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export interface DiscoveryConfig {
  enabled: boolean;
  max: number;
  windowMs: number;
  burst: number;
  /** pump.fun source: poll (default) | ws | off. */
  pump: "poll" | "ws" | "off";
  /** Discovery RPC (reads + pump poll); masked in logs. */
  rpcUrl: string | null;
  rpcSource: string | null;
  wsUrl: string | null;
  /** Helius Parsed Streams URL for DBC creates; null = DBC off. */
  dbcStreamUrl: string | null;
  dbcMaxPerHour: number;
  rps: number;
  /** Fast pass period (INTEL_DISCOVERY_TICK_SECS, default 4 s). */
  passMs: number;
}

/**
 * INTEL_DISCOVERY=1 enables it (default OFF). Provider: INTEL_DISCOVERY_RPC_URL_<NET>,
 * else SOLANA_RPC_URL_<NET> (Helius). Discovery reads never depend on users, so
 * the read/send split (R1) is not at stake here. DBC needs a Parsed Streams URL:
 * INTEL_DISCOVERY_DBC_STREAM_URL, default on mainnet wss://beta.helius-rpc.com/?api-key=<key of the RPC URL>.
 */
export function loadDiscoveryConfig(cluster: "devnet" | "mainnet-beta", env: NodeJS.ProcessEnv = process.env): DiscoveryConfig {
  const sfx = cluster === "devnet" ? "DEVNET" : "MAINNET";
  const enabled = env.INTEL_DISCOVERY?.trim() === "1";
  const num = (k: string, d: number, lo: number, hi: number) => {
    const v = Number(env[k]?.trim() || d);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${k} must be ${lo}..${hi}`);
    return v;
  };
  const pump = (env.INTEL_DISCOVERY_PUMP?.trim() || "poll") as DiscoveryConfig["pump"];
  if (!["poll", "ws", "off"].includes(pump)) throw new Error("INTEL_DISCOVERY_PUMP must be poll|ws|off");
  let rpcUrl = env[`INTEL_DISCOVERY_RPC_URL_${sfx}`]?.trim() || null;
  let rpcSource: string | null = rpcUrl ? `INTEL_DISCOVERY_RPC_URL_${sfx}` : null;
  if (!rpcUrl && env[`SOLANA_RPC_URL_${sfx}`]?.trim()) {
    rpcUrl = env[`SOLANA_RPC_URL_${sfx}`]!.trim();
    rpcSource = `SOLANA_RPC_URL_${sfx}`;
  }
  let wsUrl: string | null = null;
  if (rpcUrl) {
    try {
      const u = new URL(rpcUrl);
      u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
      wsUrl = u.toString();
    } catch {
      wsUrl = null;
    }
  }
  let dbcStreamUrl = env.INTEL_DISCOVERY_DBC_STREAM_URL?.trim() || null;
  if (!dbcStreamUrl && cluster === "mainnet-beta" && env.INTEL_DISCOVERY_DBC?.trim() !== "0" && rpcUrl) {
    try {
      const key = new URL(rpcUrl).searchParams.get("api-key");
      if (key) dbcStreamUrl = `wss://beta.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
    } catch {
      /* no key */
    }
  }
  if (env.INTEL_DISCOVERY_DBC?.trim() === "0") dbcStreamUrl = null;
  return {
    enabled,
    max: num("INTEL_DISCOVERY_MAX", 200, 1, 2_000),
    windowMs: num("INTEL_DISCOVERY_WINDOW_H", 6, 0.25, 48) * 3_600_000,
    burst: num("INTEL_DISCOVERY_BURST", 10, 1, 200),
    pump,
    rpcUrl,
    rpcSource,
    wsUrl,
    dbcStreamUrl,
    dbcMaxPerHour: num("INTEL_DISCOVERY_DBC_MAX_PER_H", 600, 1, 100_000),
    rps: num("INTEL_DISCOVERY_RPS", 2, 0.2, 20),
    passMs: num("INTEL_DISCOVERY_TICK_SECS", 4, 1, 60) * 1000,
  };
}
