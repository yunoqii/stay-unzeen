"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import type { Token } from "@/lib/api/types";

/** GET /api/tokens, refreshed every `refreshMs` and whenever `refreshKey` changes. */
export function useTokens(refreshKey?: unknown, refreshMs = 15_000) {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getTokens()
        .then((t) => {
          if (!alive) return;
          setTokens(t);
          setError(null);
        })
        .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Tokens unavailable"));
    load();
    const id = setInterval(load, refreshMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refreshKey, refreshMs]);

  return { tokens, error };
}
