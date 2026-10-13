import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@noble/hashes/utils.js";
import { signRequest, signerFromSecret } from "@/lib/crypto/sign";
import { unz1MemoString } from "@/lib/crypto/unz1";
import { depositFields, depositUri, poolChainId } from "@/lib/deposit";
import { checkProof, checkSnapshot, proofFile, solvency } from "@/lib/verify/merkle-sum";
import { checkOwnBalance, compareWithPortfolio, proofJson } from "@/lib/verify/own";
import { MOCK_OPERATOR_PUBKEY, pinnedOperator } from "@/lib/verify/pinned";
import type { Portfolio, VerifyProof, VerifySnapshot, VerifySnapshotSummary } from "./types";
import { handle, mockCreditCreatorFees, mockDepositPhase, mockPay, mockPool, mockTakeSnapshot } from "./mock";

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

    // 2. The operator takes a snapshot: not signed, not anchored yet.
    const id = await mockTakeSnapshot("devnet");
    const fresh = await call<VerifySnapshot>("/api/verify");
    expect(fresh.id).toBe(id);
    expect(fresh.operator).toBeUndefined();
    expect(fresh.anchor).toBeUndefined();
    expect(checkSnapshot(fresh, MOCK_OPERATOR_PUBKEY)).toMatchObject({ digestOk: true, operator: "pending", anchor: "pending", allVaultsOk: true });

    // 3. v0.10: the operator signs right away, before the memo-tx ("Signed · Anchor pending").
    vi.advanceTimersByTime(1_500);
    const signedOnly = await call<VerifySnapshot>(`/api/verify/${id}`);
    expect(signedOnly.operator).toBeDefined();
    expect(signedOnly.anchor).toBeUndefined();
    expect(checkSnapshot(signedOnly, MOCK_OPERATOR_PUBKEY)).toMatchObject({ digestOk: true, operator: "verified", anchor: "pending" });

    // 4. A few seconds later the memo-tx is confirmed: the anchor appears.
    vi.advanceTimersByTime(24_000);
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

