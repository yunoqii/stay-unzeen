"use client";

// Your own chat nicknames per token (from the `nick` of each chat receipt), so the UI can mark your
// messages and offer Delete. Never in plain localStorage (chat.md §10): AES-GCM with the history key,
// which exists only while the anon key is unlocked, in the same IndexedDB as the trade history; wiped
// with it on Forget device. There is no "what is my nick" request: that would tie the key to the mint.

import { useEffect, useSyncExternalStore } from "react";
import { base64 } from "@scure/base";
import { getHistoryKey, useKeyState } from "@/lib/crypto/session";
import { chatSlot, localKv } from "@/lib/history/store";
import type { Network } from "@/lib/network";
import { isNick } from "./feed";

const V = 1;
const MAX_MINTS = 500;

export interface OwnNicks {
  member?: string;
  creator?: string;
}

interface OwnFile {
  v: typeof V;
  nicks: Record<string, OwnNicks & { at: number }>;
  /** You saw the creator-badge warning once. */
  badgeAck?: boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const aad = (network: Network, pubkey: string) => enc.encode(`unzeen/chat-own/v${V}\n${network}\n${pubkey}`);
const copy = (u: Uint8Array) => {
  const out = new Uint8Array(u.length);
  out.set(u);
  return out;
};

async function seal(key: CryptoKey, network: Network, pubkey: string, file: OwnFile) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(network, pubkey) }, key, enc.encode(JSON.stringify(file))));
  return { v: V, iv: base64.encode(iv), ct: base64.encode(ct) } as const;
}

async function open(key: CryptoKey, network: Network, pubkey: string, raw: unknown): Promise<OwnFile> {
  const blob = raw as { v?: number; iv?: string; ct?: string } | undefined;
  if (!blob || blob.v !== V || typeof blob.iv !== "string" || typeof blob.ct !== "string") return { v: V, nicks: {} };
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: copy(base64.decode(blob.iv)), additionalData: aad(network, pubkey) }, key, copy(base64.decode(blob.ct)));
    const f = JSON.parse(dec.decode(plain)) as OwnFile;
    return f && f.v === V && f.nicks && typeof f.nicks === "object" ? f : { v: V, nicks: {} };
  } catch {
    return { v: V, nicks: {} };
  }
}

// ---- one loaded file per unlocked key ----

let loaded: { id: string; file: OwnFile } | null = null;
let loading: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

async function load(network: Network, pubkey: string) {
  const id = chatSlot(network, pubkey);
  if (loaded?.id === id || loading === id) return;
  const k = getHistoryKey(network);
  if (!k || k.pubkey !== pubkey) return;
  loading = id;
  try {
    const file = await open(await k.key, network, pubkey, await localKv().get(id));
    if (loading === id) loaded = { id, file };
  } catch {
    if (loading === id) loaded = { id, file: { v: V, nicks: {} } };
  } finally {
    if (loading === id) loading = null;
    emit();
  }
}

async function write(network: Network, pubkey: string, f: (file: OwnFile) => OwnFile | null) {
  await load(network, pubkey);
  const id = chatSlot(network, pubkey);
  if (loaded?.id !== id) return;
  const next = f(loaded.file);
  if (!next) return;
  loaded = { id, file: next };
  emit();
  const k = getHistoryKey(network);
  if (!k || k.pubkey !== pubkey) return;
  try {
    await localKv().put(id, (await seal(await k.key, network, pubkey, next)) as never);
  } catch {
    /* storage blocked: memory copy still serves this tab */
  }
}

/** Remember the nickname a chat receipt returned for this mint. */
export function rememberNick(network: Network, pubkey: string, mint: string, nick: string, creator: boolean): Promise<void> {
  if (!isNick(nick)) return Promise.resolve();
  return write(network, pubkey, (file) => {
    const cur = file.nicks[mint];
    if (cur && (creator ? cur.creator : cur.member) === nick) return null;
    const nicks = { ...file.nicks, [mint]: { ...cur, [creator ? "creator" : "member"]: nick, at: Date.now() } };
    const keys = Object.keys(nicks);
    if (keys.length > MAX_MINTS) {
      keys.sort((a, b) => nicks[a].at - nicks[b].at);
      for (const k of keys.slice(0, keys.length - MAX_MINTS)) delete nicks[k];
    }
    return { ...file, nicks };
  });
}

export function ackBadge(network: Network, pubkey: string): Promise<void> {
  return write(network, pubkey, (file) => (file.badgeAck ? null : { ...file, badgeAck: true }));
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const NONE = { ready: false, nicks: {} as OwnNicks, badgeAck: false };

/** Your nicknames in this mint's chat; empty while locked. */
export function useOwnChat(mint: string): { ready: boolean; nicks: OwnNicks; badgeAck: boolean } {
  const key = useKeyState();
  const unlocked = key.status === "unlocked" ? key : null;
  useEffect(() => {
    if (unlocked) void load(unlocked.network, unlocked.pubkey);
    else if (loaded) {
      loaded = null;
      emit();
    }
  }, [unlocked]);
  const id = unlocked ? chatSlot(unlocked.network, unlocked.pubkey) : null;
  const file = useSyncExternalStore(
    subscribe,
    () => (loaded && loaded.id === id ? loaded.file : null),
    () => null,
  );
  if (!file) return NONE;
  const n = file.nicks[mint];
  return { ready: true, nicks: n ? { member: n.member, creator: n.creator } : {}, badgeAck: !!file.badgeAck };
}
