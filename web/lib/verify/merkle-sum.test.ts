import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import type { VerifyProof, VerifySnapshot } from "@/lib/api/types";
import {
  checkProof,
  checkSnapshot,
  climb,
  coverageBps,
  leafHash,
  nodeOf,
  quoteAssetBytes,
  rootsDigest,
  solvency,
  vaultMessage,
  verifyVault,
  ZEC_ASSET,
  type SumNode,
} from "./merkle-sum";
import { claimableZat, compareWithPortfolio } from "./own";
import V from "./testdata/verify-vectors.json";

const CORE = path.resolve(__dirname, "../../../core/testdata/verify-vectors.json");
const b = (h: string) => hexToBytes(h);
const n = (s: string | number) => BigInt(s);

describe("verify vectors (core/testdata/verify-vectors.json)", () => {
  it("web copy equals core's file", () => {
    if (!existsSync(CORE)) return;
    expect(JSON.parse(readFileSync(CORE, "utf8"))).toEqual(V);
  });

  it("every ZEC leaf hash", () => {
    for (const l of V.zecTree.leaves) {
      const h = leafHash({ chainId: V.chainId, snapshotId: V.snapshotId, asset: ZEC_ASSET, anonPubkey: b(l.anonPubkey), piece: l.piece, value: n(l.value), blind: b(l.blind) });
      expect(bytesToHex(h)).toBe(l.leaf);
    }
  });

  it("mint leaf (asset = base58 bytes of the mint)", () => {
    const m = V.mintLeaf;
    expect(bytesToHex(base58.decode(m.mint))).toBe(m.asset);
    const h = leafHash({ chainId: V.chainId, snapshotId: V.snapshotId, asset: b(m.asset), anonPubkey: b(m.anonPubkey), piece: m.piece, value: n(m.value), blind: b(m.blind) });
    expect(bytesToHex(h)).toBe(m.leaf);
  });

  it("node(0,1) and the root of the whole tree", () => {
    const leaves: SumNode[] = V.zecTree.leaves.map((l) => ({ hash: b(l.leaf), sum: n(l.value) }));
    const n01 = nodeOf(leaves[0], leaves[1]);
    expect(bytesToHex(n01.hash)).toBe(V.zecTree.node01.hash);
    expect(n01.sum.toString()).toBe(V.zecTree.node01.sum);
    let lvl = leaves;
    while (lvl.length > 1) lvl = Array.from({ length: lvl.length / 2 }, (_, i) => nodeOf(lvl[2 * i], lvl[2 * i + 1]));
    expect(bytesToHex(lvl[0].hash)).toBe(V.zecTree.root.hash);
    expect(lvl[0].sum.toString()).toBe(V.zecTree.root.sum);
  });

  it("the proof path climbs to the root", () => {
    const { leafIndex, path: p } = V.zecTree.proof;
    const l = V.zecTree.leaves[leafIndex];
    const { root, steps } = climb({ hash: b(l.leaf), sum: n(l.value) }, leafIndex, p);
    expect(bytesToHex(root.hash)).toBe(V.zecTree.root.hash);
    expect(root.sum.toString()).toBe(V.zecTree.root.sum);
    // 5 = 0b101: sibling left, right, left.
    expect(steps.map((s) => s.siblingSide)).toEqual(["left", "right", "left"]);
  });

  it("rootsDigest from the snapshot fields", () => {
    const s = V.snapshot;
    const d = rootsDigest({
      chainId: V.chainId,
      id: V.snapshotId,
      takenAt: s.takenAtSec * 1000,
      leaves: s.leaves,
      solanaSlot: s.solanaSlot,
      zcashHeight: s.zcashHeight,
      zecReserve: { amountZat: s.zecReserveZat, height: s.zcashHeight, attested: true },
      // Given in any order: hashed ascending by asset bytes.
      trees: [...s.trees].reverse().map((t) => ({ asset: t.asset === "0".repeat(64) ? "ZEC" : base58.encode(b(t.asset)), decimals: 0, granule: "1", root: t.root, sum: t.sum })),
    });
    expect(d).toBe(s.rootsDigest);
  });

  it("operator signature over the 32 digest bytes", () => {
    const s = V.snapshot;
    expect(base58.encode(ed25519.getPublicKey(b(s.operatorSeed)))).toBe(s.operatorPubkey);
    expect(ed25519.verify(base58.decode(s.operatorSig), b(s.rootsDigest), base58.decode(s.operatorPubkey), { zip215: false })).toBe(true);
  });

  it("vault message and signature", () => {
    const v = V.vault;
    expect(vaultMessage(V.chainId, V.snapshotId, v.address)).toBe(v.message);
    expect(base58.encode(ed25519.getPublicKey(b(v.seed)))).toBe(v.address);
    expect(verifyVault(V.chainId, V.snapshotId, v)).toBe(true);
    expect(verifyVault(V.chainId, V.snapshotId + 1, v)).toBe(false);
    expect(verifyVault("0101", V.snapshotId, v)).toBe(false);
  });
});

