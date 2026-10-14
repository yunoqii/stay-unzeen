"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";

/** Fixed interval: the same public GET for everyone on the token page, whatever they are about to do. */
const POLL_MS = 30_000;

/**
 * v0.23 (hood): the pool's latest Token.priceTs for `mint`, re-read from the public GET /api/tokens/:mint on a
 * fixed timer while `enabled`. Starts from the value the page loaded with.
 */
export function usePriceTs(mint: string, initial: number | undefined, enabled: boolean): number | undefined {
  const [ts, setTs] = useState(initial);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const id = setInterval(async () => {
      try {
        const t = await api.getToken(mint);
        if (alive && t && "mint" in t) setTs(t.priceTs);
      } catch {
        /* keep the last value: a failed read never unlocks trading */
      }
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mint, enabled]);
  return enabled ? ts : initial;
}
