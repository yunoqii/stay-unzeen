"use client";

// Scenario drafts and the local names of signed plans. Never in plain localStorage (scenarios.md §4.2, S-12):
// a draft holds intentions and withdrawal addresses. AES-GCM with the history key, which exists only while
// the anon key is unlocked, in the same IndexedDB slot family as the trade history; wiped with it on Forget
// device. The server never sees a name or a template id.

import { useEffect, useSyncExternalStore } from "react";
import { base64 } from "@scure/base";
import { getHistoryKey, useKeyState } from "@/lib/crypto/session";
import { localKv, scenarioSlot } from "@/lib/history/store";
import type { Network } from "@/lib/network";
import type { Draft } from "./draft";
import type { ScenarioPlan } from "@/lib/api/types";

const V = 1;
const MAX_DRAFTS = 12;
const MAX_SIGNED = 30;

export interface SignedName {
  name: string;
  template?: string;
  at: number;
  /**
   * The signed plan with its sealed values (withdrawal addresses, chat text, launch name). The server keeps
   * none of them in its echo (review-scenarios.md 2), so My scenarios shows them from here, on this device only.
   */
  plan?: ScenarioPlan;
}

export interface ScenarioFile {
  v: typeof V;
  drafts: Draft[];
  /** Draft open in the builder. */
  current?: string;
  /** Scenario id -> local name. */
  signed: Record<string, SignedName>;
}

const EMPTY: ScenarioFile = { v: V, drafts: [], signed: {} };

const enc = new TextEncoder();
const dec = new TextDecoder();
const aad = (network: Network, pubkey: string) => copy(enc.encode(`unzeen/scenarios/v${V}\n${network}\n${pubkey}`));
function copy(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.length);
  out.set(u);
  return out;
}

export async function sealScenarioFile(key: CryptoKey, network: Network, pubkey: string, file: ScenarioFile) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(network, pubkey) }, key, enc.encode(JSON.stringify(file))));
  return { v: V, iv: base64.encode(iv), ct: base64.encode(ct) } as const;
}

export async function openScenarioFile(key: CryptoKey, network: Network, pubkey: string, raw: unknown): Promise<ScenarioFile> {
  const blob = raw as { v?: number; iv?: string; ct?: string } | undefined;
  if (!blob || blob.v !== V || typeof blob.iv !== "string" || typeof blob.ct !== "string") return { ...EMPTY };
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: copy(base64.decode(blob.iv)), additionalData: aad(network, pubkey) }, key, copy(base64.decode(blob.ct)));
    const f = JSON.parse(dec.decode(plain)) as ScenarioFile;
    return f && f.v === V && Array.isArray(f.drafts) && f.signed && typeof f.signed === "object" ? f : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

// ---- one loaded file per unlocked key ----

let loaded: { id: string; file: ScenarioFile } | null = null;
let loading: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

async function load(network: Network, pubkey: string) {
  const id = scenarioSlot(network, pubkey);
  if (loaded?.id === id || loading === id) return;
  const k = getHistoryKey(network);
  if (!k || k.pubkey !== pubkey) return;
  loading = id;
  try {
    const file = await openScenarioFile(await k.key, network, pubkey, await localKv().get(id));
    if (loading === id) loaded = { id, file };
  } catch {
    if (loading === id) loaded = { id, file: { ...EMPTY } };
  } finally {
    if (loading === id) loading = null;
    emit();
  }
}

let writing: Promise<void> = Promise.resolve();

async function write(network: Network, pubkey: string, f: (file: ScenarioFile) => ScenarioFile | null) {
  await load(network, pubkey);
  const id = scenarioSlot(network, pubkey);
  if (loaded?.id !== id) return;
  const next = f(loaded.file);
  if (!next) return;
  loaded = { id, file: next };
  emit();
  const k = getHistoryKey(network);
  if (!k || k.pubkey !== pubkey) return;
  const snapshot = next;
  writing = writing
    .then(async () => localKv().put(id, (await sealScenarioFile(await k.key, network, pubkey, snapshot)) as never))
    .catch(() => {
      /* storage blocked: the memory copy still serves this tab */
    });
  await writing;
}

export function saveDraft(network: Network, pubkey: string, draft: Draft): Promise<void> {
  return write(network, pubkey, (file) => {
    const rest = file.drafts.filter((d) => d.id !== draft.id);
    return { ...file, current: draft.id, drafts: [draft, ...rest].slice(0, MAX_DRAFTS) };
  });
}

export function deleteDraft(network: Network, pubkey: string, id: string): Promise<void> {
  return write(network, pubkey, (file) => ({ ...file, drafts: file.drafts.filter((d) => d.id !== id), current: file.current === id ? undefined : file.current }));
}

export function setCurrentDraft(network: Network, pubkey: string, id: string | undefined): Promise<void> {
  return write(network, pubkey, (file) => (file.current === id ? null : { ...file, current: id }));
}

/** After a plan is signed: remember its local name, drop the draft it came from. */
export function rememberSigned(network: Network, pubkey: string, scenarioId: string, name: SignedName, draftId?: string): Promise<void> {
  return write(network, pubkey, (file) => {
    const signed = { ...file.signed, [scenarioId]: name };
    const keys = Object.keys(signed);
    if (keys.length > MAX_SIGNED) {
      keys.sort((a, b) => signed[a].at - signed[b].at);
      for (const k of keys.slice(0, keys.length - MAX_SIGNED)) delete signed[k];
    }
    const drafts = draftId ? file.drafts.filter((d) => d.id !== draftId) : file.drafts;
    return { ...file, signed, drafts, current: draftId && file.current === draftId ? undefined : file.current };
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export interface ScenarioStoreView {
  ready: boolean;
  file: ScenarioFile;
}

const NONE: ScenarioStoreView = { ready: false, file: EMPTY };
let cache: { file: ScenarioFile; view: ScenarioStoreView } | null = null;

/** Decrypted drafts and names of the unlocked key; empty while locked. */
export function useScenarioStore(): ScenarioStoreView {
  const key = useKeyState();
  const unlocked = key.status === "unlocked" ? key : null;
  useEffect(() => {
    if (unlocked) void load(unlocked.network, unlocked.pubkey);
    else if (loaded) {
      loaded = null;
      emit();
    }
  }, [unlocked]);
  const id = unlocked ? scenarioSlot(unlocked.network, unlocked.pubkey) : null;
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!loaded || loaded.id !== id) return NONE;
      if (cache?.file !== loaded.file) cache = { file: loaded.file, view: { ready: true, file: loaded.file } };
      return cache.view;
    },
    () => NONE,
  );
}
