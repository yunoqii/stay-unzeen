import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import bs58 from "bs58";
import { PublicKey, type Keypair } from "@solana/web3.js";

/**
 * Detached ed25519 signatures with the pool's Solana keys (Verify vault
 * ownership, `attest.out_sig`). A Solana address is the raw ed25519 public
 * key, so anyone verifies with `@noble/curves` / ed25519-dalek against the
 * address. Node's crypto only (no extra dependency); the seed never leaves
 * this function and is never logged.
 */

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function privateKeyOf(kp: Keypair): KeyObject {
  // Solana secretKey = seed(32) || pubkey(32).
  const seed = Buffer.from(kp.secretKey.subarray(0, 32));
  try {
    return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  } finally {
    seed.fill(0);
  }
}

/** base58 of ed25519(key, message). */
export function signDetached(kp: Keypair, message: Uint8Array): string {
  return bs58.encode(sign(null, message, privateKeyOf(kp)));
}

/** True when `sigB58` is a valid ed25519 signature of `message` by the Solana address `addressB58`. */
export function verifyDetached(addressB58: string, message: Uint8Array, sigB58: string): boolean {
  try {
    const pk = new PublicKey(addressB58).toBytes();
    const sig = bs58.decode(sigB58);
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pk)]), format: "der", type: "spki" });
    return verify(null, message, key, sig);
  } catch {
    return false;
  }
}

/** Verify vault message (RELAYER.md v4 §2, API.md v0.7 `vault.sig`). */
export function verifyVaultMessage(chainId: string, snapshotId: number, address: string): Buffer {
  return Buffer.from(`unzeen/verify/v1/vault\n${chainId}\n${snapshotId}\n${address}`, "utf8");
}

/** `attest.out_sig` message: the 32 bytes hex-decoded from `meta.memo` (RELAYER.md v4 §3). */
export function attestSigMessage(memoHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(memoHex)) throw new Error("memo must be 64 lowercase hex");
  return Buffer.from(memoHex, "hex");
}
