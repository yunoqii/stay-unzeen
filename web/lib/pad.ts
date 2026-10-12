// Fixed-size bodies for POST /api/actions (analysis now-mode N-9, R-web-3). Without padding the body
// length tells a network observer buy from sell and "now" from "delayed". `pad` is random filler; the
// backend accepts and ignores it. It is added before signing, so the signature covers it.

import type { PaddedAction, SignedAction } from "@/lib/api/types";

export const PAD_BUCKET = 256;
/** Smallest padded body: every ordinary action (buy / sell / withdraw) lands in this one bucket. */
export const PAD_MIN = 1024;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const enc = new TextEncoder();
const byteLength = (s: string) => enc.encode(s).length;

function randomChars(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i] & 63];
  return out;
}

/** Target size of a body that is `len` bytes before filler. */
export function padTarget(len: number): number {
  return Math.max(PAD_MIN, Math.ceil(len / PAD_BUCKET) * PAD_BUCKET);
}

/** The action with `pad` so that JSON.stringify(result) is exactly a bucket size in bytes. */
export function padAction(action: SignedAction): PaddedAction {
  const { pad: _drop, ...rest } = action as PaddedAction; // never pad twice
  void _drop;
  const bare = byteLength(JSON.stringify({ ...rest, pad: "" }));
  return { ...rest, pad: randomChars(padTarget(bare) - bare) } as PaddedAction;
}
