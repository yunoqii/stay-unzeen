import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { signRequest, signerFromSecret } from "@/lib/crypto/sign";
import { unz1MemoString } from "@/lib/crypto/unz1";
import { depositFields, depositUri, poolChainId } from "@/lib/deposit";
import { checkProof, checkSnapshot, proofFile, solvency } from "@/lib/verify/merkle-sum";
import { checkOwnBalance, proofJson } from "@/lib/verify/own";
import { MOCK_OPERATOR_PUBKEY, pinnedOperator } from "@/lib/verify/pinned";
import type { VerifyProof, VerifySnapshot, VerifySnapshotSummary } from "./types";
import { handle, mockDepositPhase, mockPay, mockPool, mockTakeSnapshot } from "./mock";

const SK = hexToBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const signer = signerFromSecret(SK);

async function call<T>(path: string, signed = false): Promise<T> {
  const p = handle("devnet", "GET", path, undefined, signed ? signRequest(signer, { chainId: "0202", method: "GET", pathWithQuery: path }) : {});
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(500);
  return (await p) as T;
}

describe("mock Verify: full own-balance scenario", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_760_400_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("top up, operator snapshot, signed proof, everything checks out in the browser code", async () => {
    // 1. Credit 0.25 ZEC to the key (mock wallet + scanner).
    await call("/api/portfolio", true);
    const pool = mockPool("devnet");
    const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, poolChainId(pool, "devnet"));
    mockPay("devnet", depositUri(pool, "25000000", memo));
    vi.advanceTimersByTime(20_000);
    expect(mockDepositPhase("devnet", memo).phase).toBe("credited");

    // 2. The operator takes a snapshot: not anchored, not signed yet.
    const id = await mockTakeSnapshot("devnet");
    const fresh = await call<VerifySnapshot>("/api/verify");
    expect(fresh.id).toBe(id);
    expect(fresh.operator).toBeUndefined();
    expect(fresh.anchor).toBeUndefined();
    expect(checkSnapshot(fresh, MOCK_OPERATOR_PUBKEY)).toMatchObject({ digestOk: true, operator: "pending", anchor: "pending", allVaultsOk: true });

    // 3. A few seconds later the memo-tx is confirmed: signature and anchor appear.
    vi.advanceTimersByTime(7_000);
    const snap = await call<VerifySnapshot>(`/api/verify/${id}`);
    expect(snap.leaves).toBeGreaterThanOrEqual(1024);
    expect(checkSnapshot(snap, pinnedOperator("devnet"))).toMatchObject({ digestOk: true, operator: "verified", anchor: "anchored", allVaultsOk: true });
    for (const row of solvency(snap, checkSnapshot(snap, MOCK_OPERATOR_PUBKEY))) expect(row.covered).toBe(true);

    // 4. Signed proof: exactly 64 KiB, climbs to every root, committed >= the balance.
    const proof = await call<VerifyProof>(`/api/verify/proof?snapshot=${id}`, true);
    expect(JSON.stringify(proof).length).toBe(65_536);
    const r = checkProof(snap, proof, signer.pubkey);
    expect(r.ok).toBe(true);
    const zec = r.assets.find((a) => a.asset === "ZEC")!;
    expect(zec.committed >= BigInt(25_000_000)).toBe(true);
    expect(zec.pieces.length).toBeGreaterThanOrEqual(2);
    for (const p of zec.pieces) expect(p.steps).toHaveLength(Math.log2(snap.leaves));
    // Same verdict from the offline script, signed snapshot, pinned key.
    const script = path.resolve(__dirname, "../../public/verify/verify-proof.mjs");
    const mod = (await import(/* @vite-ignore */ script)) as { check(f: unknown, op?: string): { ok: boolean } };
    expect(mod.check(proofFile(snap, proof, signer.pubkey), MOCK_OPERATOR_PUBKEY).ok).toBe(true);

    // 5. History lists it first; the proof needs the signature.
    const hist = await call<VerifySnapshotSummary[]>("/api/verify/snapshots?limit=30");
    expect(hist[0].id).toBe(id);
    expect(hist.length).toBeGreaterThan(2);
    await expect(call("/api/verify/proof")).rejects.toMatchObject({ code: "unauthorized" });
    // Older than the previous snapshot: paths are gone (48 h).
    await expect(call(`/api/verify/proof?snapshot=${hist[3].id}`, true)).rejects.toMatchObject({ code: "not_found" });
    await expect(call("/api/verify/snapshots?limit=31")).rejects.toMatchObject({ code: "bad_request" });
    await expect(call("/api/verify/1")).rejects.toMatchObject({ code: "not_found" });
  });

  it("checkOwnBalance writes nothing to browser storage, and the download has no padding", async () => {
    const writes: string[] = [];
    const store = { getItem: () => null, setItem: (k: string) => void writes.push(k), removeItem: () => {}, clear: () => {}, key: () => null, length: 0 };
    vi.stubGlobal("localStorage", store);
    vi.stubGlobal("sessionStorage", store);
    vi.stubGlobal("indexedDB", { open: () => void writes.push("indexedDB") });
    try {
      const snapP = call<VerifySnapshot>("/api/verify");
      const snap = await snapP;
      const p = checkOwnBalance(signer, snap);
      await vi.advanceTimersByTimeAsync(500);
      const own = (await p)!;
      expect(own.result.ok).toBe(true);
      expect("pad" in own.proof).toBe(false);
      const file = JSON.parse(proofJson(snap, own));
      expect(file).toMatchObject({ format: "unzeen-verify-proof/v1", anonPubkey: signer.pubkey, snapshot: { id: snap.id }, proof: { snapshotId: snap.id } });
      expect(writes).toEqual([]);

      // The offline script (public/verify/verify-proof.mjs) agrees with the page on the same file.
      const script = path.resolve(__dirname, "../../public/verify/verify-proof.mjs");
      const mod = (await import(/* @vite-ignore */ script)) as { check(f: unknown, op?: string): { ok: boolean; lines: string[] } };
      // This snapshot is not signed yet at the frozen clock: fine without a pinned key, a fail with one.
      expect(mod.check(file).ok).toBe(true);
      expect(mod.check(file, MOCK_OPERATOR_PUBKEY).ok).toBe(snap.operator?.pubkey === MOCK_OPERATOR_PUBKEY);
      const forged = structuredClone(file);
      forged.proof.proofs[0].pieces[0].path[0].sum = String(BigInt(forged.proof.proofs[0].pieces[0].path[0].sum) + BigInt(1));
      expect(mod.check(forged).ok).toBe(false);
      expect(mod.check(file, "11111111111111111111111111111111").ok).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("10 proofs a minute per key, then 429", async () => {
    vi.setSystemTime(Date.now() + 120_000);
    const codes: string[] = [];
    for (let i = 0; i < 11; i++) {
      try {
        await call("/api/verify/proof", true);
        codes.push("ok");
      } catch (e) {
        codes.push((e as { code: string }).code);
      }
    }
    expect(codes.slice(0, 10).every((c) => c === "ok")).toBe(true);
    expect(codes[10]).toBe("rate_limited");
  });
});
