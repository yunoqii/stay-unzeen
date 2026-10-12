// Encryption of the local trade history (T4). AES-256-GCM with a key derived by HKDF-SHA256 from the
// anon secret key, which only exists in memory after the vault was unlocked with the password. So the
// history is readable exactly when the key is unlocked, and is gone with the password otherwise.
// One blob per network and anon key; network and pubkey are bound through AAD.

import { base64 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Network } from "@/lib/network";
import type { Fill } from "@/lib/pnl";

export const HISTORY_VERSION = 1;

/** What the browser remembers about one of its own actions. Never a Solana tx signature, never a destination. */
export interface HistoryEntry {
  /** Action id from POST /api/actions. */
  id: string;
  kind: Fill["kind"];
  /** Unknown for a create until it executes (fill.mint). */
  mint?: string;
  symbol?: string;
  decimals?: number;
  submittedAt: number;
  /**
   * pending: accepted, not settled yet; executed: `fill` known; expired: the server dropped the action
   * before this browser saw it settle (retention 24-48 h), so PnL is incomplete.
   */
  status: "pending" | "executed" | "expired";
  fill?: Fill;
}

export interface HistoryFile {
  v: typeof HISTORY_VERSION;
  network: Network;
  entries: HistoryEntry[];
}

export interface EncryptedHistory {
  v: typeof HISTORY_VERSION;
  iv: string;
  ct: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function buf(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.length);
  out.set(u);
  return out;
}

const aad = (network: Network, pubkey: string) => buf(enc.encode(`unzeen/history/v${HISTORY_VERSION}\n${network}\n${pubkey}`));

/** Non-extractable AES-GCM key for this network's history, from the unlocked anon secret. */
export async function deriveHistoryKey(secret: Uint8Array, network: Network): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", buf(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(enc.encode("unzeen/history/v1")), info: buf(enc.encode(network)) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptHistory(key: CryptoKey, network: Network, pubkey: string, entries: HistoryEntry[]): Promise<EncryptedHistory> {
  const file: HistoryFile = { v: HISTORY_VERSION, network, entries };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(network, pubkey) }, key, enc.encode(JSON.stringify(file))));
  return { v: HISTORY_VERSION, iv: base64.encode(iv), ct: base64.encode(ct) };
}

export class HistoryDecryptError extends Error {
  constructor() {
    super("History cannot be decrypted with this key");
    this.name = "HistoryDecryptError";
  }
}

export async function decryptHistory(key: CryptoKey, network: Network, pubkey: string, blob: EncryptedHistory): Promise<HistoryEntry[]> {
  if (blob.v !== HISTORY_VERSION) throw new HistoryDecryptError();
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(base64.decode(blob.iv)), additionalData: aad(network, pubkey) }, key, buf(base64.decode(blob.ct)));
  } catch {
    throw new HistoryDecryptError();
  }
  const file = JSON.parse(dec.decode(plain)) as HistoryFile;
  if (file.v !== HISTORY_VERSION || file.network !== network || !Array.isArray(file.entries)) throw new HistoryDecryptError();
  return file.entries;
}

/** Storage slot id: network + a hash of the pubkey, so the store's keys do not spell out the anon key. */
export function historySlot(network: Network, pubkey: string): string {
  return `${network}:${bytesToHex(sha256(enc.encode(`unzeen/history-slot\n${pubkey}`))).slice(0, 32)}`;
}

export function isEncryptedHistory(x: unknown): x is EncryptedHistory {
  if (!x || typeof x !== "object") return false;
  const v = x as Partial<EncryptedHistory>;
  return v.v === HISTORY_VERSION && typeof v.iv === "string" && typeof v.ct === "string";
}
