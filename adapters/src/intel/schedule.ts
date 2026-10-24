import type { Rng } from "../relayer/random";
import type { WarmEntry } from "./types";

/**
 * Timing and padding rules of the intel indexer (token-intel.md §2,
 * rpc-providers.md R1/R2). Pure, tested with a seeded Rng.
 */

export const TICK_BASE_MS = 60_000;
export const TICK_JITTER_MS = 15_000;
/** Fixed size of a lookup batch (real unknown CAs + decoys). */
export const BATCH_SIZE = 8;
/** At most this many real CAs per batch (docs/INTEL.md): every batch carries >= 4 decoys. */
export const MAX_REAL_PER_BATCH = 4;
/** Warm set entries refreshed per tick at most (docs/INTEL.md). */
export const WARM_PER_TICK = 20;
export const HOT_INTERVAL_MS = 5 * 60_000;
/**
 * Card lane (docs/INTEL.md "Быстрая карточка"): its own fixed timer, uniform
 * 6–10 s, independent of any request. Each card tick reads a base snapshot
 * (mint, metadata, curve: ONE getMultipleAccounts on the read provider, no
 * index calls) of a fixed-size batch, so a cold CA gets its token card within
 * ~10 s; the full safety snapshot follows on the main tick.
 */
export const CARD_TICK_BASE_MS = 8_000;
export const CARD_TICK_JITTER_MS = 2_000;
/** Discovery candidates kept in the warm set (newest first). */
export const DISCOVERY_WARM_MAX = 250;
export const WARM_INTERVAL_MS = 30 * 60_000;

/** Delay to the next tick: uniform 45–75 s (60 ± 15), independent of any request. */
export function nextTickDelay(rng: Rng, base = TICK_BASE_MS, jitter = TICK_JITTER_MS): number {
  return base + rng.int(-jitter, jitter);
}

/** `asOf` of everything computed on a tick: floored to the minute (T5). */
export function tickBoundary(now: number, step = 60_000): number {
  return Math.floor(now / step) * step;
}

export function shuffle<T>(xs: readonly T[], rng: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function sample<T>(xs: readonly T[], k: number, rng: Rng): T[] {
  return shuffle(xs, rng).slice(0, Math.max(0, k));
}

/**
 * One lookup batch: the real CAs plus random decoys up to `size`, in random
 * order. Decoys never repeat a real mint. If the decoy pool is too small the
 * batch is shorter (reported by `decoys`).
 */
export function assembleBatch(
  real: readonly string[],
  decoyPool: readonly string[],
  rng: Rng,
  size = BATCH_SIZE,
): { mints: string[]; decoys: number } {
  const realSet = new Set(real);
  const pool = [...new Set(decoyPool)].filter((m) => !realSet.has(m));
  const decoys = sample(pool, size - realSet.size, rng);
  return { mints: shuffle([...realSet, ...decoys], rng), decoys: decoys.length };
}

/**
 * Warm set entries to refresh this tick (docs/INTEL.md): snapshot missing or
 * older than 5 min (hot) / 30 min (others); no snapshot first, then oldest;
 * at most `max`; random order. Depends only on snapshot ages, never on views.
 */
export function pickWarmDue(
  entries: readonly WarmEntry[],
  now: number,
  rng: Rng,
  exclude: ReadonlySet<string> = new Set(),
  max = WARM_PER_TICK,
  hotMs = HOT_INTERVAL_MS,
  warmMs = WARM_INTERVAL_MS,
): string[] {
  // An entry without a snapshot is refreshed only when it is pinned or a discovery candidate: the
  // card lane's batch mints sit in the warm set briefly (their cards must survive core's warm sync)
  // and get their full snapshot from a main-tick batch, never from this pass.
  const due = entries.filter(
    (e) => !exclude.has(e.mint) && (e.asOf === null ? e.pinned === true || e.discovery === true : now - e.asOf >= (e.hot ? hotMs : warmMs)),
  );
  // Ties broken randomly so equal ages do not keep a stable (observable) order.
  const keyed = shuffle(due, rng).sort((a, b) => (a.asOf ?? -1) - (b.asOf ?? -1));
  return shuffle(keyed.slice(0, max).map((e) => e.mint), rng);
}

/**
 * accountSubscribe set of the read provider (R2/P3). Changes are applied ONLY
 * on a tick, and every tick adds exactly `addsPerTick` subscriptions: new warm
 * curves first, the rest random decoy curves, each decoy dropped after a
 * random 2–6 ticks. So a new real subscription is one of a fixed number of
 * additions per tick and never lines up with a search or a buy.
 */
export class SubscriptionPlanner {
  private readonly real = new Set<string>();
  private readonly decoys = new Map<string, number>(); // key -> ticks left
  private readonly pendingAdd: string[] = [];

  constructor(
    private readonly rng: Rng,
    readonly addsPerTick = 4,
    private readonly decoyTtl: readonly [number, number] = [2, 6],
  ) {}

  current(): Set<string> {
    return new Set([...this.real, ...this.decoys.keys()]);
  }

  isDecoy(key: string): boolean {
    return this.decoys.has(key) && !this.real.has(key);
  }

  /** Plan of one tick. `desired`: curve keys of the warm set; `decoyPool`: candidate curve keys. */
  tick(desired: ReadonlySet<string>, decoyPool: readonly string[]): { add: string[]; remove: string[] } {
    const add: string[] = [];
    const remove: string[] = [];
    // Expire decoys.
    for (const [k, left] of [...this.decoys]) {
      if (left <= 1) {
        this.decoys.delete(k);
        if (!this.real.has(k) && !desired.has(k)) remove.push(k);
      } else this.decoys.set(k, left - 1);
    }
    // Warm entries that left the set.
    for (const k of [...this.real]) {
      if (!desired.has(k)) {
        this.real.delete(k);
        if (!this.decoys.has(k)) remove.push(k);
      }
    }
    // New warm entries queue up; at most addsPerTick per tick.
    for (const k of desired) if (!this.real.has(k) && !this.pendingAdd.includes(k)) this.pendingAdd.push(k);
    for (let i = this.pendingAdd.length - 1; i >= 0; i--) if (!desired.has(this.pendingAdd[i]!)) this.pendingAdd.splice(i, 1);
    const realNow = shuffle(this.pendingAdd, this.rng).slice(0, this.addsPerTick);
    for (const k of realNow) {
      this.pendingAdd.splice(this.pendingAdd.indexOf(k), 1);
      this.real.add(k);
      if (this.decoys.has(k)) this.decoys.delete(k); // already subscribed as a decoy: promote, no new call
      else add.push(k);
    }
    // Fill up to exactly addsPerTick NEW subscribe calls (a promoted decoy makes no call).
    const slots = this.addsPerTick - add.length;
    const cur = this.current();
    const candidates = decoyPool.filter((k) => !cur.has(k) && !desired.has(k));
    for (const k of sample(candidates, slots, this.rng)) {
      this.decoys.set(k, this.rng.int(this.decoyTtl[0], this.decoyTtl[1]));
      add.push(k);
    }
    return { add: shuffle(add, this.rng), remove: shuffle([...new Set(remove)], this.rng) };
  }
}
