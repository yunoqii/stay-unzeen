// The offline checker (public/verify/verify-proof.mjs, no dependencies) on Robinhood Chain snapshots:
// its own keccak-256 and secp256k1 recovery against viem vectors, the v3 leaf / node / digest against the core
// vectors, and a full check of the REAL hood snapshot (testdata/hood-snapshot.json) agreeing with the page.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { VerifySnapshot } from "@/lib/api/types";
import { rootsDigest } from "./merkle-sum";
import viem from "./testdata/evm-sig-vectors.json";
import hood from "./testdata/hood-snapshot.json";

interface Mjs {
  keccak256(d: Uint8Array): Buffer;
  recoverAddress(hash: Uint8Array, sig: string): string | null;
  personalHash(b: Uint8Array): Buffer;
  vaultTypedDigest(chainId: number, snapshotId: string | number, address: string, blockNumber: string | number | bigint): Buffer;
  asset32(a: string): Buffer;
  leafHash(chainId: string, id: number, asset: string, pk: Buffer, piece: number, value: string, blind: string, v?: number): Buffer;
  node(l: { hash: Buffer; sum: bigint }, r: { hash: Buffer; sum: bigint }, v?: number): { hash: Buffer; sum: bigint };
  rootsDigest(s: unknown): string;
  check(file: unknown, operator?: string, opts?: { trustAnyOperator?: boolean }): { ok: boolean; lines: string[] };
}
const load = async () => (await import(/* @vite-ignore */ path.resolve(__dirname, "../../public/verify/verify-proof.mjs"))) as Mjs;

const OPERATOR = "0x7c4DFd22C39cd4CaeBC4A8b0297075f519524330"; // mock hood operator, TEST ONLY
const snap = hood as unknown as VerifySnapshot;
const file = (s: unknown) => ({ anonPubkey: "11111111111111111111111111111111", snapshot: s, proof: { snapshotId: snap.id, proofs: [], truncated: false } });
const N_SECP = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
/** The malleable twin of a signature: s -> n - s, v flipped. Same signer, high s. */
const highS = (sig: string) => {
  const h = sig.slice(2);
  const s = (N_SECP - BigInt("0x" + h.slice(64, 128))).toString(16).padStart(64, "0");
  const v = parseInt(h.slice(128), 16) === 27 ? "1c" : "1b";
  return "0x" + h.slice(0, 64) + s + v;
};
const clone = () => JSON.parse(JSON.stringify(hood)) as VerifySnapshot;

