"use client";

import { useEffect, useState } from "react";
import { api, errorText } from "@/lib/api/client";
import { useNetwork } from "@/lib/network";
import type { TokenListItem } from "@/lib/api/types";

/** GET /api/tokens, refreshed every `refreshMs` and whenever `refreshKey` changes. */
export function useTokens(refreshKey?: unknown, refreshMs = 15_000) {
  const [tokens, setTokens] = useState<TokenListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const network = useNetwork(); // refetch / resubscribe on Devnet <-> Mainnet
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
        .catch((e: unknown) => alive && setError(errorText(e)));
    load();
    const id = setInterval(load, refreshMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refreshKey, refreshMs, network]);

  return { tokens, error };
}
