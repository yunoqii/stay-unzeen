import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { buildTree, leafOf, MIN_LEAVES, verifyInclusion } from "./merkle";

// Independent vector (python hashlib, same rules as core/fair/src/merkle.rs): leaves "ct-b", "ct-a",
// "ct-c", padding [k; 32] for k = 1..5, proof for "ct-a".
const VECTOR = {
  ciphertext: "ct-a",
  leaf: "a18ee061a935a53f6f0758a231bcfd9e074d4ead792fc260f35fcbbf97255de3",
  path: [
    "fbcd9fc7bd7f4b8c895bff7e1f80a8284fa56c97c2075077eed7d57fed61ca9d",
    "fd745a956788ba63dd71a727a10129cc6ba8d7546076e5f848cf7f323fff1cbb",
    "c3e6c58c4802de670cf839d693e04ffc7c0e91c32ea81586e0dcb9433a9a2c30",
  ],
  root: "5be5a3e9dac07ba5d2ed3fb25df9ebdf71e885e5c92987959ea445e9d352786c",
};

describe("inclusion proof (commitment root)", () => {
  it("verifies the reference vector", () => {
    const r = verifyInclusion(VECTOR.ciphertext, { leaf: VECTOR.leaf, path: VECTOR.path }, VECTOR.root);
    expect(r.ok).toBe(true);
    expect(r.leaf).toBe(VECTOR.leaf);
    expect(r.trace.at(-1)).toBe(VECTOR.root);
    // Upper-case hex from a server is fine.
    expect(verifyInclusion(VECTOR.ciphertext, { leaf: VECTOR.leaf.toUpperCase(), path: VECTOR.path.map((p) => p.toUpperCase()) }, VECTOR.root.toUpperCase()).ok).toBe(true);
  });

  it("fails for another ciphertext, a tampered path or another root", () => {
    expect(verifyInclusion("ct-b", { leaf: VECTOR.leaf, path: VECTOR.path }, VECTOR.root).ok).toBe(false);
    const bad = [...VECTOR.path];
    bad[1] = "00".repeat(32);
    expect(verifyInclusion(VECTOR.ciphertext, { leaf: VECTOR.leaf, path: bad }, VECTOR.root).ok).toBe(false);
    expect(verifyInclusion(VECTOR.ciphertext, { leaf: VECTOR.leaf, path: VECTOR.path }, "11".repeat(32)).ok).toBe(false);
    expect(verifyInclusion(VECTOR.ciphertext, { leaf: VECTOR.leaf, path: ["zz"] }, VECTOR.root).ok).toBe(false);
  });

  it("a proof whose leaf is not ours is refused even if the path climbs to the root", () => {
    const r = verifyInclusion(VECTOR.ciphertext, { leaf: "ab".repeat(32), path: VECTOR.path }, VECTOR.root);
    expect(r.leafMatches).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("buildTree matches the vector and every proof verifies, for every size", () => {
    let k = 0;
    const t = buildTree([leafOf("ct-b"), leafOf("ct-a"), leafOf("ct-c")], () => new Uint8Array(32).fill(++k));
    expect(bytesToHex(t.root)).toBe(VECTOR.root);
    expect(t.proofs[1].map(bytesToHex)).toEqual(VECTOR.path);

    for (const n of [1, 2, 5, 8, 9, 31]) {
      const cts = Array.from({ length: n }, (_, i) => `ct-${i}`);
      const tree = buildTree(cts.map(leafOf), () => crypto.getRandomValues(new Uint8Array(32)));
      let depth = 0;
      for (let s = Math.max(MIN_LEAVES, n); s > 1; s = Math.ceil(s / 2)) depth++;
      cts.forEach((ct, i) => {
        expect(tree.proofs[i].length).toBe(depth);
        expect(verifyInclusion(ct, { leaf: bytesToHex(leafOf(ct)), path: tree.proofs[i].map(bytesToHex) }, bytesToHex(tree.root)).ok).toBe(true);
      });
    }
  });
});
