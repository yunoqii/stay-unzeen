"use client";

// In-memory state of the anon key for this tab, separately per network (devnet / mainnet).
// The unlocked secret lives only in JS memory: never in storage, never in the URL, never in a
// request. Reload = locked again.

import { useSyncExternalStore } from "react";
import { getNetwork, subscribeNetwork, type Network } from "@/lib/network";
import { signerFromSecret, type Signer } from "./sign";
import { MEMO_ALLOWED_OPS, unz1MemoString, type ChainId, type Unz1Fields } from "./unz1";
import { deleteVault, loadVault, saveVault, vaultStorageKey, type EncryptedVault } from "./vault";

export type KeyState =
  | { status: "loading" }
  | { status: "none"; network: Network }
  | { status: "locked"; network: Network; pubkey: string }
  | { status: "unlocked"; network: Network; pubkey: string };

const AUTO_LOCK_MS = 30 * 60_000;

interface Slot {
  vault: EncryptedVault | null | undefined; // undefined = not read yet
  secret: Uint8Array | null;
  pubkey: string | null;
  autoLock?: ReturnType<typeof setTimeout>;
}

const slots: Record<Network, Slot> = {
  devnet: { vault: undefined, secret: null, pubkey: null },
  mainnet: { vault: undefined, secret: null, pubkey: null },
};

let snapshot: KeyState = { status: "loading" };
const listeners = new Set<() => void>();

function slot(n: Network): Slot {
  const s = slots[n];
  if (s.vault === undefined) s.vault = loadVault(n);
  return s;
}

const stateId = (s: KeyState) => s.status + ("network" in s ? s.network : "") + ("pubkey" in s ? s.pubkey : "");

function recompute() {
  const network = getNetwork();
  const s = slot(network);
  const next: KeyState = !s.vault
    ? { status: "none", network }
    : s.secret && s.pubkey === s.vault.pubkey
      ? { status: "unlocked", network, pubkey: s.vault.pubkey }
      : { status: "locked", network, pubkey: s.vault.pubkey };
  if (stateId(next) !== stateId(snapshot)) snapshot = next;
  listeners.forEach((l) => l());
}

let unsubNetwork: (() => void) | null = null;

function subscribe(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1) {
    window.addEventListener("storage", onStorage);
    unsubNetwork = subscribeNetwork(recompute);
  }
  if (snapshot.status === "loading") queueMicrotask(recompute);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
      unsubNetwork?.();
      unsubNetwork = null;
    }
  };
}

/** Another tab replaced or removed a vault: drop our unlocked key if it no longer matches. */
function onStorage(e: StorageEvent) {
  for (const n of ["devnet", "mainnet"] as const) {
    if (e.key !== null && e.key !== vaultStorageKey(n)) continue;
    const s = slots[n];
    s.vault = loadVault(n);
    if (!s.vault || s.vault.pubkey !== s.pubkey) wipe(n);
  }
  recompute();
}

function wipe(n: Network) {
  const s = slots[n];
  s.secret?.fill(0);
  s.secret = null;
  s.pubkey = null;
  clearTimeout(s.autoLock);
}

const SERVER: KeyState = { status: "loading" };

/** Key state for the currently selected network. */
export function useKeyState(): KeyState {
  return useSyncExternalStore(subscribe, () => snapshot, () => SERVER);
}

export function getVault(n: Network = getNetwork()): EncryptedVault | null {
  return slot(n).vault ?? null;
}

/** Store a new vault (in its own network slot) and keep its key unlocked in memory. */
export function storeAndUnlock(vault: EncryptedVault, secretKey: Uint8Array) {
  saveVault(vault);
  slot(vault.network).vault = vault;
  unlock(vault.network, vault.pubkey, secretKey);
}

export function unlock(n: Network, pubkey: string, secretKey: Uint8Array) {
  wipe(n);
  const s = slot(n);
  s.secret = secretKey;
  s.pubkey = pubkey;
  s.autoLock = setTimeout(() => lock(n), AUTO_LOCK_MS);
  recompute();
}

export function lock(n: Network = getNetwork()) {
  wipe(n);
  recompute();
}

export function forgetDevice(n: Network = getNetwork()) {
  wipe(n);
  deleteVault(n);
  slots[n].vault = null;
  recompute();
}

/** Signer for signed API calls on the current network, or null when locked. Never exposes the secret. */
export function getSigner(n: Network = getNetwork()): Signer | null {
  const s = slots[n].secret;
  return s ? signerFromSecret(s) : null;
}

/**
 * Build and sign an unz1 memo locally with this network's key. `chainId` comes from GET /api/pool,
 * already checked against the selected network (lib/deposit.ts). Null when locked.
 */
export function signMemo(fields: Unz1Fields, chainId: ChainId, n: Network = getNetwork()): string | null {
  if (!MEMO_ALLOWED_OPS.includes(fields.op)) throw new Error(`unz1 memo op "${fields.op}" is not accepted by the backend`);
  const s = slots[n].secret;
  return s ? unz1MemoString(fields, s, chainId) : null;
}
