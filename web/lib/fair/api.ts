"use client";

// Sealed-bid launch endpoints and ops (docs/API.md v0.6). This module is part of the on-demand chunk:
// its paths, codes and texts are not in the main bundle.

import { api, ApiError } from "@/lib/api/client";
import { registerErrorCodes } from "@/lib/api/errors";
import type { ActionReceipt, FairLaunch, FairLaunchStatus, SignedAction } from "@/lib/api/types";
import { getSigner } from "@/lib/crypto/session";
import type { Network } from "@/lib/network";

registerErrorCodes({
  launch_closed: "The bid window has closed. Nothing was held.",
  already_bid: "You already have a sealed bid here. Withdraw it first to change the amount.",
  bad_ciphertext: "The sealed bid was refused. Reload the page and seal it again.",
  launch_full: "This launch already has the maximum of 1,024 bids. Nothing was held.",
});

/** Same rhythm for every viewer of a launch page (3-5 s), never tied to one's own actions. */
export const LAUNCH_POLL_MS = 4_000;

export function getLaunches(q: { status?: FairLaunchStatus; limit?: number } = {}): Promise<FairLaunch[]> {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  if (q.limit) p.set("limit", String(q.limit));
  const s = p.toString();
  return api.request<FairLaunch[]>(`/api/launches${s ? `?${s}` : ""}`);
}

/** v0.25 (B4): a launch not published yet answers 200 { id, status: "scheduled" } and nothing else. */
export interface ScheduledLaunch {
  id: string;
  status: "scheduled";
}

export const isScheduled = (l: FairLaunch | ScheduledLaunch): l is ScheduledLaunch => l.status === "scheduled";

/** The public launch, its bare "scheduled" stub before publication, or null on 404 (unknown or cancelled). */
export async function getLaunch(id: string): Promise<FairLaunch | ScheduledLaunch | null> {
  try {
    return await api.request<FairLaunch | ScheduledLaunch>(`/api/launches/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof ApiError && e.code === "not_found") return null;
    throw e;
  }
}

type FairOp = Extract<SignedAction, { op: "fl_create" | "fl_bid" | "fl_cancel" | "fl_cancel_launch" }>;

/** Sign and send an fl_* op (padded like every action, so it is the same size class on the wire). */
export async function postFair(network: Network, action: FairOp): Promise<ActionReceipt> {
  const signer = getSigner(network);
  if (!signer) throw new ApiError("locked", "key locked");
  return api.postAction(signer, action);
}

export const isLaunchId = (s: string) => /^[0-9a-f]{32}$/.test(s);
