import { randomInt } from "node:crypto";
import { PublicKey, type Connection } from "@solana/web3.js";

/**
 * ONE compute unit price for EVERY transaction of the pool (R-relayer-2/5,
 * docs/analysis/now-mode.md N-5/N-6).
 *
 * - The price comes from a background cache, refreshed every 10–20 s (random
 *   jitter, independent of requests). Building a transaction only READS the
 *   cache: no estimate is ever requested at execution time, and never with a
 *   serialized transaction (a provider would see vault/mint/amount before the
 *   send, and calls right before Now trades would label them).
 * - The estimate is asked for the venue PROGRAMS only (`accountKeys`), never
 *   for vaults, mints or recipients.
 * - The value is quantized to a fixed ladder of levels and clamped, so the
 *   price cannot carry a per-request fingerprint and is identical for buy,
 *   sell, create, withdraw and lookup-table transactions in any execution mode.
 * - No fresh estimate for `staleMs`: the last one x1.5 (quantized, clamped).
 */

/** Anything that yields the current price; read synchronously when signing. */
export interface PriorityPrice {
  microLamports(): number;
}

/** A constant (tests, scripts, legacy number option). */
export function fixedPrice(microLamports: number): PriorityPrice {
  return { microLamports: () => microLamports };
}

/** number option (legacy) or a PriorityPrice -> current value. */
export function priceOf(p: number | PriorityPrice | undefined): number {
  if (p === undefined) return 0;
  return typeof p === "number" ? p : p.microLamports();
}

/** Source of raw estimates, µlamports per CU. null = no estimate this time. */
export interface PriorityFeeSource {
  readonly name: string;
  estimate(): Promise<number | null>;
}

/** 10 levels, µlamports per CU. */
export const DEFAULT_FEE_LEVELS: readonly number[] = [
  1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000,
];
/** Hard cap: 1 000 000 µlamports x ~300k CU = 0.0003 SOL per tx. */
export const DEFAULT_FEE_MAX = 1_000_000;

/**
 * Smallest level >= raw (rounded up: the estimate is a floor to land), at
 * least the lowest level, never above `max` (then the highest level <= max).
 */
export function quantizeFee(raw: number | null, levels: readonly number[] = DEFAULT_FEE_LEVELS, max = DEFAULT_FEE_MAX): number {
  const allowed = levels.filter((l) => l <= max);
  if (allowed.length === 0) throw new RangeError("no fee level <= max");
  if (raw === null || !Number.isFinite(raw) || raw <= allowed[0]!) return allowed[0]!;
  return allowed.find((l) => l >= raw) ?? allowed[allowed.length - 1]!;
}

export interface PriorityFeeCacheOptions {
  levels?: readonly number[];
  max?: number;
  /** Refresh interval bounds (random in between each time). */
  refreshMinMs?: number;
  refreshMaxMs?: number;
  /** Age after which the last estimate is inflated. */
  staleMs?: number;
  staleFactor?: number;
  /** Raw value used until the first estimate (quantized). */
  initial?: number | null;
  now?: () => number;
  /** Uniform integer in [min, max]; CSPRNG by default. */
  randomInt?: (min: number, max: number) => number;
}

export class PriorityFeeCache implements PriorityPrice {
  private readonly levels: readonly number[];
  private readonly max: number;
  private readonly o: Required<Pick<PriorityFeeCacheOptions, "refreshMinMs" | "refreshMaxMs" | "staleMs" | "staleFactor">>;
  private readonly now: () => number;
  private readonly rand: (min: number, max: number) => number;
  private raw: number | null;
  private updatedAt: number;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  /** Successful / failed refreshes (diagnostics, no values). */
  refreshes = 0;
  failures = 0;

  constructor(
    private readonly source: PriorityFeeSource,
    opts: PriorityFeeCacheOptions = {},
  ) {
    this.levels = [...(opts.levels ?? DEFAULT_FEE_LEVELS)].sort((a, b) => a - b);
    this.max = opts.max ?? DEFAULT_FEE_MAX;
    this.o = {
      refreshMinMs: opts.refreshMinMs ?? 10_000,
      refreshMaxMs: opts.refreshMaxMs ?? 20_000,
      staleMs: opts.staleMs ?? 60_000,
      staleFactor: opts.staleFactor ?? 1.5,
    };
    if (this.o.refreshMaxMs < this.o.refreshMinMs) throw new RangeError("refreshMaxMs < refreshMinMs");
    quantizeFee(null, this.levels, this.max); // validates levels/max
    this.now = opts.now ?? Date.now;
    this.rand = opts.randomInt ?? ((a, b) => (a === b ? a : randomInt(a, b + 1)));
    this.raw = opts.initial ?? null;
    this.updatedAt = this.now();
  }

