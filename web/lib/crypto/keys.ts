// anon key: BIP-39 (12 words, English) -> seed -> SLIP-0010 ed25519 -> keypair.
// Runs only in the browser. Nothing here is ever sent to the server or logged.

import { generateMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

export { wordlist };

/**
 * SLIP-0010 path for the Unzeen anon key. All levels hardened (ed25519 has no
 * non-hardened derivation). Coin type 133 = Zcash. Changing this changes every
 * user's key: treat as part of the protocol.
 */
export const ANON_KEY_PATH = "m/44'/133'/0'/0'";

const HARDENED = 0x80000000;

export interface AnonKeypair {
  /** 32-byte ed25519 secret (seed form). */
  secretKey: Uint8Array;
  /** 32-byte ed25519 public key. */
  publicKey: Uint8Array;
  /** base58 public key, as sent in x-unzeen-pubkey. */
  pubkey: string;
}

/** Lower-case, single-spaced, NFKD — the canonical form we validate, store and derive from. */
export function normalizeMnemonic(input: string): string {
  return input.normalize("NFKD").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128); // 12 words
}

export function isValidMnemonic(mnemonic: string): boolean {
  const m = normalizeMnemonic(mnemonic);
  return m.split(" ").length === 12 && validateMnemonic(m, wordlist);
}

export function isWord(w: string): boolean {
  return WORDS.has(w.trim().toLowerCase());
}
const WORDS = new Set(wordlist);

function parsePath(path: string): number[] {
  const parts = path.split("/");
  if (parts[0] !== "m") throw new Error("Bad derivation path");
  return parts.slice(1).map((p) => {
    if (!p.endsWith("'")) throw new Error("ed25519 supports hardened derivation only");
    const n = Number(p.slice(0, -1));
    if (!Number.isInteger(n) || n < 0 || n >= HARDENED) throw new Error("Bad path index");
    return n + HARDENED;
  });
}

/** SLIP-0010 ed25519 private key derivation. Returns { key, chainCode }. */
export function slip10Ed25519(seed: Uint8Array, path: string): { key: Uint8Array; chainCode: Uint8Array } {
  let I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);
  for (const index of parsePath(path)) {
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index, false);
    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }
  return { key, chainCode };
}

export function keypairFromSecret(secretKey: Uint8Array): AnonKeypair {
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey, pubkey: base58.encode(publicKey) };
}

export async function keypairFromMnemonic(mnemonic: string): Promise<AnonKeypair> {
  const m = normalizeMnemonic(mnemonic);
  if (!isValidMnemonic(m)) throw new Error("Invalid recovery phrase");
  const seed = await mnemonicToSeed(m, "");
  const { key } = slip10Ed25519(seed, ANON_KEY_PATH);
  seed.fill(0);
  return keypairFromSecret(key);
}
