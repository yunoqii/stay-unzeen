// Verify on Robinhood Chain (API v0.20, digestVersion 3): EVM signatures, checked in the browser with noble
// (secp256k1 + keccak-256), no wallet library and no request to anyone.
//
//   vault.sig    = EIP-712 over Snapshot { string snapshotId, address address, uint256 blockNumber }, domain
//                  { name: "unzeen-verify", version: "1", chainId } (adapters/src/evm/attest.ts), blockNumber =
//                  VerifySnapshot.solanaSlot; signed by the vault address itself
//   operator.sig = EIP-191 personal message over the 32 raw bytes of rootsDigest, by the attestation address

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { toChecksumAddress } from "@/lib/evm";

const enc = new TextEncoder();
const HALF_N = secp256k1.Point.CURVE().n >> BigInt(1);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u256 = (v: bigint) => {
  if (v < BigInt(0) || v >> BigInt(256) !== BigInt(0)) throw new RangeError("uint256 out of range");
  return hexToBytes(v.toString(16).padStart(64, "0"));
};
const addr32 = (a: string) => concat([new Uint8Array(12), hexToBytes(a.slice(2).toLowerCase())]);
const strip0x = (h: string) => (h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h);

const DOMAIN_TYPE = keccak_256(enc.encode("EIP712Domain(string name,string version,uint256 chainId)"));
const SNAPSHOT_TYPE = keccak_256(enc.encode("Snapshot(string snapshotId,address address,uint256 blockNumber)"));

export function verifyDomainSeparator(chainId: number): Uint8Array {
  return keccak_256(concat([DOMAIN_TYPE, keccak_256(enc.encode("unzeen-verify")), keccak_256(enc.encode("1")), u256(BigInt(chainId))]));
}

/** The EIP-712 digest a vault signs for a snapshot. */
export function vaultTypedDigest(chainId: number, snapshotId: string, address: string, blockNumber: bigint): Uint8Array {
  const struct = keccak_256(concat([SNAPSHOT_TYPE, keccak_256(enc.encode(snapshotId)), addr32(address), u256(blockNumber)]));
  return keccak_256(concat([Uint8Array.of(0x19, 0x01), verifyDomainSeparator(chainId), struct]));
}

/** EIP-191 personal-message hash of raw bytes. */
export function personalHash(message: Uint8Array): Uint8Array {
  return keccak_256(concat([enc.encode(`\x19Ethereum Signed Message:\n${message.length}`), message]));
}

/** Address (EIP-55) that produced a 65-byte r‖s‖v signature over `hash`, or null when it is malformed. */
export function recoverAddress(hash: Uint8Array, sigHex: string): string | null {
  try {
    const sig = hexToBytes(strip0x(sigHex));
    if (sig.length !== 65) return null;
    // Low-s only (API v0.22): core refuses a high-s signature, so the page must too.
    if (BigInt("0x" + bytesToHex(sig.subarray(32, 64))) > HALF_N) return null;
    let v = sig[64];
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return null;
    // noble's "recovered" format puts the recovery byte first.
    const rec = concat([Uint8Array.of(v), sig.subarray(0, 64)]);
    const pub = secp256k1.recoverPublicKey(rec, hash, { prehash: false });
    const full = secp256k1.Point.fromBytes(pub).toBytes(false); // 65 bytes, 0x04 ‖ x ‖ y
    return toChecksumAddress("0x" + bytesToHex(keccak_256(full.subarray(1)).subarray(12)));
  } catch {
    return null;
  }
}

/** A vault's EIP-712 statement for this snapshot, signed by that vault. Never throws. */
export function verifyVaultEip712(chainId: number, snapshotId: number | string, address: string, blockNumber: number | bigint, sigHex: string): boolean {
  try {
    const want = toChecksumAddress(address);
    return recoverAddress(vaultTypedDigest(chainId, String(snapshotId), want, BigInt(blockNumber)), sigHex) === want;
  } catch {
    return false;
  }
}

/** The operator's EIP-191 signature over the digest bytes, by `operator` (0x). Never throws. */
export function verifyOperatorEip191(operator: string, digestHex: string, sigHex: string): boolean {
  try {
    return recoverAddress(personalHash(hexToBytes(strip0x(digestHex).toLowerCase())), sigHex) === toChecksumAddress(operator);
  } catch {
    return false;
  }
}
