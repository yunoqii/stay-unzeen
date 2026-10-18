"use client";

// v0.28 GET /api/quote: Jupiter's impact for graduated tokens (mainnet, features.quote). The server asks Jupiter
// itself for the amount rounded UP to 2 significant digits, caches it 10 s and gives everyone the same answer.
// We scale it to our amount (out ≈ outAmount · amount / inAmount, conservative) and then apply our slippage.

import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import type { JupiterQuote } from "@/lib/api/types";

/** Output for `amount` from a quote taken for inAmount >= amount. Null if the quote is unusable. */
export function scaleQuote(q: Pick<JupiterQuote, "inAmount" | "outAmount">, amount: bigint): bigint | null {
  if (!/^[1-9]\d*$/.test(q.inAmount) || !/^\d+$/.test(q.outAmount) || amount <= BigInt(0)) return null;
  return (BigInt(q.outAmount) * amount) / BigInt(q.inAmount);
}

const DEBOUNCE_MS = 700;

/**
 * The quote for (mint, side, amount) once the amount has settled; null while typing, on 404 / 429 / 503 or when
 * off (the panel then keeps its spot estimate). Buy amounts are lamports, sell amounts base units.
 */
export function useJupiterQuote(enabled: boolean, mint: string, side: "buy" | "sell", amount: bigint | null): { amount: bigint; out: bigint; impactPct: number; route: string[] } | null {
  const [st, setSt] = useState<{ key: string; v: { amount: bigint; out: bigint; impactPct: number; route: string[] } | null } | null>(null);
  const key = enabled && amount !== null && amount > BigInt(0) ? `${mint}:${side}:${amount}` : null;
  useEffect(() => {
    if (!key || amount === null) return;
    let alive = true;
    const t = setTimeout(() => {
      api
        .request<JupiterQuote>(`/api/quote?mint=${encodeURIComponent(mint)}&side=${side}&amount=${amount.toString()}`)
        .then((q) => {
          const out = scaleQuote(q, amount);
          if (alive) setSt({ key, v: out === null ? null : { amount, out, impactPct: Number(q.priceImpactPct) || 0, route: q.route ?? [] } });
        })
        .catch(() => alive && setSt({ key, v: null }));
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key, mint, side, amount]);
  return st && st.key === key ? st.v : null;
}
