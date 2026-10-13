// unz1 memo codec (docs/API.md "Формат memo unz1"). Built and signed HERE, in the browser:
// the backend only verifies. We never sign bytes the server hands us.
//
// off  len      field
// 0    1        magic 0x55 ('U')
// 1    1        version = 1
// 2    1        op: 1 buy, 2 sell, 3 create, 4 withdraw, 5 deposit
// 3    1        venue: 0 none, 1 pumpfun, 2 meteora-dbc, 3 jupiter
// 4    32       mint | sha256(canonical JSON meta) for create | zeros for deposit
// 36   8        min_out u64 LE (sell: amount; deposit: 0)
// 44   32       anon_pubkey
// 76   8        nonce u64 LE
// 84   4        expiry u32 LE (unix seconds)
// 88   1        target_kind: 0 none, 1 shielded receiver (43), 2 Solana address (32)
// 89   0|43|32  target
// ..   64       sig = ed25519(sk, "unzeen/memo/v1" || chain_id[2] || bytes[0..sig])

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64urlnopad } from "@scure/base";
import type { Venue } from "@/lib/api/types";

export const UNZ1_PREFIX = "unz1:";
export const MEMO_DOMAIN = "unzeen/memo/v1";
export const MEMO_MAX_BYTES = 512; // ZIP-302

const MAGIC = 0x55;
const VERSION = 1;
const HEADER_LEN = 89;
const SIG_LEN = 64;

export const UNZ1_OPS = { buy: 1, sell: 2, create: 3, withdraw: 4, deposit: 5 } as const;
export type Unz1Op = keyof typeof UNZ1_OPS;

/** Venue codes of memo v1 (deposits use "none"; later venues have no memo code). */
export type Unz1Venue = Extract<Venue, "pumpfun" | "meteora-dbc" | "jupiter"> | "none";
export const UNZ1_VENUES: Record<Unz1Venue, number> = { none: 0, pumpfun: 1, "meteora-dbc": 2, jupiter: 3 };

export type Unz1Target =
  | { kind: "none" }
  /** Raw 43-byte Orchard/Ironwood receiver (d || pk_d), already extracted from a UA. */
  | { kind: "shielded"; receiver: Uint8Array }
  /** Solana address, base58 (32 bytes). */
  | { kind: "solana"; address: string };

/** Byte 0: Zcash network (1 mainnet, 2 testnet). Byte 1: Solana cluster (1 mainnet-beta, 2 devnet). */
/** v0.18: byte 1 = trading chain: 0x01 / 0x02 Solana mainnet-beta / devnet, 0x11 / 0x12 Robinhood Chain 4663 / 46630. */
export type ChainId = readonly [zcash: 1 | 2, chain: 1 | 2 | 0x11 | 0x12];


export interface Unz1Fields {
  op: Unz1Op;
  venue: Unz1Venue;
  /**
   * buy/sell/withdraw: base58 mint. create: pass `meta` instead. deposit: omit (zeros).
   */
  mint?: string;
  /** create only: hashed with canonicalMetaJson(). */
  meta?: { name: string; symbol: string; image?: string };
  /** u64: min_out in token base units; for sell — amount in base units. 0 for deposit. */
  minOut: bigint;
  /** u64, unique per anon pubkey; chosen by the client (see randomNonce). */
  nonce: bigint;
  /** unix seconds; after this the backend refunds instead of executing. */
  expiry: number;
  target: Unz1Target;
}

export interface DecodedUnz1 extends Omit<Unz1Fields, "mint" | "meta"> {
  /** base58 mint, or null for deposit (zeros) and create (hash). */
  mint: string | null;
  /** 32 bytes at offset 4: mint / meta hash / zeros. */
  subject: Uint8Array;
  anonPubkey: string;
  sig: Uint8Array;
  valid: boolean;
}

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

/** Deterministic JSON for create meta: keys sorted, no whitespace, undefined fields dropped. */
export function canonicalMetaJson(meta: { name: string; symbol: string; image?: string }): string {
  const entries = Object.entries(meta)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",") + "}";
}

export function randomNonce(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return new DataView(b.buffer).getBigUint64(0, true);
}

function subjectBytes(f: Unz1Fields): Uint8Array {
  if (f.op === "deposit") return new Uint8Array(32);
  if (f.op === "create") {
    if (!f.meta) throw new Error("create needs meta");
    return sha256(new TextEncoder().encode(canonicalMetaJson(f.meta)));
  }
  if (!f.mint) throw new Error(`${f.op} needs mint`);
  const m = base58.decode(f.mint);
  if (m.length !== 32) throw new Error("mint must be 32 bytes");
  return m;
}

function targetBytes(t: Unz1Target): { kind: number; bytes: Uint8Array } {
  if (t.kind === "none") return { kind: 0, bytes: new Uint8Array(0) };
  if (t.kind === "shielded") {
    if (t.receiver.length !== 43) throw new Error("shielded receiver must be 43 bytes");
    return { kind: 1, bytes: t.receiver };
  }
  const a = base58.decode(t.address);
  if (a.length !== 32) throw new Error("Solana address must be 32 bytes");
  return { kind: 2, bytes: a };
}

