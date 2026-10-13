// EVM addresses for Robinhood Chain (API v0.18): token mints, withdrawal destinations. EIP-55 checksums,
// computed locally (keccak-256 from @noble/hashes); nothing is looked up anywhere.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

/** EIP-55 mixed-case form of a 20-byte address (input in any case). */
export function toChecksumAddress(addr: string): string {
  if (!HEX40.test(addr)) throw new Error("Not an EVM address");
  const lower = addr.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

export type EvmAddressVerdict = { ok: true; address: string } | { ok: false; reason: "empty" | "format" | "checksum" | "zero"; message: string };

/**
 * A destination or mint: 0x + 40 hex. All-lower / all-upper is accepted (no checksum in it); mixed case must be
 * a valid EIP-55 checksum, so one mistyped letter is caught. The zero address is refused.
 */
export function checkEvmAddress(input: string): EvmAddressVerdict {
  const a = input.trim();
  if (!a) return { ok: false, reason: "empty", message: "Paste a 0x address." };
  if (!HEX40.test(a)) return { ok: false, reason: "format", message: "Not an EVM address: 0x and 40 hex characters." };
  if (a.toLowerCase() === ZERO) return { ok: false, reason: "zero", message: "That's the zero address. Tokens sent there are gone." };
  const body = a.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  const sum = toChecksumAddress(a);
  if (mixed && sum !== a) return { ok: false, reason: "checksum", message: "The checksum doesn't match: a character is wrong. Copy the address again." };
  return { ok: true, address: sum };
}

export const isEvmAddress = (s: string): boolean => checkEvmAddress(s).ok;
