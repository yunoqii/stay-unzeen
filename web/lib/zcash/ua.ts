// Unified Address parsing in the browser (ZIP-316 revision 0): bech32m (no length limit) -> F4Jumble^-1
// -> padding check -> TLV receivers. Used to vet a withdraw_zec destination before anything is signed:
// payouts go out of the Orchard/Ironwood pool only, so the UA must carry an Orchard receiver
// (typecode 0x03; Ironwood uses the same receiver encoding). t-addresses and Sapling are refused with a
// reason the user can act on. The backend repeats the check (core/api check_ua).

import { blake2b } from "@noble/hashes/blake2.js";
import { bech32m } from "@scure/base";
import type { Network } from "@/lib/network";

// ---- F4Jumble (ZIP-316 §"Jumbling") ----

const OUT = 64;
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const H_PERS = (i: number) => new Uint8Array([...ascii("UA_F4Jumble_H"), i, 0, 0]);
const G_PERS = (i: number, j: number) => new Uint8Array([...ascii("UA_F4Jumble_G"), i, j & 0xff, j >> 8]);

export const F4_MIN = 38;
export const F4_MAX = 4_194_368;

function xorInto(target: Uint8Array, source: Uint8Array) {
  const n = Math.min(target.length, source.length);
  for (let i = 0; i < n; i++) target[i] ^= source[i];
}

function hRound(left: Uint8Array, right: Uint8Array, i: number) {
  xorInto(left, blake2b(right, { dkLen: left.length, personalization: H_PERS(i) }));
}

function gRound(left: Uint8Array, right: Uint8Array, i: number) {
  for (let j = 0; j * OUT < right.length; j++) {
    xorInto(right.subarray(j * OUT), blake2b(left, { dkLen: OUT, personalization: G_PERS(i, j) }));
  }
}

function split(m: Uint8Array): [Uint8Array, Uint8Array] {
  if (m.length < F4_MIN || m.length > F4_MAX) throw new Error("F4Jumble: invalid length");
  const l = Math.min(OUT, Math.floor(m.length / 2));
  return [m.subarray(0, l), m.subarray(l)];
}

export function f4jumble(message: Uint8Array): Uint8Array {
  const m = message.slice();
  const [a, b] = split(m);
  gRound(a, b, 0);
  hRound(a, b, 0);
  gRound(a, b, 1);
  hRound(a, b, 1);
  return m;
}

export function f4jumbleInv(message: Uint8Array): Uint8Array {
  const m = message.slice();
  const [a, b] = split(m);
  hRound(a, b, 1);
  gRound(a, b, 1);
  hRound(a, b, 0);
  gRound(a, b, 0);
  return m;
}

// ---- Unified Address ----

export const TYPECODE = { p2pkh: 0x00, p2sh: 0x01, sapling: 0x02, orchard: 0x03 } as const;
const RECEIVER_LEN: Record<number, number> = { 0: 20, 1: 20, 2: 43, 3: 43 };

export type ZcashNet = "main" | "test" | "regtest";
const UA_HRP: Record<ZcashNet, string> = { main: "u", test: "utest", regtest: "uregtest" };

export interface UnifiedAddress {
  net: ZcashNet;
  receivers: { typecode: number; data: Uint8Array }[];
}

export class UaError extends Error {
  constructor(
    public readonly code: "checksum" | "padding" | "encoding" | "order" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "UaError";
  }
}

function readCompactSize(b: Uint8Array, off: number): [number, number] {
  if (off >= b.length) throw new UaError("encoding", "truncated");
  const first = b[off];
  if (first < 0xfd) return [first, off + 1];
  const n = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
  if (off + 1 + n > b.length) throw new UaError("encoding", "truncated");
  let v = 0;
  for (let i = n - 1; i >= 0; i--) v = v * 256 + b[off + 1 + i];
  const min = first === 0xfd ? 0xfd : first === 0xfe ? 0x10000 : 0x100000000;
  if (v < min || !Number.isSafeInteger(v)) throw new UaError("encoding", "non-canonical compactSize");
  return [v, off + 1 + n];
}

