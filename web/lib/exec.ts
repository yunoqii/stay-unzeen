// Execution mode (docs/FRONTEND.md + docs/ARCHITECTURE.md, execution mode section): Now / Delayed / Max privacy.
// The profile default lives only in this browser, one value per network. It never goes to the server:
// the only thing the pool learns is the `exec` field of the action it is attached to.

import { useSyncExternalStore } from "react";
import type { Network } from "@/lib/network";
import type { ExecMode } from "@/lib/api/types";

export type { ExecMode };
export const EXEC_MODES: readonly ExecMode[] = ["now", "delayed", "max"];
export const DEFAULT_EXEC: ExecMode = "delayed";

export const isExecMode = (v: unknown): v is ExecMode => v === "now" || v === "delayed" || v === "max";

/**
 * Withdrawals are never instant (analysis now-mode R-web-1): an instant withdrawal right after a buy
 * links the trade to the receiving address on-chain. They take Delayed or Max privacy only, and the
 * profile default does not apply to them.
 */
export type WithdrawExecMode = Exclude<ExecMode, "now">;
export const WITHDRAW_EXEC_DEFAULT: WithdrawExecMode = "delayed";

/** Trade labels and timing hints (docs/FRONTEND.md). */
export const EXEC_COPY: Record<ExecMode, { label: string; hint: string }> = {
  now: { label: "Now", hint: "1–3 s · on-chain private, network-visible" },
  delayed: { label: "Delayed", hint: "30–60 s batch · better privacy" },
  max: { label: "Max privacy (5–15 min)", hint: "Waits for a later, bigger batch · best privacy" },
};

/** The honest line under "Now" (R-web-5). */
export const NOW_WARNING = "Fast. Hidden on-chain, but your network provider can see timing — use Tor/VPN or Delayed.";

/** What the queued step says while the action waits. */
export function queuedLabel(mode: ExecMode | undefined): string {
  return mode === "now" ? "Sending…" : "Queued for next batch";
}

/** The switch at the button wins for this one action; otherwise the profile default. */
export function resolveExec(profileDefault: ExecMode, override: ExecMode | null | undefined): ExecMode {
  return override ?? profileDefault;
}

/** Attach the mode to an action body. This is the only place `exec` leaves the browser. */
export function withExec<A extends object, M extends ExecMode>(action: A, mode: M): A & { exec: M } {
  return { ...action, exec: mode };
}

// ---- profile default, per network, local only ----

export const execStorageKey = (n: Network) => `unzeen.exec.${n}`;

const cache: Partial<Record<Network, ExecMode>> = {};
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function getDefaultExec(n: Network): ExecMode {
  const hit = cache[n];
  if (hit) return hit;
  let v: string | null = null;
  try {
    v = storage()?.getItem(execStorageKey(n)) ?? null;
  } catch {
    /* blocked storage */
  }
  const mode = isExecMode(v) ? v : DEFAULT_EXEC;
  cache[n] = mode;
  return mode;
}

export function setDefaultExec(n: Network, mode: ExecMode) {
  cache[n] = mode;
  try {
    storage()?.setItem(execStorageKey(n), mode);
  } catch {
    /* private mode: keep in memory */
  }
  listeners.forEach((l) => l());
}

/** Test helper: forget the in-memory copy so the next read goes to storage. */
export function resetExecCache() {
  for (const k of Object.keys(cache) as Network[]) delete cache[k];
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith("unzeen.exec.")) {
      resetExecCache();
      l();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export function useDefaultExec(n: Network): ExecMode {
  return useSyncExternalStore(subscribe, () => getDefaultExec(n), () => DEFAULT_EXEC);
}

export type NowFee = { zat: bigint } | { lamports: bigint };

/**
 * Flat priority fee of "now" from PoolInfo.fees (R-web-6), never estimated live. The field name is not
 * fixed in docs/API.md yet: `nowFeeZat` (ZEC, preferred) or `nowFeeLamports`. null = not published.
 */
export function nowFee(pool: { fees?: { nowFeeZat?: string; nowFeeLamports?: string } } | null | undefined): NowFee | null {
  const uint = (v?: string) => (v && /^\d+$/.test(v) ? BigInt(v) : null);
  const zat = uint(pool?.fees?.nowFeeZat);
  if (zat !== null) return { zat };
  const lamports = uint(pool?.fees?.nowFeeLamports);
  return lamports !== null ? { lamports } : null;
}
