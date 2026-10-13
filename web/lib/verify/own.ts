// "Check my balance": one signed GET, then everything is recomputed here. The proof lives only in
// the caller's memory (React state). It is never written to localStorage, sessionStorage, IndexedDB
// or a cookie: it reveals the balance. The only way to keep it is "Download proof".

import type { Portfolio, VerifyProof, VerifySnapshot } from "@/lib/api/types";
import type { Signer } from "@/lib/crypto/sign";
import { getOwnProof } from "./api";
import { checkProof, proofFile, type ProofCheck } from "./merkle-sum";

export interface OwnCheck {
  snapshotId: number;
  pubkey: string;
  proof: VerifyProof;
  result: ProofCheck;
}

/** null when the server keeps no proof for this snapshot any more (48 h) or never did. */
export async function checkOwnBalance(signer: Signer, snapshot: VerifySnapshot): Promise<OwnCheck | null> {
  // Always pinned to the snapshot on screen: a new root published in between cannot mix them up.
  const proof = await getOwnProof(signer, snapshot.id);
  if (!proof) return null;
  const { pad, ...rest } = proof;
  void pad;
  return { snapshotId: snapshot.id, pubkey: signer.pubkey, proof: rest, result: checkProof(snapshot, rest, signer.pubkey) };
}

/** Serialize the proof for "Download proof (JSON)". */
export function proofJson(snapshot: VerifySnapshot, own: OwnCheck): string {
  return JSON.stringify(proofFile(snapshot, own.proof, own.pubkey), null, 2);
}

/** Hand a JSON file to the user's disk. Nothing is kept: the object URL is revoked right after. */
export function downloadJson(name: string, json: string) {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ---- committed vs. your balance now (review E11) ----

export type CompareStatus =
  /** committed ≥ the balance the portfolio shows now. */
  | "covered"
  /** committed < balance, and nothing happened on this key since the snapshot: the pool under-committed. */
  | "short"
  /** You hold it now, it is not in the proof, and nothing happened since: omitted from the trees. */
  | "missing"
  /** Differs, but the key moved since the snapshot (trade, deposit, order): can't compare exactly. */
  | "changed"
  /** Not in the proof because it was truncated to 12 assets: check again for another sample. */
  | "truncated";

export interface CompareRow {
  asset: string;
  decimals: number;
  committed: bigint | null;
  now: bigint;
  status: CompareStatus;
}

type PortfolioLike = Pick<Portfolio, "zecBalance" | "zecHeld" | "holdings" | "claimable" | "deposits"> & Partial<Pick<Portfolio, "actions" | "orders">>;

/** Anything on this key after the snapshot that could explain a difference. */
export function changedSince(p: PortfolioLike, takenAt: number): boolean {
  const day = Math.floor(takenAt / 86_400_000) * 86_400_000; // deposit times are rounded down to the day
  return (
    (p.actions ?? []).some((a) => a.status === "queued" || a.status === "sent" || (a.executedAt ?? 0) >= Math.floor(takenAt / 60_000) * 60_000 || (a.status === "executed" && a.executedAt === undefined)) ||
    p.deposits.some((d) => d.ts >= day) ||
    (p.orders ?? []).some((o) => o.createdAt >= Math.floor(takenAt / 60_000) * 60_000 || o.status === "triggered")
  );
}

/**
 * Compare what the pool committed to this key (proof) with what the portfolio shows now. Liabilities
 * are `available + held` per asset, so the same is used here. Only computed in this browser.
 */
export function compareWithPortfolio(own: Pick<OwnCheck, "result" | "proof">, snap: Pick<VerifySnapshot, "takenAt" | "trees" | "rateLamportsPerZecBuy">, p: PortfolioLike): { rows: CompareRow[]; changed: boolean } {
  const changed = changedSince(p, snap.takenAt);
  const now = new Map<string, bigint>();
  const add = (k: string, v: bigint) => v > BigInt(0) && now.set(k, (now.get(k) ?? BigInt(0)) + v);
  const u = (v: string) => (/^\d+$/.test(v) ? BigInt(v) : BigInt(0));
  add("ZEC", u(p.zecBalance) + u(p.zecHeld) + claimableZat(p.claimable, snap.rateLamportsPerZecBuy));
  for (const h of p.holdings) add(h.mint, u(h.amount) + u(h.held));

  const rows: CompareRow[] = [];
  const decimalsOf = (a: string) => snap.trees.find((t) => t.asset === a)?.decimals ?? (a === "ZEC" ? 8 : 6);
  for (const a of own.result.assets) {
    const n = now.get(a.asset) ?? BigInt(0);
    rows.push({ asset: a.asset, decimals: a.decimals, committed: a.committed, now: n, status: a.committed >= n ? "covered" : changed ? "changed" : "short" });
  }
  for (const [asset, n] of now) {
    if (own.result.assets.some((a) => a.asset === asset)) continue;
    rows.push({ asset, decimals: decimalsOf(asset), committed: null, now: n, status: own.proof.truncated ? "truncated" : changed ? "changed" : "missing" });
  }
  return { rows, changed };
}

/**
 * v0.10: creator fees owed sit in the creator's ZEC leaf: ceil(Σ claimable lamports × 1e8 / rateLamportsPerZecBuy).
 * No rate in the snapshot = nothing to add (the server skips a snapshot with claimable but no rate).
 */
export function claimableZat(claimable: Pick<Portfolio["claimable"][number], "solAmount">[], rateLamportsPerZecBuy?: string): bigint {
  const rate = rateLamportsPerZecBuy && /^\d+$/.test(rateLamportsPerZecBuy) ? BigInt(rateLamportsPerZecBuy) : BigInt(0);
  if (rate === BigInt(0)) return BigInt(0);
  const lamports = claimable.reduce((s, c) => s + (/^\d+$/.test(c.solAmount) ? BigInt(c.solAmount) : BigInt(0)), BigInt(0));
  if (lamports === BigInt(0)) return BigInt(0);
  return (lamports * BigInt(100_000_000) + rate - BigInt(1)) / rate;
}
