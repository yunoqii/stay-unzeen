// /tokens: filtering and sorting happen here, in the browser, over one public list that is the same
// for everyone (FEATURES.md 9). Nothing about the filters ever reaches the server.

import type { DiscoveryToken, Quote, Token, TokenListItem, Venue } from "@/lib/api/types";

/**
 * A row of /tokens: pool list items have every field; Discovery rows lack the pool-only ones, and their
 * pair is unknown (the indexer snapshot has no quote), so `quote` is optional here.
 */
export type ListedToken = Omit<Token, "quote"> & { quote?: Quote } & Partial<Pick<TokenListItem, "unzeenLaunch" | "volume24hSol" | "unzeenTrades24h" | "curveProgressPct">>;

/** Discovery rows in the same shape (no pool volume / trades: the pool has not traded them). */
export function fromDiscovery(d: DiscoveryToken): ListedToken {
  const { asOf: _asOf, ...rest } = d;
  void _asOf;
  return { ...rest, symbol: d.symbol || "?", name: d.name || "Metadata not read yet" };
}

export type VenueFilter = "all" | Venue;
/** v0.13 pair filter. A row without a known pair matches only "all". */
export type QuoteFilter = "all" | Quote;
export type StatusFilter = "all" | "curve" | "near" | "graduated";
export type SortKey = "volume" | "mcap" | "age" | "trades";

/** "Near graduation": at least this much of the bonding curve is filled. */
export const NEAR_GRADUATION_PCT = 80;

export interface TokenFilters {
  unzeenOnly: boolean;
  venue: VenueFilter;
  quote: QuoteFilter;
  status: StatusFilter;
  sort: SortKey;
  query: string;
}

export const DEFAULT_FILTERS: TokenFilters = { unzeenOnly: false, venue: "all", quote: "all", status: "all", sort: "volume", query: "" };

const num = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

/** Pool rows always carry a pair (the client fills "SOL" for older servers); Discovery rows: unknown (null). */
export function rowQuote(t: ListedToken): Quote | null {
  return t.quote ?? null;
}

export function isNearGraduation(t: ListedToken): boolean {
  return t.status === "curve" && num(t.curveProgressPct) >= NEAR_GRADUATION_PCT;
}

/** Ticker (with or without $), name, or a full / partial contract address. */
export function matchesQuery(t: ListedToken, query: string): boolean {
  const q = query.trim().replace(/^\$/, "");
  if (!q) return true;
  if (q.length >= 6 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(q) && t.mint.includes(q)) return true;
  const l = q.toLowerCase();
  return t.symbol.toLowerCase().includes(l) || t.name.toLowerCase().includes(l);
}

const SORTERS: Record<SortKey, (a: ListedToken, b: ListedToken) => number> = {
  volume: (a, b) => num(b.volume24hSol) - num(a.volume24hSol),
  mcap: (a, b) => num(b.marketCapSol) - num(a.marketCapSol),
  // Newest first.
  age: (a, b) => b.createdAt - a.createdAt,
  trades: (a, b) => (b.unzeenTrades24h ?? 0) - (a.unzeenTrades24h ?? 0),
};

export function filterTokens(list: readonly ListedToken[], f: TokenFilters): ListedToken[] {
  return list
    .filter((t) => !f.unzeenOnly || t.unzeenLaunch === true)
    .filter((t) => f.venue === "all" || t.venue === f.venue)
    .filter((t) => f.quote === "all" || rowQuote(t) === f.quote)
    .filter((t) => {
      if (f.status === "all") return true;
      if (f.status === "graduated") return t.status === "graduated";
      if (f.status === "near") return isNearGraduation(t);
      return t.status === "curve";
    })
    .filter((t) => matchesQuery(t, f.query))
    .sort((a, b) => SORTERS[f.sort](a, b) || b.createdAt - a.createdAt || a.mint.localeCompare(b.mint));
}
