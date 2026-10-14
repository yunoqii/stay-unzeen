// Verify on Robinhood Chain: EIP-712 vault statements and the EIP-191 operator signature, checked with the
// browser code (noble). Vectors: viem (testdata/evm-sig-vectors.json) and a REAL Verify v3 snapshot recorded
// from the hood end-to-end run (adapters/test/evm/hood-e2e.test.ts, GET /api/verify/1 → testdata/hood-snapshot.json).

import { describe, expect, it } from "vitest";
import type { VerifySnapshot } from "@/lib/api/types";
import { recoverAddress, personalHash, verifyOperatorEip191, verifyVaultEip712 } from "./evm-sig";
import { checkSnapshot, rootsDigest } from "./merkle-sum";
import viem from "./testdata/evm-sig-vectors.json";
import hood from "./testdata/hood-snapshot.json";

const snap = hood as unknown as VerifySnapshot;

describe("EVM signatures (viem vectors)", () => {
  it("EIP-712 vault statement", () => {
    expect(verifyVaultEip712(viem.chainId, viem.snapshotId, viem.vault, BigInt(viem.blockNumber), viem.vaultSig)).toBe(true);
    // Bound to every field and the chain.
    expect(verifyVaultEip712(46630, viem.snapshotId, viem.vault, BigInt(viem.blockNumber), viem.vaultSig)).toBe(false);
    expect(verifyVaultEip712(viem.chainId, "8", viem.vault, BigInt(viem.blockNumber), viem.vaultSig)).toBe(false);
    expect(verifyVaultEip712(viem.chainId, viem.snapshotId, viem.vault, BigInt(viem.blockNumber) + BigInt(1), viem.vaultSig)).toBe(false);
    expect(verifyVaultEip712(viem.chainId, viem.snapshotId, viem.operator, BigInt(viem.blockNumber), viem.vaultSig)).toBe(false);
  });

  it("EIP-191 operator signature over the digest bytes", () => {
    expect(verifyOperatorEip191(viem.operator, viem.digest, viem.operatorSig)).toBe(true);
    expect(verifyOperatorEip191(viem.vault, viem.digest, viem.operatorSig)).toBe(false);
    expect(verifyOperatorEip191(viem.operator, viem.digest.replace(/^0/, "1"), viem.operatorSig)).toBe(false);
  });

  it("malformed signatures never throw", () => {
    expect(recoverAddress(personalHash(new Uint8Array(32)), "0x1234")).toBeNull();
    expect(verifyOperatorEip191("nope", viem.digest, viem.operatorSig)).toBe(false);
  });
});

describe("real hood snapshot (Verify v3)", () => {
  it("digest v3 recomputes", () => {
    expect(snap.digestVersion).toBe(3);
    expect(rootsDigest(snap)).toBe(snap.rootsDigest);
  });

  it("operator EIP-191 and every vault's EIP-712 statement check out", () => {
    expect(verifyOperatorEip191(snap.operator!.pubkey, snap.rootsDigest, snap.operator!.sig)).toBe(true);
    for (const v of snap.vaults) expect(verifyVaultEip712(4663, snap.id, v.address, snap.solanaSlot, v.sig)).toBe(true);
  });

  it("checkSnapshot passes it with the EVM checks (pinned operator by address)", () => {
    const c = checkSnapshot(snap, snap.operator!.pubkey.toLowerCase());
    expect(c.digestOk).toBe(true);
    expect(c.operator).toBe("verified");
    expect(c.allVaultsOk).toBe(true);
    expect(c.anchor).toBe("anchored");
    // A tampered vault signature or a Solana-style check would fail.
    const bad = { ...snap, vaults: snap.vaults.map((v, i) => (i === 0 ? { ...v, sig: snap.vaults[1].sig } : v)) };
    expect(checkSnapshot(bad, null).allVaultsOk).toBe(false);
  });
});

describe("solvency on the real hood snapshot", () => {
  it("rows compute in wei / 18-decimal tokens without loss", async () => {
    const { solvency } = await import("./merkle-sum");
    const rows = solvency(snap, checkSnapshot(snap, null));
    expect(rows.length).toBe(snap.trees.length);
    for (const r of rows) expect(typeof r.liabilities === "bigint" || r.liabilities === undefined).toBe(true);
  });
});