// ---- v0.17: digest v2 also signs quoteAssets ----

describe("verify vectors: snapshotV2 (API v0.17)", () => {
  const s = V.snapshot;
  const S2 = V.snapshotV2;
  const base = () => ({
    chainId: V.chainId,
    id: V.snapshotId,
    takenAt: s.takenAtSec * 1000,
    leaves: s.leaves,
    solanaSlot: s.solanaSlot,
    zcashHeight: s.zcashHeight,
    zecReserve: { amountZat: s.zecReserveZat, height: s.zcashHeight, attested: true as const },
    trees: s.trees.map((t) => ({ asset: t.asset === "0".repeat(64) ? "ZEC" : base58.encode(b(t.asset)), decimals: 0, granule: "1", root: t.root, sum: t.sum })),
  });
  const quotes = S2.quoteAssets as VerifySnapshot["quoteAssets"] & object;

  it("each quote asset encodes byte for byte", () => {
    expect(quotes.map((q) => bytesToHex(quoteAssetBytes(q)))).toEqual(S2.quoteBytes);
  });

  it("digest v2 equals core's, in any input order; v1 ignores quoteAssets", () => {
    expect(S2.digestVersion).toBe(2);
    expect(rootsDigest({ ...base(), digestVersion: 2, quoteAssets: [...quotes].reverse() })).toBe(S2.rootsDigest);
    expect(rootsDigest({ ...base(), digestVersion: 2, quoteAssets: quotes })).toBe(S2.rootsDigest);
    expect(rootsDigest({ ...base(), quoteAssets: quotes })).toBe(s.rootsDigest);
    expect(rootsDigest({ ...base(), digestVersion: 1, quoteAssets: quotes })).toBe(s.rootsDigest);
  });

  it("v2 changes with any quote field; Q = 0 without quoteAssets", () => {
    const d0 = rootsDigest({ ...base(), digestVersion: 2 });
    expect(d0).not.toBe(s.rootsDigest);
    expect(d0).not.toBe(S2.rootsDigest);
    expect(rootsDigest({ ...base(), digestVersion: 2, quoteAssets: [] })).toBe(d0);
    const flip = [{ ...quotes[0], counted: false }, quotes[1]];
    expect(rootsDigest({ ...base(), digestVersion: 2, quoteAssets: flip })).not.toBe(S2.rootsDigest);
    const dust = [{ ...quotes[0], dustBelow: "1" }, quotes[1]];
    expect(rootsDigest({ ...base(), digestVersion: 2, quoteAssets: dust })).not.toBe(S2.rootsDigest);
  });

  it("operator signature verifies over the v2 digest", () => {
    expect(ed25519.verify(base58.decode(S2.operatorSig), b(S2.rootsDigest), base58.decode(s.operatorPubkey), { zip215: false })).toBe(true);
  });

  it("an unknown digestVersion is refused, never guessed", () => {
    expect(() => rootsDigest({ ...base(), digestVersion: 4 as unknown as 2 })).toThrow(/digestVersion/);
  });

  it("verify-proof.mjs computes the same v1 and v2 digests and quote bytes", async () => {
    const mjs = (await import(/* @vite-ignore */ path.resolve(__dirname, "../../public/verify/verify-proof.mjs"))) as {
      rootsDigest(s: unknown): string;
      quoteBytes(q: unknown): Uint8Array;
    };
    expect(quotes.map((q) => bytesToHex(mjs.quoteBytes(q)))).toEqual(S2.quoteBytes);
    expect(mjs.rootsDigest({ ...base(), digestVersion: 2, quoteAssets: [...quotes].reverse() })).toBe(S2.rootsDigest);
    expect(mjs.rootsDigest({ ...base(), quoteAssets: quotes })).toBe(s.rootsDigest);
    expect(() => mjs.rootsDigest({ ...base(), digestVersion: 3 })).toThrow(/digestVersion/);
  });
});

