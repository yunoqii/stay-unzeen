"use client";

// The trading workspace of the unlocked key: watchlist, price alerts and notification switches. Same rules as
// scenario drafts (lib/scenarios/store.ts): AES-GCM with the history key (exists only while the anon key is
// unlocked), one blob per network and key in the local IndexedDB, wiped with Forget device. Never sent
// anywhere: the server can't tell which tokens you watch or what you wait for.

import { useEffect, useSyncExternalStore } from "react";
import { base64 } from "@scure/base";
import { getHistoryKey, useKeyState } from "@/lib/crypto/session";
import { localKv, workspaceSlot } from "@/lib/history/store";
import type { Network } from "@/lib/network";

const V = 1;
export const MAX_WATCH = 50;
export const MAX_ALERTS = 30;

export interface Watched {
  mint: string;
  symbol: string;
  addedAt: number;
}

export type AlertMetric = "price" | "mcap";
export type AlertDir = "above" | "below";

export interface PriceAlert {
  id: string;
  mint: string;
  symbol: string;
  metric: AlertMetric;
  dir: AlertDir;
  /** Threshold in SOL (price per whole token, or market cap): the unit the public token list carries. */
  thresholdSol: number;
  createdAt: number;
  /** Set once it fired; a fired alert stays listed until removed or re-armed. */
  firedAt?: number;
}

export interface WorkspacePrefs {
  /** Toasts for settled batches, triggered orders and scenario steps. */
  toasts: boolean;
  /** A short chime with them (generated in the browser, no audio file). */
  sound: boolean;
}

export interface WorkspaceFile {
  v: typeof V;
  watchlist: Watched[];
  alerts: PriceAlert[];
  prefs: WorkspacePrefs;
}

export const DEFAULT_PREFS: WorkspacePrefs = { toasts: true, sound: true };
export const EMPTY_WORKSPACE: WorkspaceFile = { v: V, watchlist: [], alerts: [], prefs: DEFAULT_PREFS };

const enc = new TextEncoder();
const dec = new TextDecoder();
const aad = (network: Network, pubkey: string) => copy(enc.encode(`unzeen/workspace/v${V}\n${network}\n${pubkey}`));
function copy(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.length);
  out.set(u);
  return out;
}

export async function sealWorkspace(key: CryptoKey, network: Network, pubkey: string, file: WorkspaceFile) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(network, pubkey) }, key, enc.encode(JSON.stringify(file))));
  return { v: V, iv: base64.encode(iv), ct: base64.encode(ct) } as const;
}

/** Decrypt and sanitise; anything unreadable is an empty workspace, never a throw. */
export async function openWorkspace(key: CryptoKey, network: Network, pubkey: string, raw: unknown): Promise<WorkspaceFile> {
  const blob = raw as { v?: number; iv?: string; ct?: string } | undefined;
  if (!blob || blob.v !== V || typeof blob.iv !== "string" || typeof blob.ct !== "string") return { ...EMPTY_WORKSPACE };
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: copy(base64.decode(blob.iv)), additionalData: aad(network, pubkey) }, key, copy(base64.decode(blob.ct)));
    return normalizeWorkspace(JSON.parse(dec.decode(plain)));
  } catch {
    return { ...EMPTY_WORKSPACE };
  }
}

export function normalizeWorkspace(x: unknown): WorkspaceFile {
  const f = x as Partial<WorkspaceFile> | null;
  if (!f || f.v !== V) return { ...EMPTY_WORKSPACE };
  const watchlist = (Array.isArray(f.watchlist) ? f.watchlist : []).filter((w) => w && typeof w.mint === "string" && typeof w.symbol === "string").slice(0, MAX_WATCH);
  const alerts = (Array.isArray(f.alerts) ? f.alerts : [])
    .filter((a) => a && typeof a.mint === "string" && (a.metric === "price" || a.metric === "mcap") && (a.dir === "above" || a.dir === "below") && Number.isFinite(a.thresholdSol) && a.thresholdSol > 0)
    .slice(0, MAX_ALERTS);
  const p = (f.prefs ?? {}) as Partial<WorkspacePrefs>;
  return { v: V, watchlist, alerts, prefs: { toasts: p.toasts !== false, sound: p.sound !== false } };
}

// ---- one loaded file per unlocked key ----

let loaded: { id: string; file: WorkspaceFile } | null = null;
let loading: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