  /** Current pool-wide price. Synchronous, never touches the network. */
  microLamports(): number {
    let raw = this.raw;
    if (raw !== null && this.now() - this.updatedAt > this.o.staleMs) raw = raw * this.o.staleFactor;
    return quantizeFee(raw, this.levels, this.max);
  }

  /** One background refresh (also used once at startup). Never throws. */
  refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          const v = await this.source.estimate();
          if (v !== null && Number.isFinite(v) && v >= 0) {
            this.raw = v;
            this.updatedAt = this.now();
            this.refreshes++;
          } else {
            this.failures++;
          }
        } catch {
          this.failures++; // keep the last value; it ages into the x1.5 rule
        } finally {
          this.inflight = null;
        }
      })();
    }
    return this.inflight;
  }

  /** Starts the background loop (timer is unref'd). Idempotent. */
  start(): void {
    if (this.timer) return;
    const loop = () => {
      this.timer = setTimeout(() => {
        void this.refresh().finally(() => {
          if (this.timer) loop();
        });
      }, this.rand(this.o.refreshMinMs, this.o.refreshMaxMs));
      this.timer.unref?.();
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Helius `getPriorityFeeEstimate` by account keys (venue programs only).
 * Mainnet: Helius devnet answers "Method not found" (checked 12.10).
 */
export class HeliusPriorityFeeSource implements PriorityFeeSource {
  readonly name = "helius";
  constructor(
    private readonly rpcUrl: string,
    private readonly programs: readonly string[],
    private readonly level: "Low" | "Medium" | "High" | "VeryHigh" = "Medium",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5_000,
  ) {
    if (programs.length === 0) throw new Error("no venue programs for the fee estimate");
  }

  async estimate(): Promise<number | null> {
    const res = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(heliusRequest(this.programs, this.level)),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: { priorityFeeEstimate?: unknown }; error?: unknown };
    const v = j.result?.priorityFeeEstimate;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
}

/** Exact request body (exported for tests: account keys = programs only, no `transaction`). */
export function heliusRequest(programs: readonly string[], level: string): unknown {
  return {
    jsonrpc: "2.0",
    id: "unzeen-fee",
    method: "getPriorityFeeEstimate",
    params: [{ accountKeys: [...programs], options: { priorityLevel: level, recommended: true } }],
  };
}

/**
 * Standard RPC `getRecentPrioritizationFees` (works on devnet), the given
 * percentile of the last ~150 slots for the venue programs.
 */
export class RpcRecentFeesSource implements PriorityFeeSource {
  readonly name = "rpc";
  constructor(
    private readonly connection: Pick<Connection, "getRecentPrioritizationFees">,
    private readonly programs: readonly string[],
    private readonly percentile = 0.75,
  ) {}

  async estimate(): Promise<number | null> {
    const fees = await this.connection.getRecentPrioritizationFees({
      lockedWritableAccounts: this.programs.map((p) => new PublicKey(p)),
    });
    if (fees.length === 0) return null;
    const v = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.floor(v.length * this.percentile))]!;
  }
}

export class FixedFeeSource implements PriorityFeeSource {
  readonly name = "fixed";
  constructor(private readonly value: number) {}
  async estimate(): Promise<number | null> {
    return this.value;
  }
}

/**
 * The relayer's pool-wide cache from config. `programs` = venue program ids
 * only (pump.fun now; Meteora DBC when it is wired). Call `refresh()` once at
 * startup, then `start()`.
 */
export function priorityFeeCacheFromConfig(
  cfg: { cluster: string; rpcUrl: string; priorityMicroLamports: number; priorityFeeSource: "helius" | "rpc" | "fixed"; priorityMaxMicroLamports: number },
  connection: Pick<Connection, "getRecentPrioritizationFees">,
  programs: readonly string[],
): PriorityFeeCache {
  const source: PriorityFeeSource =
    cfg.priorityFeeSource === "helius"
      ? new HeliusPriorityFeeSource(cfg.rpcUrl, programs)
      : cfg.priorityFeeSource === "rpc"
        ? new RpcRecentFeesSource(connection, programs)
        : new FixedFeeSource(cfg.priorityMicroLamports);
  return new PriorityFeeCache(source, {
    max: cfg.priorityMaxMicroLamports,
    initial: cfg.priorityMicroLamports > 0 ? cfg.priorityMicroLamports : null,
  });
}
