// Reads the header of an age-armored tlock ciphertext (what the server checks on fl_bid: round and
// chain hash). No crypto here, no tlock-js: cheap enough for the mock and for pre-flight checks.

import { base64 } from "@scure/base";

const BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
const END = "-----END AGE ENCRYPTED FILE-----";
export const MAX_CIPHERTEXT_BYTES = 1024;

export interface TlockHeader {
  round: number;
  chainHash: string;
}

/** Round and chain hash of the first tlock stanza, or null when this is not an age-armored tlock file. */
export function parseTlockArmor(armor: string): TlockHeader | null {
  if (typeof armor !== "string" || new TextEncoder().encode(armor).length > MAX_CIPHERTEXT_BYTES) return null;
  const text = armor.trim();
  if (!text.startsWith(BEGIN) || !text.endsWith(END)) return null;
  const b64 = text.slice(BEGIN.length, text.length - END.length).replace(/\s+/g, "");
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(b64);
  } catch {
    return null;
  }
  // The header is ASCII up to "---"; the payload after it is binary.
  let head = "";
  for (let i = 0; i < bytes.length && i < 512; i++) head += String.fromCharCode(bytes[i]);
  const lines = head.split("\n");
  if (lines[0] !== "age-encryption.org/v1") return null;
  const m = /^-> tlock (\d{1,12}) ([0-9a-f]{64})$/.exec(lines[1] ?? "");
  if (!m) return null;
  return { round: Number(m[1]), chainHash: m[2] };
}
