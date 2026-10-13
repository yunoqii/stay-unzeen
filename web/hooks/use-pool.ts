"use client";

import { useEffect, useState } from "react";
import { api, errorText } from "@/lib/api/client";
import type { PoolInfo } from "@/lib/api/types";
import { rememberChain, useNetwork, type Network } from "@/lib/network";

/** Public GET /api/pool for the selected network. */
export function usePool() {
  const network = useNetwork();
  const [state, setState] = useState<{ network: Network; pool: PoolInfo | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .getPool()
      .then((pool) => {
        // v0.18: the pool's own chain (native coin, decimals) wins over the static default.
        rememberChain(network, pool.chain);
        if (alive) setState({ network, pool, error: null });
      })
      .catch((e: unknown) => alive && setState({ network, pool: null, error: errorText(e) }));
    return () => {
      alive = false;
    };
  }, [network, attempt]);

  // Never hand out a pool fetched for the other network.
  const current = state?.network === network ? state : null;
  return { pool: current?.pool ?? null, error: current?.error ?? null, network, retry: () => setAttempt((a) => a + 1) };
}
