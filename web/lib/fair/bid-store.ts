"use client";

// Own sealed bids, kept only in this browser and only encrypted (docs/API.md v0.6: "the amount and the
// ciphertext are stored locally, encrypted, for display and the inclusion check"). Same key as the
// local trade history (HKDF from the unlocked anon secret, lib/history/crypto.ts), separate AAD and
// slot. The server never sees the amount before the drand round; this store is how the UI can.

import { useEffect, useSyncExternalStore } from "react";
import { base64 } from "@scure/base";
import { getHistoryKey, useKeyState } from "@/lib/crypto/session";
import { historySlot } from "@/lib/history/crypto";
import type { FairBid } from "@/lib/api/types";
import type { Network } from "@/lib/network";

export interface LocalBid {
  launchId: string;
  amountZat: string;
  holdZat: string;
  /** Exactly the string sent in fl_bid: its sha256 is the commitment leaf. */
  ciphertext: string;
  sealedAt: number;
  /** Written before fl_bid is sent; cleared when the server accepted it, removed when it refused (review F12). */
  pending?: boolean;
}

const V = 1;
const DB = "unzeen-local";
const STORE = "history";
const enc = new TextEncoder();
const dec = new TextDecoder();

function buf(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.length);
  out.set(u);
  return out;
}

const slotOf = (network: Network, pubkey: string) => `${historySlot(network, pubkey)}:s`;
const aad = (network: Network, pubkey: string) => buf(enc.encode(`unzeen/sealed/v${V}\n${network}\n${pubkey}`));

// ---- storage (IndexedDB, memory fallback) ----

interface Kv {
  get(k: string): Promise<unknown>;
  put(k: string, v: unknown): Promise<void>;
}

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
          const r = f(d.transaction(STORE, mode).objectStore(STORE));
          r.onsuccess = () => resolve(r.result as T);
          r.onerror = () => reject(r.error);
        }),
    );
  return { get: (k) => run("readonly", (s) => s.get(k)), put: (k, v) => run("readwrite", (s) => s.put(v, k)) };
}

let kv: Kv | null = null;
const mem = new Map<string, unknown>();
const storage = (): Kv => (kv ??= idb() ?? { get: async (k) => mem.get(k), put: async (k, v) => void mem.set(k, v) });

async function encrypt(key: CryptoKey, network: Network, pubkey: string, bids: LocalBid[]) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(network, pubkey) }, key, enc.encode(JSON.stringify({ v: V, bids }))));
  return { v: V, iv: base64.encode(iv), ct: base64.encode(ct) };
}

async function decrypt(key: CryptoKey, network: Network, pubkey: string, raw: unknown): Promise<LocalBid[]> {
  if (!raw || typeof raw !== "object") return [];
  const b = raw as { v?: unknown; iv?: unknown; ct?: unknown };
  if (b.v !== V || typeof b.iv !== "string" || typeof b.ct !== "string") return [];
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(base64.decode(b.iv)), additionalData: aad(network, pubkey) }, key, buf(base64.decode(b.ct)));
  const file = JSON.parse(dec.decode(plain)) as { v: number; bids: LocalBid[] };
  return Array.isArray(file.bids) ? file.bids : [];
}

// ---- state ----

type Status = "locked" | "loading" | "ready";
interface Slot {
  id: string;
  network: Network;
  pubkey: string;
  status: Status;
  bids: LocalBid[];
  load: Promise<void>;
  write: Promise<void>;
}

const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function open(network: Network, pubkey: string): Slot | null {
  const k = getHistoryKey(network);
  if (!k || k.pubkey !== pubkey) return null;
  const id = slotOf(network, pubkey);
  const hit = slots.get(id);
  if (hit) return hit;
  const s: Slot = { id, network, pubkey, status: "loading", bids: [], load: Promise.resolve(), write: Promise.resolve() };
  s.load = (async () => {
    try {
      s.bids = await decrypt(await k.key, network, pubkey, await storage().get(id));
    } catch {
      s.bids = [];
    }
    s.status = "ready";
    emit();
  })();
  slots.set(id, s);
  return s;
}

