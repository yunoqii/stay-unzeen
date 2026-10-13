// Non-SOL pairs (docs/API.md v0.13–v0.14): ZEC SPL (bridged), USDC, USD1. A token trades against one
// quote (Token.quote); feed events of such pairs carry quoteMint + quoteAmount, solAmount is then only
// the SOL equivalent at trade time (or "0"). Pure helpers, no React.

import type { FeedEvent, LaunchPlatform, PoolInfo, Quote, QuoteAsset, Token, Venue } from "@/lib/api/types";
import { formatCompact, formatSol, trimNumber, unitsToNumber, VENUE_LABEL } from "@/lib/format";

export const ZEC_SPL_MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";

/** Filter / picker order. */
export const QUOTES: readonly Quote[] = ["SOL", "ZEC", "USDC", "USD1"];
const NON_SOL: readonly Exclude<Quote, "SOL">[] = ["ZEC", "USDC", "USD1"];

export interface QuoteInfo {
  quote: Exclude<Quote, "SOL">;
  decimals: number;
  bridged: boolean;
}

/**
 * Mints the core registry knows (core/api config `known_quotes`): lets a feed row name its quote before
 * /api/pool has loaded. PoolInfo.quotes wins whenever it is there.
 */
const KNOWN_MINTS: Record<string, QuoteInfo> = {
  [ZEC_SPL_MINT]: { quote: "ZEC", decimals: 8, bridged: true },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { quote: "USDC", decimals: 6, bridged: false },
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: { quote: "USD1", decimals: 6, bridged: false },
  // devnet: Raydium / Meteora and pump.fun use different USDC mints
  USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT: { quote: "USDC", decimals: 6, bridged: false },
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": { quote: "USDC", decimals: 6, bridged: false },
};

export const QUOTE_DECIMALS: Record<Quote, number> = { SOL: 9, ZEC: 8, USDC: 6, USD1: 6 };

/** Older servers (before v0.13) send no `quote`: that is a SOL pair. */
export const tokenQuote = (t: { quote?: Quote } | null | undefined): Quote => t?.quote ?? "SOL";

export const isQuote = (v: unknown): v is Quote => typeof v === "string" && (QUOTES as readonly string[]).includes(v);

/** The quote a mint stands for, from the pool's list first, then the known registry. */
export function quoteOfMint(mint: string | undefined, pool?: Pick<PoolInfo, "quotes"> | null): QuoteInfo | null {
  if (!mint) return null;
  const q = pool?.quotes?.find((x) => x.mint === mint);
  if (q) return { quote: q.quote, decimals: q.decimals, bridged: q.bridged };
  return KNOWN_MINTS[mint] ?? null;
}

/** A feed event's amount in its quote (UI units), or null for SOL trades and unknown quote mints. */
export function eventQuote(e: Pick<FeedEvent, "quoteMint" | "quoteAmount">, pool?: Pick<PoolInfo, "quotes"> | null): { quote: Exclude<Quote, "SOL">; amount: number } | null {
  if (!e.quoteMint || !e.quoteAmount || !/^\d+$/.test(e.quoteAmount)) return null;
  const q = quoteOfMint(e.quoteMint, pool);
  if (!q) return null;
  return { quote: q.quote, amount: unitsToNumber(e.quoteAmount, q.decimals) };
}

/** Amount in a quote for display: SOL like everywhere else, ZEC to 4 places, dollars to cents. */
export function formatQuote(n: number, quote: Quote): string {
  if (!Number.isFinite(n)) return "—";
  if (quote === "SOL") return formatSol(n);
  if (n === 0) return "0";
  if (quote === "ZEC") return Math.abs(n) >= 1000 ? formatCompact(n) : trimNumber(n, Math.abs(n) < 0.01 ? 6 : 4);
  if (Math.abs(n) < 0.01) return "<0.01";
  return Math.abs(n) >= 10_000 ? formatCompact(n) : trimNumber(n, 2);
}

/** The pool's entry for `quote` that is enabled on `venue` (devnet has one USDC per venue family). */
export function quoteAsset(pool: Pick<PoolInfo, "quotes"> | null | undefined, quote: Quote, venue?: Venue): QuoteAsset | null {
  if (quote === "SOL") return null;
  return pool?.quotes?.find((q) => q.quote === quote && (!venue || q.venues.includes(venue))) ?? null;
}

/**
 * Pairs a launch on `venue` can pick. v0.16: PoolInfo.venues[].quotes is the source when present (empty
 * when create is off there); older servers: SOL plus the PoolInfo.quotes entries that list the venue.
 */
export function launchQuotes(pool: Pick<PoolInfo, "quotes" | "venues"> | null | undefined, venue: Venue): Quote[] {
  const info = pool?.venues?.find((v) => v.venue === venue);
  if (info) return QUOTES.filter((q) => info.quotes.includes(q));
  return ["SOL", ...NON_SOL.filter((q) => !!quoteAsset(pool, q, venue))];
}

/** v0.16 venue capabilities, or null on servers without PoolInfo.venues. */
export function venueInfo(pool: Pick<PoolInfo, "venues"> | null | undefined, venue: Venue) {
  return pool?.venues?.find((v) => v.venue === venue) ?? null;
}

/** Every quote enabled anywhere on this network (for the /tokens filter). */
export function enabledQuotes(pool: Pick<PoolInfo, "quotes"> | null | undefined): Quote[] {
  return ["SOL", ...NON_SOL.filter((q) => pool?.quotes?.some((x) => x.quote === q))];
}

/** Parity spread of ZEC SPL pairs, bps (null while the pool has not published it). */
export function zecSpreadBps(pool: Pick<PoolInfo, "quotes"> | null | undefined): number | null {
  const s = pool?.quotes?.find((q) => q.quote === "ZEC")?.spreadBps;
  return typeof s === "number" && Number.isInteger(s) && s >= 0 && s < 10_000 ? s : null;
}

/**
 * SOL -> quote conversion factor of a token (priceQuote / priceSol), from its own public prices.
 * null when either side is missing or "0" (v0.13: the SOL equivalent may be "0").
 */
export function quotePerSol(t: Pick<Token, "priceSol" | "priceQuote">): number | null {
  const q = Number(t.priceQuote);
  const s = Number(t.priceSol);
  return q > 0 && s > 0 && Number.isFinite(q / s) ? q / s : null;
}

export const PLATFORM_LABEL: Record<LaunchPlatform, string> = { unzeen: "Unzeen", bonk: "bonk.fun", stonk: "stonk.fun" };

/** "pump.fun", or "bonk.fun · LaunchLab" for a LaunchLab token with a platform. */
export function venueLabel(venue: Venue, platform?: LaunchPlatform): string {
  if (venue === "raydium-launchlab" && platform) return `${PLATFORM_LABEL[platform]} · ${VENUE_LABEL[venue]}`;
  return VENUE_LABEL[venue];
}

/** The pair as a ticker: "$PEPE/ZEC". */
export const pairLabel = (symbol: string, quote: Quote) => `$${symbol}/${quote}`;