// ---- v0.10: creator fees inside the ZEC leaf, mint granule 1, no SOL tree ----

describe("verify vectors: creatorSnapshot (API v0.10)", () => {
  const C = V.creatorSnapshot;
  const VAULT_SEED = new Uint8Array(32).fill(5);
  const VAULT = base58.encode(ed25519.getPublicKey(VAULT_SEED));
  const snap = (): VerifySnapshot => ({
    id: C.snapshotId,
    chainId: C.chainId,
    takenAt: C.snapshot.takenAtSec * 1000,
    rootsDigest: C.snapshot.rootsDigest,
    leaves: C.snapshot.leaves,
    solanaSlot: C.snapshot.solanaSlot,
    zcashHeight: C.snapshot.zcashHeight,
    operator: { pubkey: C.snapshot.operatorPubkey, sig: C.snapshot.operatorSig },
    trees: [
      { asset: "ZEC", decimals: 8, granule: C.zecTree.granule, root: C.zecTree.root.hash, sum: C.zecTree.root.sum },
      { asset: C.mintTree.mint, decimals: 6, granule: C.mintTree.granule, root: C.mintTree.root.hash, sum: C.mintTree.root.sum },
    ],
    // The vector's vault carries balances only; signed here with a test key (vaults are not in the digest).
    vaults: C.snapshot.vaults.map((v) => ({
      address: VAULT,
      sig: base58.encode(ed25519.sign(enc.encode(vaultMessage(C.chainId, C.snapshotId, VAULT)), VAULT_SEED)),
      lamports: v.lamports,
      tokens: v.tokens,
    })),
    committedLamports: C.snapshot.committedLamports,
    rateLamportsPerZecSell: C.rateLamportsPerZecSell,
    rateLamportsPerZecBuy: C.rateLamportsPerZecBuy,
    zecReserve: { amountZat: C.snapshot.zecReserveZat, height: C.snapshot.zcashHeight, attested: true },
  });
  const rootOf = (leaves: SumNode[]) => {
    let lvl = leaves;
    while (lvl.length > 1) lvl = Array.from({ length: lvl.length / 2 }, (_, i) => nodeOf(lvl[2 * i], lvl[2 * i + 1]));
    return lvl[0];
  };
  const pathOf = (leaves: SumNode[], idx: number) => {
    const out: { hash: string; sum: string }[] = [];
    let lvl = leaves;
    while (lvl.length > 1) {
      const sib = lvl[idx ^ 1];
      out.push({ hash: bytesToHex(sib.hash), sum: sib.sum.toString() });
      lvl = Array.from({ length: lvl.length / 2 }, (_, i) => nodeOf(lvl[2 * i], lvl[2 * i + 1]));
      idx >>= 1;
    }
    return out;
  };
  const treeLeaves = (t: typeof C.zecTree, asset: Uint8Array): SumNode[] =>
    t.leaves.map((l) => {
      const h = leafHash({ chainId: C.chainId, snapshotId: C.snapshotId, asset, anonPubkey: b(l.anonPubkey), piece: l.piece, value: n(l.value), blind: b(l.blind) });
      expect(bytesToHex(h)).toBe(l.leaf);
      return { hash: h, sum: n(l.value) };
    });

  it("creator ZEC value = balance + ceil(Σ claimable × 1e8 / rateBuy), rounded up to 0.001 ZEC", () => {
    const claim = claimableZat(C.creator.claimable.map((c) => ({ solAmount: c.lamports })), C.rateLamportsPerZecBuy);
    expect(claim.toString()).toBe(C.creator.claimableZat);
    const value = n(C.creator.balanceZat) + claim;
    expect(value.toString()).toBe(C.creator.valueZat);
    const g = n(C.zecTree.granule);
    expect((((value + g - n(1)) / g) * g).toString()).toBe(C.creator.roundedZat);
    // The creator's pieces in the ZEC tree add up to exactly that.
    const mine = C.zecTree.leaves.filter((l) => !l.dummy && l.anonPubkey === C.creator.anonPubkey);
    expect(mine.reduce((x, l) => x + n(l.value), n(0)).toString()).toBe(C.creator.roundedZat);
    // No rate = nothing folded in.
    expect(claimableZat([{ solAmount: "1" }], undefined)).toBe(n(0));
  });

  it("leaves and roots of the ZEC and mint (granule 1) trees", () => {
    expect(bytesToHex(base58.decode(C.mintTree.mint))).toBe(C.mintTree.asset);
    const z = rootOf(treeLeaves(C.zecTree, ZEC_ASSET));
    expect([bytesToHex(z.hash), z.sum.toString()]).toEqual([C.zecTree.root.hash, C.zecTree.root.sum]);
    const m = rootOf(treeLeaves(C.mintTree, b(C.mintTree.asset)));
    expect([bytesToHex(m.hash), m.sum.toString()]).toEqual([C.mintTree.root.hash, C.mintTree.root.sum]);
    expect(C.mintTree.leaves.some((l) => n(l.value) % n(1_000_000) !== n(0))).toBe(true);
  });

  it("digest, operator signature, no SOL tree", () => {
    const s = snap();
    expect(rootsDigest(s)).toBe(C.snapshot.rootsDigest);
    const c = checkSnapshot(s, C.snapshot.operatorPubkey);
    expect(c).toMatchObject({ digestOk: true, operator: "verified", anchor: "pending", allVaultsOk: true });
    // Signed before the memo-tx (v0.10): verified signature, anchor still pending.
    expect(s.anchor).toBeUndefined();
    const withSol = snap();
    withSol.trees.push({ asset: "SOL", decimals: 9, granule: "1000000", root: "00".repeat(32), sum: "0" });
    expect(checkSnapshot(withSol, C.snapshot.operatorPubkey).error).toMatch(/unknown asset id/);
  });

  it("solvency matches creatorSnapshot.solvency", () => {
    const s = snap();
    const rows = solvency(s, checkSnapshot(s, C.snapshot.operatorPubkey));
    expect(rows.map((r) => r.asset)).toEqual(["ZEC", C.mintTree.mint]);
    const zec = rows[0];
    expect(zec.liabilities.toString()).toBe(C.solvency.zec.liabilities);
    expect(zec.provenZat!.toString()).toBe(C.solvency.zec.solCoverZat);
    expect(zec.attestedZat!.toString()).toBe(C.solvency.zec.reserveZat);
    expect(zec.covered).toBe(C.solvency.zec.covered);
    const mint = rows[1];
    expect([mint.liabilities.toString(), mint.assets.toString(), mint.covered]).toEqual([C.solvency.mint.liabilities, C.solvency.mint.assets, C.solvency.mint.covered]);
  });

  it("the creator's own proof: committed ZEC covers balance + claimable (page and offline script)", async () => {
    const s = snap();
    const pk = base58.encode(b(C.creator.anonPubkey));
    const proofFor = (t: typeof C.zecTree, asset: string, assetBytes: Uint8Array, decimals: number) => {
      const leaves = treeLeaves(t, assetBytes);
      const pieces = t.leaves
        .filter((l) => !l.dummy && l.anonPubkey === C.creator.anonPubkey)
        .map((l) => ({ piece: l.piece, leafIndex: l.index, value: l.value, blind: l.blind, path: pathOf(leaves, l.index) }));
      return { asset, decimals, pieces };
    };
    const proof: VerifyProof = {
      snapshotId: C.snapshotId,
      truncated: false,
      proofs: [proofFor(C.zecTree, "ZEC", ZEC_ASSET, 8), proofFor(C.mintTree, C.mintTree.mint, b(C.mintTree.asset), 6)],
    };
    const r = checkProof(s, proof, pk);
    expect(r.ok).toBe(true);
    expect(r.assets.find((a) => a.asset === "ZEC")!.committed.toString()).toBe(C.creator.roundedZat);

    const portfolio = {
      zecBalance: C.creator.balanceZat,
      zecHeld: "0",
      holdings: [{ mint: C.mintTree.mint, amount: "1500000", held: "0" }],
      claimable: C.creator.claimable.map((c) => ({ mint: c.mint, solAmount: c.lamports })),
      deposits: [],
      actions: [],
      orders: [],
    };
    const cmp = compareWithPortfolio({ proof, result: r }, s, portfolio);
    expect(cmp.rows.find((x) => x.asset === "ZEC")).toMatchObject({ now: n(C.creator.valueZat), status: "covered" });
    expect(cmp.rows.every((x) => x.status === "covered")).toBe(true);

    const mjs = (await import(/* @vite-ignore */ path.resolve(__dirname, "../../public/verify/verify-proof.mjs"))) as {
      check(f: unknown, op?: string): { ok: boolean; lines: string[] };
    };
    const res = mjs.check({ anonPubkey: pk, snapshot: s, proof }, C.snapshot.operatorPubkey);
    expect(res.ok).toBe(true);
    expect(res.lines.some((l) => l.startsWith("WAIT signed, anchor pending"))).toBe(true);
    expect(res.lines.some((l) => l.includes(`proven (SOL) + 0 bridged (ZEC SPL) + ${C.solvency.zec.reserveZat} attested`) && l.includes(C.solvency.zec.solCoverZat))).toBe(true);
  });
});