/** Decode a UA string. Throws UaError on anything a ZIP-316 decoder must reject. */
export function decodeUnifiedAddress(addr: string): UnifiedAddress {
  let prefix: string;
  let bytes: Uint8Array;
  try {
    const d = bech32m.decode(addr as `${string}1${string}`, false);
    prefix = d.prefix;
    bytes = bech32m.fromWords(d.words);
  } catch {
    throw new UaError("checksum", "bech32m checksum or charset mismatch");
  }
  const net = (Object.keys(UA_HRP) as ZcashNet[]).find((n) => UA_HRP[n] === prefix);
  if (!net) throw new UaError("encoding", `unknown prefix ${prefix}`);
  if (bytes.length < F4_MIN || bytes.length > F4_MAX) throw new UaError("encoding", "bad length");

  const raw = f4jumbleInv(bytes);
  const pad = raw.subarray(raw.length - 16);
  const want = new Uint8Array(16);
  want.set(ascii(prefix));
  for (let i = 0; i < 16; i++) if (pad[i] !== want[i]) throw new UaError("padding", "padding mismatch");

  const body = raw.subarray(0, raw.length - 16);
  const receivers: UnifiedAddress["receivers"] = [];
  let off = 0;
  let last = -1;
  while (off < body.length) {
    const [typecode, o1] = readCompactSize(body, off);
    const [len, o2] = readCompactSize(body, o1);
    if (o2 + len > body.length) throw new UaError("encoding", "truncated receiver");
    if (typecode <= last) throw new UaError("order", "receivers out of order or duplicated");
    if (RECEIVER_LEN[typecode] !== undefined && RECEIVER_LEN[typecode] !== len)
      throw new UaError("encoding", `bad length for typecode ${typecode}`);
    // Revision 0: metadata typecodes 0xE0..0xFC are MUST-understand; we understand none of them.
    if (typecode >= 0xe0 && typecode <= 0xfc) throw new UaError("unsupported", "unknown MUST-understand item");
    receivers.push({ typecode, data: body.slice(o2, o2 + len) });
    last = typecode;
    off = o2 + len;
  }
  if (receivers.length === 0) throw new UaError("encoding", "no receivers");
  if (receivers.every((r) => r.typecode === TYPECODE.p2pkh || r.typecode === TYPECODE.p2sh))
    throw new UaError("encoding", "transparent-only UA");
  return { net, receivers };
}

// ---- withdraw destination check ----

export type WithdrawUaVerdict =
  | { ok: true; ua: UnifiedAddress }
  | {
      ok: false;
      reason: "empty" | "transparent" | "sapling" | "no_orchard" | "wrong_network" | "typo" | "unknown";
      message: string;
    };

const T_ADDR = /^(t1|t3|tm|t2)[1-9A-HJ-NP-Za-km-z]{30,40}$/;
const TEX = /^(tex|textest)1[02-9ac-hj-np-z]+$/;
const SAPLING = /^(zs|ztestsapling|zregtestsapling)1[02-9ac-hj-np-z]+$/;
const SPROUT = /^(zc|zt)[1-9A-HJ-NP-Za-km-z]{60,}$/;
const UA_LIKE = /^(u|utest|uregtest)1[02-9ac-hj-np-z]+$/;

export const zcashNetFor = (n: Network): ZcashNet => (n === "mainnet" ? "main" : "test");

/** Is `input` an acceptable shielded payout address on `network`? Messages are user-facing. */
export function checkWithdrawUa(input: string, network: Network): WithdrawUaVerdict {
  const a = input.trim();
  const expected = zcashNetFor(network);
  const here = network === "mainnet" ? "Mainnet" : "Devnet";
  if (!a) return { ok: false, reason: "empty", message: "Paste a shielded Unified Address." };
  if (T_ADDR.test(a) || TEX.test(a))
    return {
      ok: false,
      reason: "transparent",
      message: `That's a transparent address. Payouts to it would be public. Paste a shielded Unified Address (starts with ${network === "mainnet" ? "u1" : "utest1"}).`,
    };
  if (SAPLING.test(a.toLowerCase()) || SPROUT.test(a))
    return {
      ok: false,
      reason: "sapling",
      message: `That's a Sapling address. Unzeen pays out from the Orchard / Ironwood pool only. Paste your wallet's Unified Address (${network === "mainnet" ? "u1" : "utest1"}…).`,
    };
  const lower = a.toLowerCase();
  if (a !== lower && a !== a.toUpperCase())
    return { ok: false, reason: "typo", message: "Mixed upper and lower case. Copy the address again from your wallet." };
  if (!UA_LIKE.test(lower))
    return { ok: false, reason: "unknown", message: "This doesn't look like a Zcash Unified Address." };

  let ua: UnifiedAddress;
  try {
    ua = decodeUnifiedAddress(lower);
  } catch (e) {
    if (e instanceof UaError && (e.code === "checksum" || e.code === "padding"))
      return { ok: false, reason: "typo", message: "The checksum doesn't match: a character is missing or wrong. Copy it again." };
    return { ok: false, reason: "unknown", message: "This Unified Address can't be read. Copy it again from your wallet." };
  }
  if (ua.net !== expected)
    return {
      ok: false,
      reason: "wrong_network",
      message: `That's a ${ua.net === "main" ? "mainnet" : ua.net === "test" ? "testnet" : "regtest"} address, but you're on ${here}.`,
    };
  if (!ua.receivers.some((r) => r.typecode === TYPECODE.orchard))
    return {
      ok: false,
      reason: "no_orchard",
      message: "This Unified Address has no Orchard receiver, so it can't take a shielded payout. Use your wallet's default address.",
    };
  return { ok: true, ua };
}
