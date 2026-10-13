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

/** Ops whose body must be exactly PAD_MIN bytes (chat.md §5.1, R8): never a bigger bucket. */
export const EXACT_OPS: ReadonlySet<string> = new Set(["chat", "chat_delete", "chat_hide", "chat_report", "noop", "scenario_start", "scenario_cancel"]);

/** DRAFT v0.19: every scenario_create body is exactly this size, so it does not reveal the number of steps. */
export const SCENARIO_BODY_BYTES = 16_384;

export class BodyTooLong extends Error {
  constructor(public readonly bytes: number) {
    super(`body is ${bytes} bytes before filler, more than ${PAD_MIN}`);
  }
}

/** Bytes of the body without filler (`"pad":""`), i.e. what the content itself costs. */
export const bareBytes = (action: SignedAction): number => {
  const { pad: _drop, ...rest } = action as PaddedAction;
  void _drop;
  return byteLength(JSON.stringify({ ...rest, pad: "" }));
};

/**
 * Chat and noop bodies: exactly PAD_MIN bytes on the wire, like an ordinary buy, so the size says
 * neither "chat" nor how long the text is. Throws BodyTooLong instead of spilling into the next bucket.
 */
export function padExact(action: SignedAction, size = PAD_MIN): PaddedAction {
  const bare = bareBytes(action);
  if (bare > size) throw new BodyTooLong(bare);
  const { pad: _drop, ...rest } = action as PaddedAction;
  void _drop;
  return { ...rest, pad: randomChars(size - bare) } as PaddedAction;
}

/**
 * scenario_create: exactly SCENARIO_BODY_BYTES. A plan with a launch image (create, up to 512 KiB) cannot
 * fit; it falls back to the ordinary buckets, like a manual create with an image.
 */
export function padScenario(action: SignedAction): PaddedAction {
  return bareBytes(action) <= SCENARIO_BODY_BYTES ? padExact(action, SCENARIO_BODY_BYTES) : padAction(action);
}
