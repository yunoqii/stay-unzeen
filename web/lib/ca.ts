// Contract-address search: validated in the browser only. Nothing is sent anywhere until the user
// lands on /token/<mint>, and then only to our own backend.

import { addressKind, isChainAddress } from "@/lib/chain";

/**
 * A pasted mint -> canonical base58 string (32 bytes), or null. Also accepts a link whose last path
 * segment is a mint (people paste launchpad / explorer URLs); the link itself is never opened.
 */
export function parseMint(input: string): string | null {
  const s = input.trim();
  if (!s || s.length > 512) return null;
  if (isChainAddress(s)) return s;
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    const segs = u.pathname.split("/").filter(Boolean);
    for (let i = segs.length - 1; i >= 0; i--) if (isChainAddress(segs[i])) return segs[i];
  } catch {
    /* not a URL */
  }
  return null;
}

/** Why an input is not a mint, for the hint under the search box. */
export function mintError(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (parseMint(s)) return null;
  if (addressKind() === "0x") return /^0x[0-9a-fA-F]{40}$/.test(s) ? "The checksum doesn't match: a character is wrong." : "Not a token address: 0x and 40 hex characters.";
  if (/[^1-9A-HJ-NP-Za-km-z]/.test(s) && !/^https?:\/\//i.test(s)) return "Not a Solana address: base58 only (no 0, O, I, l).";
  return "Not a Solana address: it must decode to 32 bytes.";
}
