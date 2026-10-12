// Commitment tree over sealed bids (docs/API.md v0.6 "Commitment", core/fair/src/merkle.rs):
//   leaf = sha256(0x00 || utf8(ciphertext))
//   node = sha256(0x01 || min(a, b) || max(a, b))      (sorted pair: the path needs no directions)
//   verify: h = leaf; for s of path: h = node(h, s); h === root

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export const MIN_LEAVES = 8;
const enc = new TextEncoder();

function cmp(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function leafOf(ciphertext: string): Uint8Array {
  const body = enc.encode(ciphertext);
  const buf = new Uint8Array(body.length + 1);
  buf.set(body, 1);
  return sha256(buf);
}

export function node(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = cmp(a, b) <= 0 ? [a, b] : [b, a];
  const buf = new Uint8Array(65);
  buf[0] = 1;
  buf.set(lo, 1);
  buf.set(hi, 33);
  return sha256(buf);
}

const isHash = (h: string) => /^[0-9a-f]{64}$/i.test(h);

export interface InclusionCheck {
  ok: boolean;
  /** Leaf computed here from the locally kept ciphertext. */
  leaf: string;
  /** Leaf the server put in the proof matches ours. */
  leafMatches: boolean;
  /** Each step of the climb (hex), ending with the computed root. */
  trace: string[];
}

/** Check that our own ciphertext is in the tree with this root. Everything is computed in the browser. */
export function verifyInclusion(ciphertext: string, proof: { leaf: string; path: string[] }, root: string): InclusionCheck {
  const leaf = leafOf(ciphertext);
  const leafHex = bytesToHex(leaf);
  const trace: string[] = [];
  if (!isHash(root) || !proof.path.every(isHash)) return { ok: false, leaf: leafHex, leafMatches: false, trace };
  let h = leaf;
  for (const s of proof.path) {
    h = node(h, hexToBytes(s.toLowerCase()));
    trace.push(bytesToHex(h));
  }
  const leafMatches = proof.leaf.toLowerCase() === leafHex;
  return { ok: leafMatches && bytesToHex(h) === root.toLowerCase(), leaf: leafHex, leafMatches, trace };
}

/**
 * Root and one proof per leaf (same order). Leaves sorted, padded with `pad()` to max(8, 2^ceil(log2 N)).
 * Used by the mock server; the real tree is built by core.
 */
export function buildTree(leaves: Uint8Array[], pad: () => Uint8Array): { root: Uint8Array; proofs: Uint8Array[][] } {
  let size = MIN_LEAVES;
  while (size < leaves.length) size *= 2;
  const level: { h: Uint8Array; i: number }[] = leaves.map((h, i) => ({ h, i }));
  while (level.length < size) level.push({ h: pad(), i: -1 });
  level.sort((a, b) => cmp(a.h, b.h));
  const pos = new Array<number>(leaves.length).fill(0);
  level.forEach((x, p) => {
    if (x.i >= 0) pos[x.i] = p;
  });
  const proofs: Uint8Array[][] = leaves.map(() => []);
  let hashes = level.map((x) => x.h);
  while (hashes.length > 1) {
    for (let i = 0; i < pos.length; i++) {
      proofs[i].push(hashes[pos[i] ^ 1]);
      pos[i] = Math.floor(pos[i] / 2);
    }
    const next: Uint8Array[] = [];
    for (let i = 0; i < hashes.length; i += 2) next.push(node(hashes[i], hashes[i + 1]));
    hashes = next;
  }
  return { root: hashes[0], proofs };
}