describe("Verify robustness (review E1, E3, E11, E12)", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_760_700_000_000 }));
  afterEach(() => vi.useRealTimers());

  type Mjs = { check(f: unknown, op?: string, opts?: { trustAnyOperator?: boolean }): { ok: boolean; lines: string[] } };
  const loadMjs = async () => (await import(/* @vite-ignore */ path.resolve(__dirname, "../../public/verify/verify-proof.mjs"))) as Mjs;

  it("creator fees in the ZEC leaf (v0.10), mint granule 1, dedupe, pinned operator, balance compare", async () => {
    const sk = crypto.getRandomValues(new Uint8Array(32));
    const me = signerFromSecret(sk);
    const signed = async <T,>(p: string): Promise<T> => {
      const r = handle("devnet", "GET", p, undefined, signRequest(me, { chainId: "0202", method: "GET", pathWithQuery: p }));
      r.catch(() => {});
      await vi.advanceTimersByTimeAsync(500);
      return (await r) as T;
    };
    await signed("/api/portfolio");
    const pool = mockPool("devnet");
    mockPay("devnet", depositUri(pool, "30000000", unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), sk, poolChainId(pool, "devnet"))));
    vi.advanceTimersByTime(20_000);
    const tokens = await call<{ mint: string; venue: string; status: string }[]>("/api/tokens");
    mockCreditCreatorFees("devnet", me.pubkey, tokens[0].mint, BigInt(12_345_678));

    const id = await mockTakeSnapshot("devnet");
    vi.advanceTimersByTime(9_000);
    const snap = await call<VerifySnapshot>(`/api/verify/${id}`);
    expect(snap.trees.some((t) => t.asset === "SOL")).toBe(false); // v0.10: no SOL tree
    expect(snap.rateLamportsPerZecBuy).toMatch(/^[1-9]\d*$/);
    for (const t of snap.trees) if (t.asset !== "ZEC") expect(t.granule).toBe("1"); // E1
    const check = checkSnapshot(snap, MOCK_OPERATOR_PUBKEY);
    expect(check).toMatchObject({ digestOk: true, operator: "verified", allVaultsOk: true, duplicateVaults: [] });
    const rows = solvency(snap, check);
    expect(rows[0].asset).toBe("ZEC");
    for (const r of rows) expect(r.covered).toBe(true);

    const proof = await signed<VerifyProof>(`/api/verify/proof?snapshot=${id}`);
    const res = checkProof(snap, proof, me.pubkey);
    expect(res.ok).toBe(true);
    // ZEC leaf = available + held + ceil(claimable × 1e8 / rateLamportsPerZecBuy), rounded up to 0.001 ZEC.
    const rateBuy = BigInt(snap.rateLamportsPerZecBuy!);
    const claimZat = (BigInt(12_345_678) * BigInt(100_000_000) + rateBuy - BigInt(1)) / rateBuy;
    expect(res.assets.some((a) => a.asset === "SOL")).toBe(false);
    expect(res.assets.find((a) => a.asset === "ZEC")!.committed >= BigInt(30_000_000) + claimZat).toBe(true);

    // E11: committed vs the portfolio now.
    const portfolio = await signed<Portfolio>("/api/portfolio");
    const own = { proof, result: res };
    const cmp = compareWithPortfolio(own, snap, { ...portfolio, actions: [], orders: [], deposits: [] });
    expect(cmp.rows.every((r) => r.status === "covered")).toBe(true);
    const richer = { ...portfolio, actions: [], orders: [], deposits: [], zecBalance: (BigInt(portfolio.zecBalance) + BigInt(10 ** 9)).toString() };
    expect(compareWithPortfolio(own, snap, richer).rows.find((r) => r.asset === "ZEC")!.status).toBe("short");
    const extra = { ...richer, holdings: [...portfolio.holdings, { mint: "So11111111111111111111111111111111111111112", amount: "5", held: "0" }] };
    expect(compareWithPortfolio(own, snap, extra).rows.find((r) => r.committed === null)!.status).toBe("missing");
    expect(compareWithPortfolio(own, snap, { ...extra, deposits: [{ id: "x", amountZat: "1", status: "credited", publicSource: false, ts: snap.takenAt } as never] }).rows.find((r) => r.asset === "ZEC")!.status).toBe("changed");

    // Offline script: creator snapshot works; signatures need a pinned key or an explicit opt-in.
    const mjs = await loadMjs();
    const file = proofFile(snap, proof, me.pubkey);
    expect(mjs.check(file, MOCK_OPERATOR_PUBKEY).ok).toBe(true);
    expect(mjs.check(file).ok).toBe(false);
    const trusting = mjs.check(file, undefined, { trustAnyOperator: true });
    expect(trusting.ok).toBe(true);
    expect(trusting.lines.some((l) => l.startsWith("WARN"))).toBe(true);

    // E12: a vault listed twice is counted once and flags the snapshot (page and script).
    const dup = structuredClone(snap);
    dup.vaults.push(structuredClone(dup.vaults[0]));
    const dc = checkSnapshot(dup, MOCK_OPERATOR_PUBKEY);
    expect(dc.allVaultsOk).toBe(false);
    expect(dc.duplicateVaults).toEqual([dup.vaults[0].address]);
    const single = solvency(snap, check).find((r) => r.asset === tokens[0].mint)?.assets;
    if (single !== undefined) expect(solvency(dup, dc).find((r) => r.asset === tokens[0].mint)!.assets).toBe(single);
    expect(mjs.check({ ...file, snapshot: dup }, MOCK_OPERATOR_PUBKEY).ok).toBe(false);

    // E3: any asset id that is not ZEC or a base58 mint (v0.10: "SOL" too) fails the checks, never crashes.
    const solOdd = structuredClone(snap);
    solOdd.trees.push({ asset: "SOL", decimals: 9, granule: "1000000", root: "00".repeat(32), sum: "1" });
    expect(checkSnapshot(solOdd, MOCK_OPERATOR_PUBKEY).error).toMatch(/unknown asset id/);
    expect(mjs.check({ ...file, snapshot: solOdd }, MOCK_OPERATOR_PUBKEY).ok).toBe(false);
    const odd = structuredClone(snap);
    odd.trees.push({ asset: "USDC-0O", decimals: 6, granule: "1", root: "00".repeat(32), sum: "1" });
    expect(() => mjs.check({ ...file, snapshot: odd }, MOCK_OPERATOR_PUBKEY)).not.toThrow();
    expect(mjs.check({ ...file, snapshot: odd }, MOCK_OPERATOR_PUBKEY).ok).toBe(false);
    const oc = checkSnapshot(odd, MOCK_OPERATOR_PUBKEY);
    expect(oc.digestOk).toBe(false);
    expect(oc.error).toMatch(/unknown asset id/);
    expect(solvency(odd, oc).find((r) => r.asset === "USDC-0O")).toMatchObject({ kind: "unknown", covered: false });
  });
});
