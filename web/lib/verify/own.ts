// "Check my balance": one signed GET, then everything is recomputed here. The proof lives only in
// the caller's memory (React state). It is never written to localStorage, sessionStorage, IndexedDB
// or a cookie: it reveals the balance. The only way to keep it is "Download proof".

import type { VerifyProof, VerifySnapshot } from "@/lib/api/types";
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
