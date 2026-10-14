// Verify v3 (API v0.20, Robinhood Chain): u128 leaf values, ERC-20 asset = 12 zero bytes ‖ address, v3 tags.
// Recomputed in the browser code from core/testdata/verify-v3-vectors.json: leaves, roots, proof path, digest.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { VerifySnapshot } from "@/lib/api/types";
import { assetBytes, climb, leafHash, nodeOf, rootsDigest, type SumNode } from "./merkle-sum";

interface Leaf {
  anonPubkey: string;
  blind: string;
  dummy: boolean;
  index: number;
  leaf: string;
  piece: number;
  value: string;
}
interface V {
  chainId: string;
  snapshotId: number;
  header: { blockNumber: number; leaves: number; takenAtSec: number; zcashHeight: number; zecReserveZat: string };
  token: string;
  tokenAsset32: string;
  trees: Record<string, { leaves: Leaf[]; root: string; sum: string }>;
  proof: { asset: string; leafIndex: number; path: { hash: string; sum: string }[] };
  rootsDigest: string;
}

const file = path.resolve(import.meta.dirname, "../../../core/testdata/verify-v3-vectors.json");
const v = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null) as V | null;

describe.skipIf(!v)("verify-v3-vectors.json (API v0.20)", () => {
  it("ERC-20 asset id = 12 zero bytes ‖ address", () => {
    expect(bytesToHex(assetBytes(v!.token)!)).toBe(v!.tokenAsset32);
    expect(bytesToHex(assetBytes(v!.token.toLowerCase())!)).toBe(v!.tokenAsset32);
  });

  it.each(Object.keys(v?.trees ?? {}))("tree %s: every leaf (u128 values) and the root", (asset) => {
    const t = v!.trees[asset];
    const a = assetBytes(asset)!;
    const nodes: SumNode[] = t.leaves.map((l) => {
      const h = leafHash({ chainId: v!.chainId, snapshotId: v!.snapshotId, asset: a, anonPubkey: hexToBytes(l.anonPubkey), piece: l.piece, value: BigInt(l.value), blind: hexToBytes(l.blind) }, 3);
      expect(bytesToHex(h)).toBe(l.leaf);
      return { hash: h, sum: BigInt(l.value) };
    });
    let level = nodes;
    while (level.length > 1) level = Array.from({ length: level.length / 2 }, (_, i) => nodeOf(level[2 * i], level[2 * i + 1], 3));
    expect(bytesToHex(level[0].hash)).toBe(t.root);
    expect(level[0].sum.toString()).toBe(t.sum);
  });

  it("the owner's path climbs to the token root (sums past 2^64)", () => {
    const t = v!.trees[v!.proof.asset];
    const l = t.leaves[v!.proof.leafIndex];
    const { root } = climb({ hash: hexToBytes(l.leaf), sum: BigInt(l.value) }, v!.proof.leafIndex, v!.proof.path, 3);
    expect(bytesToHex(root.hash)).toBe(t.root);
    expect(root.sum.toString()).toBe(t.sum);
  });

  it("rootsDigest v3", () => {
    const h = v!.header;
    const snap = {
      chainId: v!.chainId,
      id: v!.snapshotId,
      takenAt: h.takenAtSec * 1000,
      leaves: h.leaves,
      solanaSlot: h.blockNumber,
      zcashHeight: h.zcashHeight,
      zecReserve: { amountZat: h.zecReserveZat },
      trees: Object.entries(v!.trees).map(([asset, t]) => ({ asset, decimals: 0, granule: "1", root: t.root, sum: t.sum })),
      digestVersion: 3 as const,
      quoteAssets: [],
    } as unknown as VerifySnapshot;
    expect(rootsDigest(snap)).toBe(v!.rootsDigest);
    // The v2 formula over the same fields gives a different digest.
    expect(rootsDigest({ ...snap, digestVersion: 2 })).not.toBe(v!.rootsDigest);
  });
});
