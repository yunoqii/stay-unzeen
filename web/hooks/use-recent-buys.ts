"use client";

import { useMemo } from "react";
import { recentBuyAmounts, useActivityVersion } from "@/lib/activity";
import { useKeyState } from "@/lib/crypto/session";
import { fillsOf } from "@/lib/history/reduce";
import { useHistory } from "@/lib/history/store";
import { useNetwork } from "@/lib/network";
import { MIRROR_WINDOW_MS } from "@/lib/trade";
import { useNow } from "./use-now";

/**
 * Token amounts of your own buys of `mint` the pool looks at for A6 (API v0.17): the last 48 h of the local
 * encrypted history plus this tab's executed buys. Local only: nothing here is sent anywhere.
 */
export function useRecentBuys(mint: string): bigint[] {
  const network = useNetwork();
  const key = useKeyState();
  const pubkey = key.status === "unlocked" ? key.pubkey : null;
  const history = useHistory();
  const version = useActivityVersion();
  const now = useNow(60_000);
  return useMemo(() => {
    void version;
    const since = now === null ? 0 : now - MIRROR_WINDOW_MS;
    const local = fillsOf(history.entries, mint)
      .filter((f) => (f.kind === "buy" || f.kind === "create") && f.ts >= since)
      .map((f) => BigInt(f.tokenAmount));
    return pubkey ? [...local, ...recentBuyAmounts(network, pubkey, mint)] : local;
  }, [history.entries, mint, network, pubkey, version, now]);
}
