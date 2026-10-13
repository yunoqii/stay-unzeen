// App-wide connection state for the offline / API-down / slow-network banner (docs/design/ux-states.md).
// Fed by the API client (every call reports start and outcome) and by the browser's online events.
// Memory only.

import { useSyncExternalStore } from "react";

export type Connection = "ok" | "offline" | "down" | "slow";

/** A request still running after this is "slow". */
export const SLOW_MS = 5_000;

let browserOnline = true;
/** Consecutive transport failures (network error or 5xx), reset by any success. */
let failures = 0;
const inflight = new Map<number, number>(); // id -> started at
let seq = 0;
let slowTimer: ReturnType<typeof setTimeout> | null = null;
let snapshot: Connection = "ok";
const listeners = new Set<() => void>();

function compute(now = Date.now()): Connection {
  if (!browserOnline) return "offline";
  if (failures >= 2) return "down";
  for (const t of inflight.values()) if (now - t >= SLOW_MS) return "slow";
  return "ok";
}

function emit() {
  const next = compute();
  if (next === snapshot) return;
  snapshot = next;
  listeners.forEach((l) => l());
}

function armSlow() {
  if (slowTimer) clearTimeout(slowTimer);
  slowTimer = null;
  if (inflight.size === 0) return;
  const oldest = Math.min(...inflight.values());
  slowTimer = setTimeout(emit, Math.max(0, oldest + SLOW_MS - Date.now()) + 10);
}

/** Called by the API client around every request. Returns the finisher. */
export function trackRequest(): (outcome: "ok" | "transport" | "http") => void {
  const id = ++seq;
  inflight.set(id, Date.now());
  armSlow();
  return (outcome) => {
    inflight.delete(id);
    if (outcome === "ok" || outcome === "http") failures = 0;
    else failures++;
    armSlow();
    emit();
  };
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1 && typeof window !== "undefined") {
    browserOnline = navigator.onLine;
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    emit();
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    }
  };
}
function onOnline() {
  browserOnline = true;
  failures = 0;
  emit();
}
function onOffline() {
  browserOnline = false;
  emit();
}

/** Test / chaos hook: pretend the browser went offline or came back. */
export function setBrowserOnline(v: boolean) {
  if (v) onOnline();
  else onOffline();
}

export function useConnection(): Connection {
  return useSyncExternalStore(subscribe, () => snapshot, () => "ok");
}

export const connectionForTests = { compute, reset: () => ((failures = 0), inflight.clear(), (browserOnline = true)) };