// ---- a full snapshot + proof, built the way core does ----

const enc = new TextEncoder();
const CHAIN = "0202";
const OP_SEED = new Uint8Array(32).fill(9);
const OP_PUB = base58.encode(ed25519.getPublicKey(OP_SEED));
const ME_SEED = new Uint8Array(32).fill(4);
const ME = base58.encode(ed25519.getPublicKey(ME_SEED));
const MINT = V.mintLeaf.mint;

function fixture(N = 16) {
  const id = 12;
  const myPk = base58.decode(ME);
  const build = (asset: Uint8Array, mine: { idx: number; piece: number; value: bigint }[], others: bigint[]) => {
    const leaves: SumNode[] = Array.from({ length: N }, (_, i) => ({ hash: leafHash({ chainId: CHAIN, snapshotId: id, asset, anonPubkey: new Uint8Array(32).fill(i + 100), piece: 0, value: others[i] ?? BigInt(0), blind: new Uint8Array(32).fill(i) }), sum: others[i] ?? BigInt(0) }));
    const blinds = mine.map((m) => new Uint8Array(32).fill(200 + m.piece));
    mine.forEach((m, k) => (leaves[m.idx] = { hash: leafHash({ chainId: CHAIN, snapshotId: id, asset, anonPubkey: myPk, piece: m.piece, value: m.value, blind: blinds[k] }), sum: m.value }));
    const levels = [leaves];
    while (levels[levels.length - 1].length > 1) {
      const p = levels[levels.length - 1];
      levels.push(Array.from({ length: p.length / 2 }, (_, i) => nodeOf(p[2 * i], p[2 * i + 1])));
    }
    const pieces = mine.map((m, k) => {
      const path: { hash: string; sum: string }[] = [];
      let i = m.idx;
      for (let l = 0; l < levels.length - 1; l++, i >>= 1) path.push({ hash: bytesToHex(levels[l][i ^ 1].hash), sum: levels[l][i ^ 1].sum.toString() });
      return { piece: m.piece, leafIndex: m.idx, value: m.value.toString(), blind: bytesToHex(blinds[k]), path };
    });
    return { root: levels[levels.length - 1][0], pieces };
  };
  const zec = build(ZEC_ASSET, [{ idx: 3, piece: 0, value: BigInt(200_000) }, { idx: 12, piece: 1, value: BigInt(1_100_000) }], [BigInt(500_000), BigInt(0), BigInt(9_900_000)]);
  const mint = build(base58.decode(MINT), [{ idx: 7, piece: 0, value: BigInt(3_000_000) }, { idx: 0, piece: 1, value: BigInt(0) }], [BigInt(0), BigInt(41_000_000)]);
  const vaultSeed = new Uint8Array(32).fill(5);
  const vaultAddr = base58.encode(ed25519.getPublicKey(vaultSeed));
  const base = {
    id,
    chainId: CHAIN,
    takenAt: 1_791_849_600_000,
    leaves: N,
    solanaSlot: 400_000_123,
    zcashHeight: 3_100_200,
    trees: [
      { asset: "ZEC", decimals: 8, granule: "100000", root: bytesToHex(zec.root.hash), sum: zec.root.sum.toString() },
      { asset: MINT, decimals: 6, granule: "1000000", root: bytesToHex(mint.root.hash), sum: mint.root.sum.toString() },
    ],
    vaults: [
      {
        address: vaultAddr,
        sig: base58.encode(ed25519.sign(enc.encode(vaultMessage(CHAIN, id, vaultAddr)), vaultSeed)),
        lamports: "20000000000",
        tokens: [{ mint: MINT, amount: "45000000" }],
      },
    ],
    committedLamports: "2000000000",
    rateLamportsPerZecSell: "1800000000",
    zecReserve: { amountZat: "300000000", height: 3_100_200, attested: true as const },
  };
  const digest = rootsDigest(base);
  const snapshot: VerifySnapshot = {
    ...base,
    rootsDigest: digest,
    operator: { pubkey: OP_PUB, sig: base58.encode(ed25519.sign(b(digest), OP_SEED)) },
    anchor: { solanaTx: "5".repeat(88), slot: 400_000_170, matches: true },
  };
  const proof: VerifyProof = {
    snapshotId: id,
    truncated: false,
    proofs: [
      { asset: "ZEC", decimals: 8, pieces: zec.pieces },
      { asset: MINT, decimals: 6, pieces: mint.pieces },
    ],
  };
  return { snapshot, proof };
}

