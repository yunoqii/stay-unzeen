"use client";

// Actions this tab submitted, tracked until they settle (statuses from the portfolio poll, see below).
// Memory only: never written to storage, gone on reload. Withdrawal destinations are not kept at all,
// so nothing here can tie a Solana address to the anon key. Also remembers the last rate the pool
// fixed for us: the API has no public rate endpoint, so quotes use the most recent one we saw.

import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api, ApiError, errorText } from "@/lib/api/client";
import type { ActionReceipt, ActionState, ActionStatus, ExecMode, RateUsed, SignedAction, SolRateUsed } from "@/lib/api/types";
import { getSigner } from "@/lib/crypto/session";
import type { Network } from "@/lib/network";
import { recordSubmitted } from "@/lib/history/store";

export type TrackedOp = "buy" | "sell" | "create" | "withdraw_zec" | "withdraw_token" | "claim";

export interface TrackedAction {
  id: string;
  network: Network;
  pubkey: string;
  op: TrackedOp;
  mint?: string;
  symbol?: string;
  decimals?: number;
  /** What was signed: zatoshis for buy / withdraw_zec, token base units for sell / withdraw_token. */
  amount: string;
  parts?: number;
  /** Execution mode the action was signed with (drives "Sending…" vs "Queued for next batch"). */
  exec?: ExecMode;
  submittedAt: number;
  status: ActionStatus;
  /** Polling gave up (long payout delays); the portfolio still reflects the outcome. */
  stale?: boolean;
}

const items = new Map<string, TrackedAction>();
const rates: Record<Network, { buy?: SolRateUsed; sell?: SolRateUsed }> = { devnet: {}, mainnet: {}, hood: {} };
let version = 0;
let snapshot: TrackedAction[] = [];
const listeners = new Set<() => void>();