/** Unsigned body (everything before sig). */
export function encodeUnz1Body(f: Unz1Fields, anonPubkey: Uint8Array): Uint8Array {
  if (anonPubkey.length !== 32) throw new Error("anon pubkey must be 32 bytes");
  if (f.minOut < BigInt(0) || f.minOut > U64_MAX) throw new Error("minOut out of u64 range");
  if (f.nonce < BigInt(0) || f.nonce > U64_MAX) throw new Error("nonce out of u64 range");
  if (!Number.isInteger(f.expiry) || f.expiry < 0 || f.expiry > 0xffffffff) throw new Error("expiry out of u32 range");
  if (f.op === "deposit" && f.minOut !== BigInt(0)) throw new Error("deposit min_out must be 0");
  const target = targetBytes(f.target);
  const out = new Uint8Array(HEADER_LEN + target.bytes.length);
  const dv = new DataView(out.buffer);
  out[0] = MAGIC;
  out[1] = VERSION;
  out[2] = UNZ1_OPS[f.op];
  out[3] = UNZ1_VENUES[f.venue];
  out.set(subjectBytes(f), 4);
  dv.setBigUint64(36, f.minOut, true);
  out.set(anonPubkey, 44);
  dv.setBigUint64(76, f.nonce, true);
  dv.setUint32(84, f.expiry, true);
  out[88] = target.kind;
  out.set(target.bytes, HEADER_LEN);
  return out;
}

function signedMessage(body: Uint8Array, chainId: ChainId): Uint8Array {
  const domain = new TextEncoder().encode(MEMO_DOMAIN);
  const msg = new Uint8Array(domain.length + 2 + body.length);
  msg.set(domain, 0);
  msg[domain.length] = chainId[0];
  msg[domain.length + 1] = chainId[1];
  msg.set(body, domain.length + 2);
  return msg;
}

/** Full signed memo bytes. */
export function encodeUnz1(f: Unz1Fields, secretKey: Uint8Array, chainId: ChainId): Uint8Array {
  const pub = ed25519.getPublicKey(secretKey);
  const body = encodeUnz1Body(f, pub);
  const sig = ed25519.sign(signedMessage(body, chainId), secretKey);
  const out = new Uint8Array(body.length + SIG_LEN);
  out.set(body);
  out.set(sig, body.length);
  return out;
}

/** The memo string that goes into ZIP-321 `memo=` (itself base64url-encoded there). */
export function unz1MemoString(f: Unz1Fields, secretKey: Uint8Array, chainId: ChainId): string {
  const s = UNZ1_PREFIX + base64urlnopad.encode(encodeUnz1(f, secretKey, chainId));
  if (new TextEncoder().encode(s).length > MEMO_MAX_BYTES) throw new Error("memo too long");
  return s;
}

const OP_BY_CODE = Object.fromEntries(Object.entries(UNZ1_OPS).map(([k, v]) => [v, k])) as Record<number, Unz1Op>;
const VENUE_BY_CODE = Object.fromEntries(Object.entries(UNZ1_VENUES).map(([k, v]) => [v, k])) as Record<
  number,
  Unz1Venue
>;

/** Parse and verify. Throws on malformed bytes; `valid` reports the signature check. */
export function decodeUnz1(memo: string | Uint8Array, chainId: ChainId): DecodedUnz1 {
  let b: Uint8Array;
  if (typeof memo === "string") {
    if (!memo.startsWith(UNZ1_PREFIX)) throw new Error("not an unz1 memo");
    b = base64urlnopad.decode(memo.slice(UNZ1_PREFIX.length));
  } else b = memo;
  if (b.length < HEADER_LEN + SIG_LEN || b[0] !== MAGIC || b[1] !== VERSION) throw new Error("bad unz1 header");
  const op = OP_BY_CODE[b[2]];
  const venue = VENUE_BY_CODE[b[3]];
  if (!op || venue === undefined) throw new Error("bad op or venue");
  const kind = b[88];
  const tlen = kind === 0 ? 0 : kind === 1 ? 43 : kind === 2 ? 32 : -1;
  if (tlen < 0 || b.length !== HEADER_LEN + tlen + SIG_LEN) throw new Error("bad unz1 length");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tb = b.slice(HEADER_LEN, HEADER_LEN + tlen);
  const target: Unz1Target =
    kind === 0 ? { kind: "none" } : kind === 1 ? { kind: "shielded", receiver: tb } : { kind: "solana", address: base58.encode(tb) };
  const body = b.slice(0, HEADER_LEN + tlen);
  const sig = b.slice(HEADER_LEN + tlen);
  const pub = b.slice(44, 76);
  let valid = false;
  try {
    valid = ed25519.verify(sig, signedMessage(body, chainId), pub);
  } catch {
    valid = false;
  }
  const subject = b.slice(4, 36);
  return {
    op,
    venue,
    mint: op === "deposit" || op === "create" ? null : base58.encode(subject),
    subject,
    minOut: dv.getBigUint64(36, true),
    anonPubkey: base58.encode(pub),
    nonce: dv.getBigUint64(76, true),
    expiry: dv.getUint32(84, true),
    target,
    sig,
    valid,
  };
}

/**
 * Backend policy since 12.10 (core/testdata/unz1-vectors.json): a memo may only carry a deposit.
 * Everything else (buy, sell, ...) goes through signed HTTP actions against the balance.
 */
export const MEMO_ALLOWED_OPS: readonly Unz1Op[] = ["deposit"];

export type Unz1Verdict = "valid" | "malformed" | "bad_signature" | "expired";

/** Same verdict the backend scanner reaches. `nowSec` = unix seconds (backend uses block time). */
export function checkUnz1(memo: string | Uint8Array, chainId: ChainId, nowSec: number): Unz1Verdict {
  let d: DecodedUnz1;
  try {
    d = decodeUnz1(memo, chainId);
  } catch {
    return "malformed";
  }
  if (!MEMO_ALLOWED_OPS.includes(d.op)) return "malformed";
  if (!d.valid) return "bad_signature";
  if (nowSec > d.expiry) return "expired";
  return "valid";
}
