"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "@/lib/api/client";
import type { Portfolio } from "@/lib/api/types";
import { useActivityVersion } from "@/lib/activity";
import { getSigner, useKeyState } from "@/lib/crypto/session";

/**
 * Signed GET /api/portfolio for the unlocked key of the selected network, polled every `intervalMs`.
 * Resets when the key or the network changes, so one key's numbers never show under another.
 */
export function usePortfolio(intervalMs = 15_000) {
  const key = useKeyState();
  const id = key.status === "unlocked" ? `${key.network}:${key.pubkey}` : null;
  const [state, setState] = useState<{ id: string; data: Portfolio | null; error: string | null } | null>(null);
  const inflight = useRef<string | null>(null);

  const again = useRef(false);
  const load = useCallback(async () => {
    const signer = getSigner();
    if (!id || !signer) return;
    if (inflight.current === id) {
      again.current = true; // something changed mid-flight: fetch once more when this one lands
      return;
    }
    inflight.current = id;
    try {
      const data = await api.getPortfolio(signer);
      setState({ id, data, error: null });
    } catch (e) {
      setState((s) => ({ id, data: s?.id === id ? s.data : null, error: errorText(e) }));
    } finally {
      if (inflight.current === id) inflight.current = null;
      if (again.current) {
        again.current = false;
        void load();
      }
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, intervalMs);
    return () => clearInterval(t);
  }, [id, intervalMs, load]);

  // An action was accepted or settled: holds and balances moved, fetch now instead of waiting.
  const activity = useActivityVersion();
  useEffect(() => {
    if (id && activity > 0) load();
  }, [activity, id, load]);

  const current = state && state.id === id ? state : null;
  return { portfolio: current?.data ?? null, error: current?.error ?? null, refresh: load, keyId: id };
}
