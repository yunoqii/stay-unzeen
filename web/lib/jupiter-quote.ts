"use client";

// v0.28 GET /api/quote: Jupiter's impact for graduated tokens (mainnet, features.quote), answered from the server's
// background grid (the server never asks Jupiter when we ask it). inAmount is our amount; above the grid's
// maxAmount the server answers 404, so we remember the top per (mint, side) and say "unavailable above X".

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api/client";
import type { JupiterQuote } from "@/lib/api/types";

export type RouteQuote =
  | { kind: "ok"; amount: bigint; out: bigint; impactPct: number; route: string[]; asOf: number; maxAmount: bigint | null }
  | { kind: "above"; amount: bigint; maxAmount: bigint };

/** The answer for `amount`, or null if unusable. An answer for another amount is scaled (older servers). */
export function readQuote(q: Pick<JupiterQuote, "inAmount" | "outAmount" | "priceImpactPct" | "route" | "asOf" | "maxAmount">, amount: bigint): Extract<RouteQuote, { kind: "ok" }> | null {
  if (!/^[1-9]\d*$/.test(q.inAmount) || !/^\d+$/.test(q.outAmount) || amount <= BigInt(0)) return null;
  const inA = BigInt(q.inAmount);
  const out = inA === amount ? BigInt(q.outAmount) : (BigInt(q.outAmount) * amount) / inA;
  const max = typeof q.maxAmount === "string" && /^\d+$/.test(q.maxAmount) ? BigInt(q.maxAmount) : null;
  return { kind: "ok", amount, out, impactPct: Number(q.priceImpactPct) || 0, route: Array.isArray(q.route) ? q.route : [], asOf: Number.isFinite(q.asOf) ? q.asOf : 0, maxAmount: max };
}

/** Whole minutes since the quote's oldest point ("quote N min old"). */
export const quoteAgeMin = (asOf: number, now: number) => Math.max(0, Math.floor((now - asOf) / 60_000));

/** Known top of the grid per mint and side (from earlier answers in this tab). */
const tops = new Map<string, bigint>();

const DEBOUNCE_MS = 700;

/**
 * The quote for (mint, side, amount) once the amount has settled. "above" when the amount is past the grid's top
 * (known from an earlier answer, or a 404 after one); null while typing, when off, or on errors: the panel then
 * keeps its spot estimate. Buy amounts are lamports, sell amounts base units.
 */
export function useJupiterQuote(enabled: boolean, mint: string, side: "buy" | "sell", amount: bigint | null): RouteQuote | null {
  const [st, setSt] = useState<{ key: string; v: RouteQuote | null } | null>(null);
  const key = enabled && amount !== null && amount > BigInt(0) ? `${mint}:${side}:${amount}` : null;
  const topKey = `${mint}:${side}`;
  const known = tops.get(topKey);
  const aboveKnown = key !== null && amount !== null && known !== undefined && amount > known;
  useEffect(() => {
    if (!key || amount === null || aboveKnown) return;
    let alive = true;
    const t = setTimeout(() => {
      api
        .request<JupiterQuote>(`/api/quote?mint=${encodeURIComponent(mint)}&side=${side}&amount=${amount.toString()}`)
        .then((q) => {
          const v = readQuote(q, amount);
          if (v?.maxAmount) tops.set(topKey, v.maxAmount);
          if (alive) setSt({ key, v });
        })
        .catch((e) => {
          const top = tops.get(topKey);
          const above = e instanceof ApiError && e.code === "not_found" && top !== undefined && amount > top;
          if (alive) setSt({ key, v: above ? { kind: "above", amount, maxAmount: top } : null });
        });
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key, mint, side, amount, aboveKnown, topKey]);
  if (aboveKnown && amount !== null && known !== undefined) return { kind: "above", amount, maxAmount: known };
  return st && st.key === key ? st.v : null;
}
