// Position and PnL of one token, computed ONLY in this browser from the user's own executed actions
// (Portfolio.actions[].fill, kept in the encrypted local history, see lib/history.ts). Nothing here is
// ever sent to the server (T4, docs/analysis/token-intel.md §4).
//
// Cost basis is weighted-average in ZEC (the account's unit): a buy adds `zecSpent`, a sell or a token
// withdrawal removes cost pro rata (avg cost × amount). Integers only (bigint) for the ledger; floats
// only for the displayed price per token.

import type { OrderKind } from "@/lib/api/types";
import { lamportsToZat, tokensToLamports, zecPairValueZat } from "@/lib/trade";

const ZERO = BigInt(0);

/** One settled action, as the history keeps it. */
export interface Fill {
  kind: "buy" | "sell" | "create" | "withdraw_token";
  /** unix ms when this browser saw it executed (markers on the chart). */
  ts: number;
  /** Base units received (buy/create), sold (sell) or sent out (withdraw_token). */
  tokenAmount: string;
  /** Lamports of the trade (none for withdraw_token; none on ZEC pairs). */
  solAmount?: string;
  /** v0.13: ZEC pairs: ZEC SPL base units of the trade (instead of solAmount). */
  quoteAmount?: string;
  zecSpent?: string;
  zecCredited?: string;
  /** v0.8: the trade came from one of your private orders (marker label on the chart). */
  via?: OrderKind;
}

export interface Position {
  /** Base units still held according to the local history. */
  qty: bigint;
  /** Remaining cost basis, zatoshis. */
  costZat: bigint;
  /** Remaining cost basis in lamports (for an entry price comparable to the SOL chart). */
  costLamports: bigint;
  /** Realized PnL of sells, zatoshis (credited − cost of what was sold). */
  realizedZat: bigint;
  buys: number;
  sells: number;
  /**
   * The history does not explain everything: a sell or withdrawal larger than the tracked position
   * (tokens bought before this device kept history, or entries that expired on the server first).
   */
  incomplete: boolean;
}

const uint = (v: string | undefined): bigint => (v && /^\d+$/.test(v) ? BigInt(v) : ZERO);

export function emptyPosition(): Position {
  return { qty: ZERO, costZat: ZERO, costLamports: ZERO, realizedZat: ZERO, buys: 0, sells: 0, incomplete: false };
}

/** Fold fills (any order; sorted by ts here) into a position. */
export function computePosition(fills: readonly Fill[]): Position {
  const p = emptyPosition();
  const sorted = [...fills].sort((a, b) => a.ts - b.ts);
  for (const f of sorted) {
    const amount = uint(f.tokenAmount);
    if (f.kind === "buy" || f.kind === "create") {
      if (amount === ZERO) continue; // a launch without an initial buy
      p.qty += amount;
      p.costZat += uint(f.zecSpent);
      p.costLamports += uint(f.solAmount);
      p.buys++;
      continue;
    }
    // sell / withdraw_token: remove cost pro rata for the part the history can explain.
    const covered = amount > p.qty ? p.qty : amount;
    if (amount > p.qty) p.incomplete = true;
    const costOut = p.qty === ZERO ? ZERO : (p.costZat * covered) / p.qty;
    const lamportsOut = p.qty === ZERO ? ZERO : (p.costLamports * covered) / p.qty;
    if (f.kind === "sell") {
      p.sells++;
      const credited = uint(f.zecCredited);
      // Only the covered share of the proceeds counts against a known cost.
      const creditedCovered = amount === ZERO ? ZERO : (credited * covered) / amount;
      p.realizedZat += creditedCovered - costOut;
    }
    p.qty -= covered;
    p.costZat -= costOut;
    p.costLamports -= lamportsOut;
    if (p.qty === ZERO) {
      p.costZat = ZERO;
      p.costLamports = ZERO;
    }
  }
  return p;
}

/** Average entry price in SOL per whole token (null without a position). Display only. */
export function avgEntrySol(p: Position, decimals: number): number | null {
  if (p.qty === ZERO || p.costLamports === ZERO) return null;
  return Number(p.costLamports) / 1e9 / (Number(p.qty) / 10 ** decimals);
}

/** Average entry in ZEC per whole token (null without a position). Display only. */
export function avgEntryZec(p: Position, decimals: number): number | null {
  if (p.qty === ZERO || p.costZat === ZERO) return null;
  return Number(p.costZat) / 1e8 / (Number(p.qty) / 10 ** decimals);
}

export interface Unrealized {
  /** What the held qty is worth now, zatoshis (price × qty at the pool's sell rate). */
  valueZat: bigint;
  pnlZat: bigint;
  /** PnL / cost, in percent; null without cost. */
  pnlPct: number | null;
}

/**
 * Mark the position to the public price (Token.priceSol) and the public pool rate
 * (PoolInfo.rate.lamportsPerZecSell): both are requests every visitor makes, so marking leaks nothing.
 */
export function unrealized(p: Position, priceSol: string, decimals: number, lamportsPerZecSell: bigint): Unrealized | null {
  if (p.qty === ZERO || lamportsPerZecSell <= ZERO) return null;
  const lamports = tokensToLamports(p.qty, priceSol, decimals);
  return markedAt(p, lamportsToZat(lamports, lamportsPerZecSell));
}

/**
 * v0.13 ZEC pairs: mark at the pair's own price (Token.priceQuote, ZEC per token) through the 1:1 parity
 * (sell side, spread included). No SOL rate anywhere.
 */
export function unrealizedZecPair(p: Position, priceQuote: string | undefined, decimals: number, spreadBps: number, quoteDecimals = 8): Unrealized | null {
  if (p.qty === ZERO) return null;
  const v = zecPairValueZat(p.qty, spreadBps, priceQuote, decimals, quoteDecimals);
  return v === null ? null : markedAt(p, v);
}

function markedAt(p: Position, valueZat: bigint): Unrealized {
  const pnlZat = valueZat - p.costZat;
  const pnlPct = p.costZat === ZERO ? null : (Number(pnlZat) / Number(p.costZat)) * 100;
  return { valueZat, pnlZat, pnlPct };
}