const clone = <T,>(x: T): T => structuredClone(x);

describe("Merkle-sum proof of the own balance", () => {
  it("every piece climbs to its root; committed = Σ pieces", () => {
    const { snapshot, proof } = fixture();
    const r = checkProof(snapshot, proof, ME);
    expect(r.ok).toBe(true);
    expect(r.assets.map((a) => [a.asset, a.committed.toString()])).toEqual([
      ["ZEC", "1300000"],
      [MINT, "3000000"],
    ]);
    for (const a of r.assets) for (const p of a.pieces) expect(p.steps).toHaveLength(4);
  });

  it("each node sum equals the sum of its children", () => {
    const { snapshot, proof } = fixture();
    const r = checkProof(snapshot, proof, ME);
    for (const a of r.assets)
      for (const p of a.pieces) {
        let below = p.value;
        for (const s of p.steps) {
          expect(s.node.sum).toBe(below + s.sibling.sum);
          below = s.node.sum;
        }
        expect(below.toString()).toBe(snapshot.trees.find((t) => t.asset === a.asset)!.sum);
      }
  });

  it("a forged sibling sum fails (understating the total)", () => {
    const { snapshot, proof } = fixture();
    const bad = clone(proof);
    const s = bad.proofs[0].pieces[0].path[2];
    s.sum = (BigInt(s.sum) - BigInt(100_000)).toString();
    const r = checkProof(snapshot, bad, ME);
    expect(r.ok).toBe(false);
    expect(r.assets[0].pieces[0]).toMatchObject({ ok: false, rootMatches: false, sumMatches: false });
    expect(r.assets[0].committed).toBe(BigInt(1_100_000)); // only the untouched piece counts
  });

  it("moving value between siblings keeps the total but breaks the hash", () => {
    const { snapshot, proof } = fixture();
    const bad = clone(proof);
    const p = bad.proofs[0].pieces[0];
    p.value = (BigInt(p.value) + BigInt(100_000)).toString();
    p.path[0].sum = (BigInt(p.path[0].sum) - BigInt(100_000) < BigInt(0) ? BigInt(0) : BigInt(p.path[0].sum) - BigInt(100_000)).toString();
    const r = checkProof(snapshot, bad, ME).assets[0].pieces[0];
    expect(r.rootMatches).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("a forged sibling hash, a wrong index, someone else's key, another snapshot: all fail", () => {
    const { snapshot, proof } = fixture();
    const h = clone(proof);
    h.proofs[1].pieces[0].path[1].hash = "00".repeat(32);
    expect(checkProof(snapshot, h, ME).ok).toBe(false);

    const i = clone(proof);
    i.proofs[0].pieces[0].leafIndex ^= 1;
    expect(checkProof(snapshot, i, ME).ok).toBe(false);

    expect(checkProof(snapshot, proof, OP_PUB).ok).toBe(false);
    expect(checkProof({ ...snapshot, id: 13 }, { ...proof, snapshotId: 13 }, ME).ok).toBe(false);
    expect(checkProof(snapshot, { ...proof, snapshotId: 11 }, ME).error).toMatch(/snapshot #11/);
  });

  it("malformed input fails closed", () => {
    const { snapshot, proof } = fixture();
    const short = clone(proof);
    short.proofs[0].pieces[0].path.pop();
    expect(checkProof(snapshot, short, ME).assets[0].pieces[0].error).toMatch(/levels/);
    const neg = clone(proof);
    neg.proofs[0].pieces[0].path[0].sum = "-1";
    expect(checkProof(snapshot, neg, ME).ok).toBe(false);
    const g = clone(proof);
    g.proofs[0].pieces[0].value = "150000"; // not a multiple of 0.001 ZEC
    expect(checkProof(snapshot, g, ME).assets[0].pieces[0].error).toMatch(/granule/);
    const dup = clone(proof);
    dup.proofs[0].pieces[1] = { ...dup.proofs[0].pieces[0], piece: 1 };
    expect(checkProof(snapshot, dup, ME).assets[0].ok).toBe(false);
    const none = clone(proof);
    none.proofs[0].asset = "So11111111111111111111111111111111111111112".slice(0, 30);
    expect(checkProof(snapshot, none, ME).ok).toBe(false);
  });
});

describe("snapshot signatures", () => {
  it("operator and every vault verify; key matches the pinned one", () => {
    const { snapshot } = fixture();
    const c = checkSnapshot(snapshot, OP_PUB);
    expect(c).toMatchObject({ digestOk: true, operator: "verified", allVaultsOk: true, anchor: "anchored" });
  });

  it("unpinned build, wrong pinned key, not signed yet", () => {
    const { snapshot } = fixture();
    expect(checkSnapshot(snapshot, null).operator).toBe("unpinned");
    expect(checkSnapshot(snapshot, base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(1)))).operator).toBe("wrong_key");
    const { operator, anchor, ...pending } = snapshot;
    void operator;
    void anchor;
    expect(checkSnapshot(pending, OP_PUB)).toMatchObject({ operator: "pending", anchor: "pending" });
    expect(checkSnapshot({ ...snapshot, anchor: { ...snapshot.anchor!, matches: false } }, OP_PUB).anchor).toBe("mismatch");
  });

  it("any edited field breaks the digest and the operator signature", () => {
    const { snapshot } = fixture();
    const edits: ((s: VerifySnapshot) => void)[] = [
      (s) => (s.zecReserve.amountZat = "900000000"),
      (s) => (s.trees[0].sum = (BigInt(s.trees[0].sum) - BigInt(100_000)).toString()),
      (s) => (s.trees[1].root = "11".repeat(32)),
      (s) => (s.solanaSlot += 1),
      (s) => (s.takenAt += 60_000),
      (s) => s.trees.pop(),
    ];
    for (const edit of edits) {
      const s = clone(snapshot);
      edit(s);
      const c = checkSnapshot(s, OP_PUB);
      expect(c.digestOk).toBe(false);
      expect(c.operator).toBe("bad_signature");
    }
  });

  it("a server-claimed digest is never trusted: signature is checked over the recomputed one", () => {
    const { snapshot } = fixture();
    const s = clone(snapshot);
    s.zecReserve.amountZat = "900000000"; // rootsDigest and sig left as they were
    expect(checkSnapshot(s, OP_PUB).operator).toBe("bad_signature");
  });

  it("a borrowed vault (signature for another snapshot or address) fails", () => {
    const { snapshot } = fixture();
    const s = clone(snapshot);
    s.vaults.push({ ...s.vaults[0], address: base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(6))) });
    const c = checkSnapshot(s, OP_PUB);
    expect(c.allVaultsOk).toBe(false);
    expect(Object.values(c.vaults)).toEqual([true, false]);
    // Its balance does not count towards the cover.
    s.vaults[1].tokens = [{ mint: MINT, amount: "999000000" }];
    const row = solvency(s, c).find((r) => r.asset === MINT)!;
    expect(row.assets).toBe(BigInt(45_000_000));
    expect(row.vaultsSigned).toBe(false);
  });
});

