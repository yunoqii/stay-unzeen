// Bid plaintext, 64 bytes (docs/API.md v0.6):
// off len
// 0   4   magic "UZFL"
// 4   1   version = 1
// 5   2   chainId bytes (02 02 devnet, 01 01 mainnet)
// 7   16  launchId
// 23  32  anonPubkey (ed25519, the key that signs the request)
// 55  8   amountZat (u64 LE)
// 63  1   0x00

import { base58, hex } from "@scure/base";

export const BID_LEN = 64;
const MAGIC = [0x55, 0x5a, 0x46, 0x4c];
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

export interface BidFields {
  /** "0202" | "0101" */
  chainId: string;
  /** 32 hex */
  launchId: string;
  /** base58 (as in x-unzeen-pubkey) or raw 32 bytes */
  anonPubkey: string | Uint8Array;
  amountZat: bigint;
}

export function encodeBid(f: BidFields): Uint8Array {
  if (!/^(0202|0101)$/.test(f.chainId)) throw new Error("chainId must be 0202 or 0101");
  if (!/^[0-9a-f]{32}$/.test(f.launchId)) throw new Error("launchId must be 32 lowercase hex");
  const pk = typeof f.anonPubkey === "string" ? base58.decode(f.anonPubkey) : f.anonPubkey;
  if (pk.length !== 32) throw new Error("anonPubkey must be 32 bytes");
  if (f.amountZat <= BigInt(0) || f.amountZat > U64_MAX) throw new Error("amountZat out of range");
  const out = new Uint8Array(BID_LEN);
  out.set(MAGIC, 0);
  out[4] = 1;
  out.set(hex.decode(f.chainId), 5);
  out.set(hex.decode(f.launchId), 7);
  out.set(pk, 23);
  let v = f.amountZat;
  for (let i = 0; i < 8; i++) {
    out[55 + i] = Number(v & BigInt(0xff));
    v >>= BigInt(8);
  }
  out[63] = 0;
  return out;
}