function emit() {
  version++;
  snapshot = [...items.values()].sort((a, b) => b.submittedAt - a.submittedAt);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function rememberRate(network: Network, op: TrackedOp, rate?: RateUsed) {
  // v0.13: ZEC-pair actions run at 1:1 parity and carry no ZEC/SOL rate: nothing to remember.
  if (!rate || !rate.lamportsPerZec) return;
  const side = op === "sell" ? "sell" : "buy";
  const prev = rates[network][side];
  if (!prev || rate.ts >= prev.ts) rates[network][side] = rate as SolRateUsed;
}

/** Most recent rate the pool fixed for this network and side (or the other side as a fallback). */
export function lastRate(network: Network, side: "buy" | "sell"): SolRateUsed | null {
  return rates[network][side] ?? rates[network][side === "buy" ? "sell" : "buy"] ?? null;
}

/** After this a still-queued action is marked stale (long payout delays); the balance still settles it. */
const GIVE_UP_MS = 20 * 60_000;

/**
 * Statuses come only from the regular, fixed-interval portfolio poll (Portfolio.actions), never from
 * polling GET /api/actions/:id: a per-action poll stops the moment the action settles and so tells
 * anyone watching the network when the trade or withdrawal happened (analysis now-mode N-2).
 */
export function applyActionStatuses(
  network: Network,
  pubkey: string,
  list: ({ id: string } & ActionStatus)[] | undefined,
  now: number = Date.now(),
) {
  let changed = false;
  const byId = new Map((list ?? []).map((x) => [x.id, x]));
  for (const cur of items.values()) {
    if (cur.network !== network || cur.pubkey !== pubkey) continue;
    if (cur.status.status === "executed" || cur.status.status === "failed") continue;
    const hit = byId.get(cur.id);
    if (hit) {
      const { id: _id, ...status } = hit;
      void _id;
      if (!status.rate && cur.status.rate) status.rate = cur.status.rate;
      // v0.17: parts come from the one read after signing (never in Portfolio.actions): keep them.
      if (!status.parts && cur.status.parts) status.parts = cur.status.parts;
      if (JSON.stringify(status) !== JSON.stringify(cur.status)) {
        rememberRate(network, cur.op, status.rate);
        const next = { ...cur, status, stale: false };
        items.set(cur.id, next);
        changed = true;
        if (status.status === "executed" || status.status === "failed") announce(next);
      }
    } else if (!cur.stale && now - cur.submittedAt > GIVE_UP_MS) {
      items.set(cur.id, { ...cur, stale: true });
      changed = true;
    }
  }
  if (changed) emit();
}

const acceptedListeners = new Set<() => void>();
/** Something moved balances right now (an order placed or cancelled): refetch the portfolio off-rhythm. */
export function notifyAccepted() {
  acceptedListeners.forEach((l) => l());
}
/** Fires when the pool accepted an action: balances moved at a moment the POST already revealed. */
export function onActionAccepted(l: () => void): () => void {
  acceptedListeners.add(l);
  return () => void acceptedListeners.delete(l);
}

function announce(a: TrackedAction) {
  const what = describe(a);
  if (a.status.status === "executed") toast.success(`${what}: done`, { description: settledText(a) });
  else toast.error(`${what}: failed`, { description: errorText(new ApiError(a.status.error ?? "internal", "")) });
}

export function describe(a: Pick<TrackedAction, "op" | "symbol">): string {
  const sym = a.symbol ? `$${a.symbol}` : "token";
  switch (a.op) {
    case "buy":
      return `Buy ${sym}`;
    case "sell":
      return `Sell ${sym}`;
    case "create":
      return `Launch ${sym}`;
    case "withdraw_zec":
      return "ZEC withdrawal";
    case "withdraw_token":
      return `${sym} withdrawal`;
    case "claim":
      return a.symbol ? `Claim ${sym} fees` : "Claim creator fees";
  }
}

function settledText(a: TrackedAction): string | undefined {
  if (a.op === "withdraw_token") return "Tokens sent to your fresh address.";
  if (a.op === "withdraw_zec") return "Shielded payout sent.";
  if (a.op === "claim") return "Credited to your ZEC balance.";
  return "Unzeen made the trade. The chain only sees “unzeen”.";
}

/** Sign and send an action from the balance, then follow it. Throws ApiError (mapped by errorText). */
export async function submitAction(
  network: Network,
  action: SignedAction,
  meta: { op: TrackedOp; mint?: string; symbol?: string; decimals?: number; amount: string; parts?: number },
): Promise<TrackedAction> {
  const signer = getSigner(network);
  if (!signer) throw new ApiError("locked", "key locked");
  const receipt: ActionReceipt = await api.postAction(signer, action);
  rememberRate(network, meta.op, receipt.rate);
  const existing = items.get(receipt.id);
  if (existing) return existing; // idempotent retry
  const it: TrackedAction = {
    id: receipt.id,
    network,
    pubkey: signer.pubkey,
    ...meta,
    exec: "exec" in action ? action.exec : undefined,
    submittedAt: Date.now(),
    // Order receipts ("open" / "cancelled") never come through here (lib/orders.ts).
    status: { status: receipt.status as ActionState, rate: receipt.rate },
  };
  items.set(it.id, it);
  emit();
  if (meta.op === "withdraw_token") void readPartsOnce(signer, it.id);
  if (meta.op !== "withdraw_zec" && meta.op !== "claim") {
    // Encrypted local history for PnL (T4): the id, kind and mint only; the fill arrives with the poll.
    void recordSubmitted(network, signer.pubkey, { id: it.id, kind: meta.op, mint: meta.mint, symbol: meta.symbol, decimals: meta.decimals, submittedAt: it.submittedAt });
  }
  acceptedListeners.forEach((l) => l());
  return it;
}

/**
 * v0.17: the real parts of a token withdrawal (sizes after the server's rounding, start times) for the M4
 * view. Read ONCE, right after the POST that already revealed this moment, and never again: a per-action
 * poll would end when the action settles and so leak its timing (N-2). Progress after that is the clock
 * (notBefore) plus the action's own status from the regular portfolio poll. A failure just leaves no parts.
 */
async function readPartsOnce(signer: NonNullable<ReturnType<typeof getSigner>>, id: string) {
  try {
    const st = await api.getAction(signer, id);
    const parts = Array.isArray(st.parts) ? st.parts.filter((p) => p && /^\d+$/.test(p.amount) && Number.isFinite(p.notBefore)) : [];
    const cur = items.get(id);
    if (!cur || parts.length === 0) return;
    items.set(id, { ...cur, status: { ...cur.status, parts } });
    emit();
  } catch {
    /* no parts: the view falls back to the illustration */
  }
}

export function useActions(network: Network, pubkey: string | null): TrackedAction[] {
  const all = useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
  return pubkey ? all.filter((a) => a.network === network && a.pubkey === pubkey) : EMPTY;
}
const EMPTY: TrackedAction[] = [];

export function useAction(id: string | null): TrackedAction | null {
  const all = useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
  return id ? (all.find((a) => a.id === id) ?? null) : null;
}

/** Changes whenever any action settles: lets balance views refetch at the right moment. */
export function useActivityVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

/** Token amounts received by executed buys of `mint` in this tab (for the "same amount" warning). */
export function recentBuyAmounts(network: Network, pubkey: string, mint: string): bigint[] {
  const out: bigint[] = [];
  for (const a of items.values()) {
    if (a.network !== network || a.pubkey !== pubkey || a.mint !== mint) continue;
    if ((a.op === "buy" || a.op === "create") && a.status.status === "executed" && a.status.fill) out.push(BigInt(a.status.fill.tokenAmount));
  }
  return out;
}