describe("verify-proof.mjs: EVM primitives", () => {
  it("keccak-256 (not NIST SHA3)", async () => {
    const m = await load();
    expect(m.keccak256(Buffer.alloc(0)).toString("hex")).toBe("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(m.keccak256(Buffer.from("abc")).toString("hex")).toBe("4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    // Multi-block input (> 136-byte rate).
    expect(m.keccak256(Buffer.alloc(200, 0x61)).toString("hex")).toHaveLength(64);
  });

  it("EIP-712 vault statement and EIP-191 operator signature (viem vectors)", async () => {
    const m = await load();
    const d = m.vaultTypedDigest(viem.chainId, viem.snapshotId, viem.vault, viem.blockNumber);
    expect(m.recoverAddress(d, viem.vaultSig)).toBe(viem.vault.toLowerCase());
    expect(m.recoverAddress(m.vaultTypedDigest(46630, viem.snapshotId, viem.vault, viem.blockNumber), viem.vaultSig)).not.toBe(viem.vault.toLowerCase());
    expect(m.recoverAddress(m.personalHash(Buffer.from(viem.digest, "hex")), viem.operatorSig)).toBe(viem.operator.toLowerCase());
    expect(m.recoverAddress(d, "0x1234")).toBeNull();
    expect(m.recoverAddress(d, highS(viem.vaultSig))).toBeNull(); // low-s only, like core
    expect(m.recoverAddress(d, "not hex at all")).toBeNull();
  });
});

const vfile = path.resolve(__dirname, "../../../core/testdata/verify-v3-vectors.json");
const v = existsSync(vfile) ? JSON.parse(readFileSync(vfile, "utf8")) : null;

describe.skipIf(!v)("verify-proof.mjs: core v3 vectors", () => {
  it("ERC-20 asset id, u128 leaves, v3 nodes, root", async () => {
    const m = await load();
    expect(m.asset32(v.token).toString("hex")).toBe(v.tokenAsset32);
    for (const [asset, t] of Object.entries(v.trees) as [string, { leaves: { anonPubkey: string; piece: number; value: string; blind: string; leaf: string }[]; root: string; sum: string }][]) {
      let level = t.leaves.map((l) => {
        const h = m.leafHash(v.chainId, v.snapshotId, asset, Buffer.from(l.anonPubkey, "hex"), l.piece, l.value, l.blind, 3);
        expect(h.toString("hex")).toBe(l.leaf);
        return { hash: h, sum: BigInt(l.value) };
      });
      while (level.length > 1) level = Array.from({ length: level.length / 2 }, (_, i) => m.node(level[2 * i], level[2 * i + 1], 3));
      expect(level[0].hash.toString("hex")).toBe(t.root);
      expect(level[0].sum.toString()).toBe(t.sum);
    }
  });

  it("signatures (API v0.22): same EIP-712 hash, same recovered address as core", async () => {
    const m = await load();
    const g = v.signatures;
    const msg = g.vault.message;
    const h = m.vaultTypedDigest(g.vault.domain.chainId, msg.snapshotId, msg.address, msg.blockNumber);
    expect(h.toString("hex")).toBe(g.vault.hash);
    expect(m.recoverAddress(h, g.vault.sig)).toBe(g.address.toLowerCase());
    expect(m.recoverAddress(m.personalHash(Buffer.from(g.operator.message, "hex")), g.operator.sig)).toBe(g.address.toLowerCase());
  });
});

describe("verify-proof.mjs: the real hood snapshot", () => {
  it("same v3 digest as the page", async () => {
    const m = await load();
    expect(m.rootsDigest(hood)).toBe(rootsDigest(snap));
    expect(m.rootsDigest(hood)).toBe(snap.rootsDigest);
  });

  it("digest, EIP-191 operator, EIP-712 vaults and solvency all pass with the pinned address", async () => {
    const m = await load();
    const r = m.check(file(hood), OPERATOR.toLowerCase());
    expect(r.lines.filter((l) => l.startsWith("FAIL"))).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.lines.filter((l) => l.includes("(EIP-712)"))).toHaveLength(snap.vaults.length);
    expect(r.lines.some((l) => l.includes("proven (ETH)"))).toBe(true);
  });

  it("a different pinned address, a tampered operator or vault signature, a duplicate vault: FAIL", async () => {
    const m = await load();
    expect(m.check(file(hood), "0x0000000000000000000000000000000000000001").ok).toBe(false);
    expect(m.check(file(hood)).ok).toBe(false); // nothing pinned for 0111 and no --trust-any-operator

    const op = clone();
    op.operator!.sig = viem.operatorSig;
    expect(m.check(file(op), OPERATOR).lines.some((l) => l.startsWith("FAIL operator signature"))).toBe(true);

    const va = clone();
    va.vaults[0] = { ...va.vaults[0], sig: va.vaults[1].sig };
    expect(m.check(file(va), OPERATOR).lines.some((l) => l.startsWith(`FAIL vault ${va.vaults[0].address} signed`))).toBe(true);

    const dup = clone();
    dup.vaults.push({ ...dup.vaults[0], address: dup.vaults[0].address.toLowerCase() });
    expect(m.check(file(dup), OPERATOR).lines.some((l) => l.includes("listed once"))).toBe(true);

    const blk = clone();
    blk.solanaSlot += 1;
    expect(m.check(file(blk), OPERATOR).ok).toBe(false);
  });
});
