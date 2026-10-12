"use client";

// Encrypted local trade history (T4): IndexedDB, one blob per network and anon key, AES-GCM with a key
// that exists only while the anon key is unlocked (lib/history/crypto.ts). No sync with the server, no
// Solana tx signatures, no withdrawal destinations. Fed by:
//   - recordSubmitted(): right after POST /api/actions is accepted (only the id, kind and mint);
//   - applyPolledStatuses(): the regular fixed-interval portfolio poll (Portfolio.actions + fill).

import { useEffect, useSyncExternalStore } from "react";
import type { ActionStatus } from "@/lib/api/types";
import { getHistoryKey, useKeyState } from "@/lib/crypto/session";
import type { Network } from "@/lib/network";
import { decryptHistory, encryptHistory, historySlot, isEncryptedHistory, type EncryptedHistory, type HistoryEntry } from "./crypto";
import { addPending, applyStatuses } from "./reduce";

// ---- key-value storage ----

interface Kv {
  get(slot: string): Promise<unknown>;
  put(slot: string, value: EncryptedHistory): Promise<void>;
  del(slot: string): Promise<void>;
}

const DB = "unzeen-local";
const STORE = "history";

function idb(): Kv | null {
  if (typeof indexedDB === "undefined") return null;
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> =>
    open().then(
      (d) =>
        new Promise<T>((resolve, reject) => {
          const req = f(d.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result as T);
          req.onerror = () => reject(req.error);
        }),
    );
  return {
    get: (slot) => run("readonly", (s) => s.get(slot)),
    put: (slot, v) => run("readwrite", (s) => s.put(v, slot)),
    del: (slot) => run("readwrite", (s) => s.delete(slot)),
  };
}

function memoryKv(): Kv {
  const m = new Map<string, EncryptedHistory>();
  return { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, v), del: async (k) => void m.delete(k) };
}

let kv: Kv | null = null;
/** IndexedDB when available; memory-only otherwise (private windows that block it). */
function storage(): Kv {
  return (kv ??= idb() ?? memoryKv());
}

// ---- state per slot ----

type Status = "loading" | "ready" | "error";
interface Slot {
  network: Network;
  pubkey: string;
  status: Status;
  entries: HistoryEntry[];
  load: Promise<void>;
  write: Promise<void>;
}

const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

/** Slot for the unlocked key of `network`, loading it on first use; null when locked or another key. */
function open(network: Network, pubkey: string): Slot | null {
  const k = getHistoryKey(network);
  if (!k || k.pubkey !== pubkey) return null;
  const id = historySlot(network, pubkey);
  let s = slots.get(id);
  if (s) return s;
  const slot: Slot = { network, pubkey, status: "loading", entries: [], load: Promise.resolve(), write: Promise.resolve() };
  slot.load = (async () => {
    try {
      const raw = await storage().get(id);
      const key = await k.key;
      slot.entries = isEncryptedHistory(raw) ? await decryptHistory(key, network, pubkey, raw) : [];
      slot.status = "ready";
    } catch {
      // Undecryptable (other key / tampered): start clean rather than lose new trades.
      slot.entries = [];
      slot.status = "error";
    }
    emit();
  })();
  slots.set(id, slot);
  s = slot;
  return s;
}

async function mutate(network: Network, pubkey: string, f: (e: HistoryEntry[]) => HistoryEntry[]) {
  const s = open(network, pubkey);
  if (!s) return;
  await s.load;
  const next = f(s.entries);
  if (next === s.entries) return;
  s.entries = next;
  emit();
  const k = getHistoryKey(network);
  if (!k || k.pubkey !== pubkey) return; // locked meanwhile: memory copy is dropped below on lock
  const key = await k.key;
  const snapshot = next;
  s.write = s.write
    .then(async () => storage().put(historySlot(network, pubkey), await encryptHistory(key, network, pubkey, snapshot)))
    .catch(() => {
      /* storage full / blocked: the in-memory copy still serves this tab */
    });
  await s.write;
}

/** Right after the pool accepted an action. Only trades and token withdrawals matter for PnL. */
export function recordSubmitted(network: Network, pubkey: string, entry: Omit<HistoryEntry, "status" | "fill">): Promise<void> {
  return mutate(network, pubkey, (e) => addPending(e, entry));
}

/** From every portfolio poll (fixed rhythm; nothing extra is requested for the history). */
export function applyPolledStatuses(network: Network, pubkey: string, polled: (ActionStatus & { id: string })[] | undefined, now = Date.now()): Promise<void> {
  return mutate(network, pubkey, (e) => applyStatuses(e, polled, now));
}

/** Delete this key's history on this device (Forget device). */
export async function forgetHistory(network: Network, pubkey: string): Promise<void> {
  const id = historySlot(network, pubkey);
  slots.delete(id);
  emit();
  try {
    await storage().del(id);
  } catch {
    /* nothing stored */
  }
}

/** Drop decrypted copies of keys that are no longer unlocked. */
function dropLocked() {
  let changed = false;
  for (const [id, s] of slots) {
    const k = getHistoryKey(s.network);
    if (!k || k.pubkey !== s.pubkey) {
      slots.delete(id);
      changed = true;
    }
  }
  if (changed) emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export interface HistoryView {
  status: "locked" | Status;
  entries: readonly HistoryEntry[];
}

const LOCKED: HistoryView = { status: "locked", entries: [] };
const LOADING: HistoryView = { status: "loading", entries: [] };
const cache = new Map<string, { v: number; view: HistoryView }>();

/** Decrypted history of the unlocked key on the current network ("locked" otherwise). */
export function useHistory(): HistoryView {
  const key = useKeyState();
  const unlocked = key.status === "unlocked" ? key : null;
  useEffect(() => {
    dropLocked();
    if (unlocked) open(unlocked.network, unlocked.pubkey);
  }, [unlocked]);
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!unlocked) return LOCKED;
      const id = historySlot(unlocked.network, unlocked.pubkey);
      const s = slots.get(id);
      if (!s) return LOADING;
      const hit = cache.get(id);
      if (hit && hit.v === version) return hit.view;
      const view: HistoryView = { status: s.status, entries: s.entries };
      cache.set(id, { v: version, view });
      return view;
    },
    () => LOCKED,
  );
}
