// Password-encrypted storage of the recovery phrase in this browser.
// WebCrypto only: PBKDF2-SHA256 -> AES-256-GCM. The phrase and the key never leave the device.

import { base64 } from "@scure/base";
import type { Network } from "@/lib/network";
import { keypairAtPath, keypairFromMnemonic, LEGACY_ANON_KEY_PATH, normalizeMnemonic, type AnonKeypair } from "./keys";

/** One vault per network: devnet and mainnet keys never share a slot. */
export const vaultStorageKey = (network: Network) => `unzeen.${network}.vault.v1`;
export const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 guidance for PBKDF2-HMAC-SHA256
export const MIN_PASSWORD_LENGTH = 8;

/**
 * v2: pubkey derived on the per-network path m/44'/133'/<net>'/0' (API v0.3).
 * v1: pubkey on the old shared path m/44'/133'/0'/0'; upgraded to v2 on the next unlock.
 */
export const VAULT_VERSION = 2;

export interface EncryptedVault {
  v: 1 | 2;
  /** The vault is bound to its network via AAD: a devnet vault cannot be dropped into the mainnet slot. */
  network: Network;
  /** base58 anon pubkey, kept in clear so the lock screen can show which key this is. Bound via AAD. */
  pubkey: string;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  ct: string;
  createdAt: number;
}

export class WrongPasswordError extends Error {
  constructor() {
    super("Wrong password");
    this.name = "WrongPasswordError";
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function aad(v: 1 | 2, network: Network, pubkey: string): Uint8Array<ArrayBuffer> {
  return enc.encode(`unzeen/vault/v${v}\n${network}\n${pubkey}`);
}

function random(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptMnemonic(
  mnemonic: string,
  password: string,
  network: Network,
  opts: { iterations?: number } = {},
): Promise<EncryptedVault> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error("Password too short");
  const m = normalizeMnemonic(mnemonic);
  const { pubkey } = await keypairFromMnemonic(m, network);
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS;
  const salt = random(16);
  const iv = random(12);
  const key = await deriveKey(password, salt, iterations);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(VAULT_VERSION, network, pubkey) }, key, enc.encode(m)),
  );
  return {
    v: VAULT_VERSION,
    network,
    pubkey,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: base64.encode(salt) },
    cipher: { name: "AES-GCM", iv: base64.encode(iv) },
    ct: base64.encode(ct),
    createdAt: Date.now(),
  };
}

/**
 * Returns the phrase and its keypair for the vault's network. Throws WrongPasswordError on a bad
 * password or tampered vault. A v1 vault comes back with `upgraded`: the same phrase re-encrypted
 * with the same password as v2; the caller stores it (the anon key changes with the path).
 */
export async function decryptVault(
  vault: EncryptedVault,
  password: string,
): Promise<{ mnemonic: string; keypair: AnonKeypair; upgraded?: EncryptedVault }> {
  if (vault.v !== 1 && vault.v !== 2) throw new Error("Unsupported vault version");
  const key = await deriveKey(password, toBuf(base64.decode(vault.kdf.salt)), vault.kdf.iterations);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toBuf(base64.decode(vault.cipher.iv)),
        additionalData: aad(vault.v, vault.network, vault.pubkey),
      },
      key,
      toBuf(base64.decode(vault.ct)),
    );
  } catch {
    throw new WrongPasswordError();
  }
  const mnemonic = dec.decode(plain);
  if (vault.v === 1) {
    const legacy = await keypairAtPath(mnemonic, LEGACY_ANON_KEY_PATH);
    legacy.secretKey.fill(0);
    if (legacy.pubkey !== vault.pubkey) throw new WrongPasswordError();
    const upgraded = await encryptMnemonic(mnemonic, password, vault.network, { iterations: vault.kdf.iterations });
    return { mnemonic, keypair: await keypairFromMnemonic(mnemonic, vault.network), upgraded };
  }
  const keypair = await keypairFromMnemonic(mnemonic, vault.network);
  if (keypair.pubkey !== vault.pubkey) throw new WrongPasswordError();
  return { mnemonic, keypair };
}

function toBuf(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.length);
  out.set(u);
  return out;
}

export function isEncryptedVault(x: unknown): x is EncryptedVault {
  if (!x || typeof x !== "object") return false;
  const v = x as Partial<EncryptedVault>;
  return (
    (v.v === 1 || v.v === 2) &&
    (v.network === "devnet" || v.network === "mainnet") &&
    typeof v.pubkey === "string" &&
    typeof v.ct === "string" &&
    v.kdf?.name === "PBKDF2" &&
    typeof v.kdf.salt === "string" &&
    typeof v.kdf.iterations === "number" &&
    v.cipher?.name === "AES-GCM" &&
    typeof v.cipher.iv === "string"
  );
}

// ---- localStorage (client only) ----

export function loadVault(network: Network): EncryptedVault | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(vaultStorageKey(network));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isEncryptedVault(parsed) && parsed.network === network ? parsed : null;
  } catch {
    return null;
  }
}

export function saveVault(vault: EncryptedVault): void {
  window.localStorage.setItem(vaultStorageKey(vault.network), JSON.stringify(vault));
}

export function deleteVault(network: Network): void {
  window.localStorage.removeItem(vaultStorageKey(network));
}