async function load(network: Network, pubkey: string) {
  const id = workspaceSlot(network, pubkey);
  if (loaded?.id === id || loading === id) return;
  const k = getHistoryKey(network);
  if (!k || k.pubkey !== pubkey) return;
  loading = id;
  try {
    const file = await openWorkspace(await k.key, network, pubkey, await localKv().get(id));
    if (loading === id) loaded = { id, file };
  } catch {
    if (loading === id) loaded = { id, file: { ...EMPTY_WORKSPACE } };
  } finally {
    if (loading === id) loading = null;
    emit();
  }
}

let writing: Promise<void> = Promise.resolve();

async function write(network: Network, pubkey: string, f: (file: WorkspaceFile) => WorkspaceFile | null) {
  await load(network, pubkey);
  const id = workspaceSlot(network, pubkey);
  if (loaded?.id !== id) return;
  const next = f(loaded.file);
  if (!next) return;
  loaded = { id, file: next };
  emit();
  const k = getHistoryKey(network);
  if (!k || k.pubkey !== pubkey) return;
  const snapshot = next;
  writing = writing
    .then(async () => localKv().put(id, (await sealWorkspace(await k.key, network, pubkey, snapshot)) as never))
    .catch(() => {
      /* storage blocked: the memory copy still serves this tab */
    });
  await writing;
}

// ---- pure edits (tested) ----

export function toggleWatch(file: WorkspaceFile, w: Omit<Watched, "addedAt">, now: number): WorkspaceFile {
  const has = file.watchlist.some((x) => x.mint === w.mint);
  const watchlist = has ? file.watchlist.filter((x) => x.mint !== w.mint) : [{ ...w, addedAt: now }, ...file.watchlist].slice(0, MAX_WATCH);
  return { ...file, watchlist };
}

export function addAlert(file: WorkspaceFile, a: PriceAlert): WorkspaceFile {
  return { ...file, alerts: [a, ...file.alerts].slice(0, MAX_ALERTS) };
}

export function removeAlert(file: WorkspaceFile, id: string): WorkspaceFile {
  return { ...file, alerts: file.alerts.filter((a) => a.id !== id) };
}

export function markFired(file: WorkspaceFile, ids: string[], now: number): WorkspaceFile {
  if (ids.length === 0) return file;
  const set = new Set(ids);
  return { ...file, alerts: file.alerts.map((a) => (set.has(a.id) ? { ...a, firedAt: now } : a)) };
}

// ---- actions on the unlocked key ----

export const watch = (network: Network, pubkey: string, w: Omit<Watched, "addedAt">) => write(network, pubkey, (f) => toggleWatch(f, w, Date.now()));
export const createAlert = (network: Network, pubkey: string, a: PriceAlert) => write(network, pubkey, (f) => addAlert(f, a));
export const deleteAlert = (network: Network, pubkey: string, id: string) => write(network, pubkey, (f) => removeAlert(f, id));
export const rearmAlert = (network: Network, pubkey: string, id: string) =>
  write(network, pubkey, (f) => ({ ...f, alerts: f.alerts.map((a) => (a.id === id ? { ...a, firedAt: undefined } : a)) }));
export const alertsFired = (network: Network, pubkey: string, ids: string[]) => write(network, pubkey, (f) => markFired(f, ids, Date.now()));
export const setPrefs = (network: Network, pubkey: string, p: Partial<WorkspacePrefs>) => write(network, pubkey, (f) => ({ ...f, prefs: { ...f.prefs, ...p } }));

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export interface WorkspaceView {
  ready: boolean;
  file: WorkspaceFile;
  network?: Network;
  pubkey?: string;
}

const NONE: WorkspaceView = { ready: false, file: EMPTY_WORKSPACE };
let cache: { file: WorkspaceFile; view: WorkspaceView } | null = null;

/** The decrypted workspace of the unlocked key; empty (ready: false) while locked. */
export function useWorkspace(): WorkspaceView {
  const key = useKeyState();
  const unlocked = key.status === "unlocked" ? key : null;
  useEffect(() => {
    if (unlocked) void load(unlocked.network, unlocked.pubkey);
    else if (loaded) {
      loaded = null;
      emit();
    }
  }, [unlocked]);
  const id = unlocked ? workspaceSlot(unlocked.network, unlocked.pubkey) : null;
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!loaded || loaded.id !== id || !unlocked) return NONE;
      if (cache?.file !== loaded.file) cache = { file: loaded.file, view: { ready: true, file: loaded.file, network: unlocked.network, pubkey: unlocked.pubkey } };
      return cache.view;
    },
    () => NONE,
  );
}
