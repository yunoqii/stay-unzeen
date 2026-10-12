// Verify endpoints (docs/API.md v0.7). Loaded with the /verify page only.

import { api, ApiError } from "@/lib/api/client";
import type { VerifyProof, VerifySnapshot, VerifySnapshotSummary } from "@/lib/api/types";
import type { Signer } from "@/lib/crypto/sign";

/** Latest snapshot, or null when none was taken yet (404). */
export async function getLatestSnapshot(): Promise<VerifySnapshot | null> {
  try {
    return await api.request<VerifySnapshot>("/api/verify");
  } catch (e) {
    if (e instanceof ApiError && e.code === "not_found") return null;
    throw e;
  }
}

export async function getSnapshot(id: number): Promise<VerifySnapshot | null> {
  try {
    return await api.request<VerifySnapshot>(`/api/verify/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.code === "not_found") return null;
    throw e;
  }
}

export const HISTORY_PAGE = 30;

/** Root history, newest first. */
export function getSnapshotHistory(before?: number): Promise<VerifySnapshotSummary[]> {
  return api.request<VerifySnapshotSummary[]>(`/api/verify/snapshots?${before ? `before=${before}&` : ""}limit=${HISTORY_PAGE}`);
}

/**
 * The key's own proof (signed GET, pubkey only in the header). Only the latest or the previous
 * snapshot (48 h retention) -> otherwise 404, mapped to null. Called on a click, never polled.
 */
export async function getOwnProof(signer: Signer, snapshotId?: number): Promise<VerifyProof | null> {
  try {
    return await api.request<VerifyProof>(`/api/verify/proof${snapshotId ? `?snapshot=${snapshotId}` : ""}`, signer);
  } catch (e) {
    if (e instanceof ApiError && e.code === "not_found") return null;
    throw e;
  }
}
