"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api, errorText } from "@/lib/api/client";
import type { Portfolio } from "@/lib/api/types";
import { applyActionStatuses, onActionAccepted } from "@/lib/activity";
import { getSigner, useKeyState } from "@/lib/crypto/session";
import type { Network } from "@/lib/network";

/**
 * One signed GET /api/portfolio loop per tab, for the unlocked key of the selected network.
 *
 * The rhythm is fixed: every 10-15 s (random jitter), whether or not anything is pending, on every page
 * while the key is unlocked. It never speeds up while an action waits and never stops when one
 * settles: otherwise the request pattern itself tells a network observer when a trade or withdrawal
 * happened (analysis now-mode N-2). Statuses of our own actions ride along in `Portfolio.actions`.
 * The only off-rhythm fetches are right after an action is accepted (the POST already revealed that
 * moment) and the user's own "refresh" taps.
 */
export const POLL_MIN_MS = 10_000;
export const POLL_JITTER_MS = 5_000;

type Entry = { id: string; data: Portfolio | null; error: string | null };

let activeId: string | null = null;
let entry: Entry | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: string | null = null;
let again = false;
let subscribers = 0;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

async function load() {
  const id = activeId;
  const signer = getSigner();
  if (!id || !signer) return;
  if (inflight === id) {
    again = true;
    return;
  }
  inflight = id;
  try {
    const data = await api.getPortfolio(signer);
    if (activeId !== id) return;
    entry = { id, data, error: null };
    const [network, pubkey] = id.split(":") as [Network, string];
    applyActionStatuses(network, pubkey, data.actions);
  } catch (e) {
    if (activeId !== id) return;
    entry = { id, data: entry?.id === id ? entry.data : null, error: errorText(e) };
  } finally {
    if (inflight === id) inflight = null;
    emit();
    if (again) {
      again = false;
      void load();
    }
  }
}

function tick() {
  if (typeof document === "undefined" || document.visibilityState === "visible") void load();
  timer = setTimeout(tick, POLL_MIN_MS + Math.random() * POLL_JITTER_MS);
}

function setActive(id: string | null) {
  if (id === activeId) return;
  activeId = id;
  if (timer) clearTimeout(timer);
  timer = null;
  if (entry?.id !== id) entry = null;
  if (id) tick();
  emit();
}

let unsubAccepted: (() => void) | null = null;

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Keeps the loop alive while at least one component (the app-wide PortfolioSync) wants it. */
function useLoop(id: string | null) {
  useEffect(() => {
    subscribers++;
    if (!unsubAccepted) unsubAccepted = onActionAccepted(() => void load());
    return () => {
      subscribers--;
      if (subscribers === 0) {
        setActive(null);
        unsubAccepted?.();
        unsubAccepted = null;
      }
    };
  }, []);
  useEffect(() => {
    setActive(id);
  }, [id]);
}

export function usePortfolio() {
  const key = useKeyState();
  const id = key.status === "unlocked" ? `${key.network}:${key.pubkey}` : null;
  useLoop(id);
  const current = useSyncExternalStore(subscribe, () => entry, () => null);
  const mine = current && current.id === id ? current : null;
  return { portfolio: mine?.data ?? null, error: mine?.error ?? null, refresh: load, keyId: id };
}
