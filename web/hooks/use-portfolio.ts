"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "@/lib/api/client";
import type { Portfolio } from "@/lib/api/types";
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

  const load = useCallback(async () => {
    const signer = getSigner();
    if (!id || !signer || inflight.current === id) return;
    inflight.current = id;
    try {
      const data = await api.getPortfolio(signer);
      setState({ id, data, error: null });
    } catch (e) {
      setState((s) => ({ id, data: s?.id === id ? s.data : null, error: errorText(e) }));
    } finally {
      if (inflight.current === id) inflight.current = null;
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

  const current = state && state.id === id ? state : null;
  return { portfolio: current?.data ?? null, error: current?.error ?? null, refresh: load, keyId: id };
}
