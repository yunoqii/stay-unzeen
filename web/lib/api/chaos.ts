// uz-chaos: dev-only failure injection for the in-browser mock (NEXT_PUBLIC_MOCK_CHAOS=1). Lets you see
// every error state without a broken backend. Never part of a public build: it is imported only behind
// the literal env check, and lib/fair/bundle.test.ts fails the public build if "uz-chaos" is in any chunk.

import { setBrowserOnline } from "@/lib/connectivity";
import { lock } from "@/lib/crypto/session";
import { ApiError } from "./errors";

export const CHAOS_MARK = "uz-chaos";
export type ChaosMode = "off" | "5xx" | "429" | "offline" | "slow" | "expired";
export const CHAOS_MODES: { id: ChaosMode; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "Normal mock" },
  { id: "5xx", label: "Server error", hint: "Every call answers 500" },
  { id: "429", label: "Rate limited", hint: "429 with Retry-After: 12" },
  { id: "offline", label: "Offline", hint: "The browser goes offline" },
  { id: "slow", label: "Slow network", hint: "+6.5 s per call" },
  { id: "expired", label: "Session expired", hint: "Locks the key; signed calls get 401" },
];

let mode: ChaosMode = "off";
const listeners = new Set<() => void>();

export function getChaos(): ChaosMode {
  return mode;
}

export function setChaos(m: ChaosMode) {
  const prev = mode;
  mode = m;
  if (prev === "offline" && m !== "offline") setBrowserOnline(true);
  if (m === "offline") setBrowserOnline(false);
  if (m === "expired") lock();
  listeners.forEach((l) => l());
}

export function subscribeChaos(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** Runs before every mock call. */
export async function chaosGate(signed: boolean): Promise<void> {
  switch (mode) {
    case "5xx":
      throw new ApiError("internal", `${CHAOS_MARK}: 500`, 500);
    case "429":
      throw new ApiError("rate_limited", `${CHAOS_MARK}: 429`, 429, undefined, 12);
    case "offline":
      throw new ApiError("network", `${CHAOS_MARK}: offline`);
    case "slow":
      await new Promise((r) => setTimeout(r, 6_500));
      return;
    case "expired":
      if (signed) throw new ApiError("unauthorized", `${CHAOS_MARK}: 401`, 401);
      return;
  }
}