describe("solvency", () => {
  it("mint proven by vaults; ZEC = proven SOL + attested ZEC", () => {
    const { snapshot } = fixture();
    const rows = solvency(snapshot, checkSnapshot(snapshot, OP_PUB));
    expect(rows[0].asset).toBe("ZEC");
    const zec = rows[0];
    // spare = 20 - 2 SOL = 18 SOL at 1.8 SOL/ZEC = 10 ZEC proven, 3 ZEC attested.
    expect(zec).toMatchObject({ kind: "proven_attested", provenZat: BigInt(1_000_000_000), attestedZat: BigInt(300_000_000), covered: true });
    const mint = rows[1];
    expect(mint).toMatchObject({ kind: "proven", liabilities: BigInt(44_000_000), assets: BigInt(45_000_000), covered: true });
    expect(coverageBps(mint.assets, mint.liabilities)).toBe(10_227);
  });

  it("not covered when vault tokens fall short; no rate = no SOL in the ZEC cover", () => {
    const { snapshot } = fixture();
    const s = clone(snapshot);
    s.vaults[0].tokens[0].amount = "43000000";
    delete s.rateLamportsPerZecSell;
    const rows = solvency(s, checkSnapshot(s, OP_PUB));
    expect(rows.find((r) => r.asset === MINT)!.covered).toBe(false);
    expect(rows[0].provenZat).toBe(BigInt(0));
  });
});

describe("the proof is never stored", () => {
  // Static guard: nothing on the Verify path may touch persistent browser storage.
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts") ? [p] : [];
    });
  const root = path.resolve(__dirname, "../..");
  const sources = [...files(path.join(root, "lib/verify")), ...files(path.join(root, "components/verify")), path.join(root, "app/verify/page.tsx"), path.join(root, "lib/api/mock-verify.ts")];

  it.each(sources.map((s) => [path.relative(root, s), s]))("%s", (_name, file) => {
    const src = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|caches\.open/);
  });
});