async function mutate(network: Network, pubkey: string, f: (b: LocalBid[]) => LocalBid[]) {
  const s = open(network, pubkey);
  if (!s) return;
  await s.load;
  s.bids = f(s.bids);
  emit();
  const k = getHistoryKey(network);
  if (!k || k.pubkey !== pubkey) return;
  const key = await k.key;
  const snapshot = s.bids;
  s.write = s.write.then(async () => storage().put(s.id, await encrypt(key, network, pubkey, snapshot))).catch(() => {
    /* storage blocked: the in-memory copy serves this tab */
  });
  await s.write;
}

/** Keep at most this many (oldest dropped): bids are only useful until the launch settles. */
const KEEP = 50;

export function saveLocalBid(network: Network, pubkey: string, input: Omit<LocalBid, "sealedAt">) {
  const bid: LocalBid = { ...input, sealedAt: Date.now() };
  return mutate(network, pubkey, (b) => [bid, ...b.filter((x) => x.launchId !== bid.launchId)].slice(0, KEEP));
}

export function removeLocalBid(network: Network, pubkey: string, launchId: string) {
  return mutate(network, pubkey, (b) => b.filter((x) => x.launchId !== launchId));
}

/** A pending copy whose fl_bid never showed up in the portfolio after this long is dropped. */
const PENDING_TTL_MS = 10 * 60_000;
/** A bid the portfolio no longer lists (it keeps the last 20) is dropped after this long. */
const STALE_MS = 48 * 3_600_000;
/** Server states after which the local amount and ciphertext have no use left (reveal, withdraw, fail). */
const DONE: ReadonlySet<FairBid["status"]> = new Set(["cancelled", "invalid", "revealed", "settled", "released"]);

/** Which local copies to drop, given the key's bids as the server reports them. */
export function bidsToPrune(local: LocalBid[], server: FairBid[], now: number): string[] {
  const byId = new Map(server.map((b) => [b.launchId, b]));
  return local
    .filter((l) => {
      const s = byId.get(l.launchId);
      if (s) return DONE.has(s.status);
      return now - l.sealedAt > (l.pending ? PENDING_TTL_MS : STALE_MS);
    })
    .map((l) => l.launchId);
}

/**
 * After reveal / withdraw / a failed launch the ciphertext would reveal the amount to anyone holding the
 * history key: delete it (review F12). Call with Portfolio.fairBids whenever it refreshes.
 */
export function pruneLocalBids(network: Network, pubkey: string, server: FairBid[]) {
  const s = slots.get(slotOf(network, pubkey));
  if (!s || s.status !== "ready") return;
  const drop = new Set(bidsToPrune(s.bids, server, Date.now()));
  if (drop.size === 0) return;
  return mutate(network, pubkey, (b) => b.filter((x) => !drop.has(x.launchId)));
}

/** Prune on every portfolio refresh of the unlocked key. */
export function usePruneLocalBids(server: FairBid[] | undefined) {
  const key = useKeyState();
  const ready = useLocalBids().status === "ready";
  const pubkey = key.status === "unlocked" ? key.pubkey : null;
  const network = key.status === "unlocked" ? key.network : null;
  useEffect(() => {
    if (pubkey && network && server && ready) void pruneLocalBids(network, pubkey, server);
  }, [pubkey, network, server, ready]);
}

const LOCKED = { status: "locked" as Status, bids: [] as LocalBid[] };
const LOADING = { status: "loading" as Status, bids: [] as LocalBid[] };
const views = new Map<string, { bids: LocalBid[]; status: Status; view: { status: Status; bids: LocalBid[] } }>();

/** Decrypted own bids of the unlocked key on the current network. */
export function useLocalBids(): { status: Status; bids: LocalBid[] } {
  const key = useKeyState();
  const unlocked = key.status === "unlocked" ? key : null;
  useEffect(() => {
    // Locked keys lose their decrypted copy.
    for (const [id, s] of slots) {
      const k = getHistoryKey(s.network);
      if (!k || k.pubkey !== s.pubkey) slots.delete(id);
    }
    if (unlocked) open(unlocked.network, unlocked.pubkey);
  }, [unlocked]);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => {
      if (!unlocked) return LOCKED;
      const s = slots.get(slotOf(unlocked.network, unlocked.pubkey));
      if (!s) return LOADING;
      const c = views.get(s.id);
      if (c && c.bids === s.bids && c.status === s.status) return c.view;
      const view = { status: s.status, bids: s.bids };
      views.set(s.id, { bids: s.bids, status: s.status, view });
      return view;
    },
    () => LOCKED,
  );
}
