"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/lib/api/client";
import { getSigner, useKeyState } from "@/lib/crypto/session";

// Mints this key launched (GET /api/creator, signed, owner only), for the chat's "Post as creator" and
// "Hide". Fetched once per unlocked key and tab, kept in memory only, never written anywhere.

let cache: { id: string; mints: ReadonlySet<string> } | null = null;
let inflight: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const EMPTY: ReadonlySet<string> = new Set();

export function useCreatorMints(enabled: boolean): ReadonlySet<string> {
  const key = useKeyState();
  const id = key.status === "unlocked" ? `${key.network}:${key.pubkey}` : null;
  useEffect(() => {
    if (!enabled || !id || cache?.id === id || inflight === id) return;
    const signer = getSigner();
    if (!signer) return;
    inflight = id;
    api
      .getCreator(signer)
      .then((c) => {
        cache = { id, mints: new Set(c.tokens.map((t) => t.mint)) };
      })
      .catch(() => {
        cache = { id, mints: EMPTY };
      })
      .finally(() => {
        inflight = null;
        emit();
      });
  }, [enabled, id]);
  const got = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => cache,
    () => null,
  );
  return got && got.id === id ? got.mints : EMPTY;
}
