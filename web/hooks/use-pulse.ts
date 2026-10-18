"use client";

import { useEffect, useState } from "react";
import { api, subscribePulse } from "@/lib/api/client";
import type { Pulse, TokenListItem } from "@/lib/api/types";
import { boardFromTokens, recordPrice, recordProgress } from "@/lib/pulse/board";
import { useNetwork } from "@/lib/network";
import { usePool } from "@/hooks/use-pool";

/** Fixed rhythm of the public token list for every visitor. */
export const TOKENS_POLL_MS = 15_000;

function remember(cards: readonly { mint: string; status: string; priceSol: string; curveProgressPct?: string }[], now: number) {
  for (const t of cards) {
    recordPrice(t.mint, Number(t.priceSol), now);
    if (t.status === "curve" && t.curveProgressPct !== undefined) recordProgress(t.mint, Number(t.curveProgressPct), now);
  }
}

/**
 * The Pulse board (v0.28 /ws/pulse, the same stream for everyone) and the public token list on a fixed
 * interval. A server without Pulse gets the board built from the list. Nothing here depends on the key or
 * the watchlist: what you watch is filtered from these on the device.
 */
export function usePulse() {
  const network = useNetwork();
  const { pool } = usePool();
  const live = pool?.features?.pulse === true;
  const [board, setBoard] = useState<Pulse | null>(null);
  const [tokens, setTokens] = useState<TokenListItem[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getTokens()
        .then((t) => {
          if (!alive) return;
          remember(t, Date.now());
          setTokens(t);
          if (!live) setBoard(boardFromTokens(t, Date.now()));
          setError(false);
        })
        .catch(() => alive && setError(true));
    void load();
    const id = setInterval(load, TOKENS_POLL_MS);
    const off = live
      ? subscribePulse((p) => {
          if (!alive) return;
          remember([...p.new, ...p.graduating, ...p.graduated], Date.now());
          setBoard(p);
        })
      : () => {};
    return () => {
      alive = false;
      clearInterval(id);
      off();
    };
  }, [network, live]);

  return { board, tokens, error: error && !board };
}
