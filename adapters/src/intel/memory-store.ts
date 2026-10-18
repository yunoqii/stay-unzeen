import type { CurveUpdate, IntelStore, OffchainInfo, TickCommit, TokenCard, TokenSafety, WarmEntry, PriceRow } from "./types";

/**
 * In-memory IntelStore for tests and `pnpm intel:run --memory`. Same
 * semantics as PgIntelStore: lookups stay queued until a tick consumes them,
 * batch mints join the warm set for 7 days, everything lands per tick.
 */
export class MemoryIntelStore implements IntelStore {
  readonly warm = new Map<string, { hot: boolean; pinned: boolean; expiresAt: number | null }>();
  readonly lookups: string[] = [];
  readonly launches = new Set<string>();
  readonly vaults = new Set<string>();
  readonly creators = new Set<string>();
  readonly safety = new Map<string, TokenSafety>();
  readonly missing = new Set<string>();
  readonly cards = new Map<string, TokenCard>();
  readonly curves = new Map<string, CurveUpdate>();
  /** intel_prices: current + previous value per mint (no history). */
  readonly prices = new Map<string, { priceSol: string; status: string; tickAt: number; prevPriceSol: string | null; prevTickAt: number | null; progressPct: string | null; curve: PriceRow["curve"] }>();
  readonly commits: TickCommit[] = [];
  subscriptions: TickCommit["subscriptions"] = [];
  meta: { nextTickAt: number; lastTickAt: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Helper: what core's search endpoint does. */
  enqueue(mint: string): void {
    if (!this.lookups.includes(mint)) this.lookups.push(mint);
  }

  /** Helper: what core's warm sync does for pool tokens. */
  pin(mint: string, hot = false): void {
    this.warm.set(mint, { hot, pinned: true, expiresAt: null });
  }

  async warmSet(): Promise<WarmEntry[]> {
    const now = this.now();
    return [...this.warm]
      .filter(([, w]) => w.pinned || (w.expiresAt ?? 0) > now)
      .map(([mint, w]) => ({ mint, hot: w.hot, pinned: w.pinned, asOf: this.safety.get(mint)?.asOf ?? null }));
  }

  async peekLookups(max: number): Promise<string[]> {
    return this.lookups.slice(0, Math.max(0, max));
  }

  async unzeenLaunches(): Promise<Set<string>> {
    return new Set(this.launches);
  }

  async poolCreators(): Promise<Set<string>> {
    return new Set(this.creators);
  }

  async poolVaults(): Promise<Set<string>> {
    return new Set(this.vaults);
  }

  async offchain(mint: string): Promise<OffchainInfo | null> {
    const s = this.safety.get(mint);
    if (!s || (!s.socials && !s.image)) return null;
    return { ...(s.socials ? { socials: s.socials } : {}), ...(s.image ? { image: s.image } : {}), fetchedAt: s.asOf, ok: true };
  }

  /** market_trades rows (UNIQUE signature, ix). */
  readonly marketTrades = new Map<string, NonNullable<TickCommit["marketTrades"]>[number]>();

  async commitTick(t: TickCommit): Promise<void> {
    this.commits.push(t);
    for (const m of t.marketTrades ?? []) if (!this.marketTrades.has(`${m.signature}:${m.ix}`)) this.marketTrades.set(`${m.signature}:${m.ix}`, m);
    for (const r of t.rows) {
      this.safety.set(r.mint, r);
      this.missing.delete(r.mint);
    }
    for (const m of t.missing) {
      this.missing.add(m);
      this.safety.delete(m);
    }
    for (const c of t.cards) this.cards.set(c.mint, c);
    const exp = this.now() + 7 * 24 * 3600_000;
    for (const m of t.batch) {
      const w = this.warm.get(m);
      this.warm.set(m, { hot: w?.hot ?? false, pinned: w?.pinned ?? false, expiresAt: Math.max(w?.expiresAt ?? 0, exp) });
    }
    for (const m of t.consumed) {
      const i = this.lookups.indexOf(m);
      if (i >= 0) this.lookups.splice(i, 1);
    }
    for (const u of t.curveUpdates) this.curves.set(u.mint, u);
    for (const p of t.prices ?? []) {
      const cur = this.prices.get(p.mint);
      if (cur && cur.tickAt >= t.tickStartedAt) continue;
      this.prices.set(p.mint, {
        priceSol: p.priceSol,
        status: p.status,
        tickAt: t.tickStartedAt,
        prevPriceSol: cur?.priceSol ?? null,
        prevTickAt: cur?.tickAt ?? null,
        progressPct: p.progressPct ?? null,
        curve: p.curve ?? null,
      });
    }
    this.subscriptions = t.subscriptions;
    this.meta = { nextTickAt: t.nextTickAt, lastTickAt: t.tickStartedAt };
  }
}
