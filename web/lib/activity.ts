"use client";

// Actions this tab submitted, tracked until they settle (GET /api/actions/:id).
// Memory only: never written to storage, gone on reload. Withdrawal destinations are not kept at all,
// so nothing here can tie a Solana address to the anon key. Also remembers the last rate the pool
// fixed for us: the API has no public rate endpoint, so quotes use the most recent one we saw.

import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api, ApiError, errorText } from "@/lib/api/client";
import type { ActionReceipt, ActionStatus, RateUsed, SignedAction } from "@/lib/api/types";
import { getSigner } from "@/lib/crypto/session";
import type { Network } from "@/lib/network";

export type TrackedOp = "buy" | "sell" | "create" | "withdraw_zec" | "withdraw_token";

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
  submittedAt: number;
  status: ActionStatus;
  /** Polling gave up (long payout delays); the portfolio still reflects the outcome. */
  stale?: boolean;
}

const items = new Map<string, TrackedAction>();
const rates: Record<Network, { buy?: RateUsed; sell?: RateUsed }> = { devnet: {}, mainnet: {} };
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
  if (!rate) return;
  const side = op === "sell" ? "sell" : "buy";
  const prev = rates[network][side];
  if (!prev || rate.ts >= prev.ts) rates[network][side] = rate;
}

/** Most recent rate the pool fixed for this network and side (or the other side as a fallback). */
export function lastRate(network: Network, side: "buy" | "sell"): RateUsed | null {
  return rates[network][side] ?? rates[network][side === "buy" ? "sell" : "buy"] ?? null;
}

const POLL_FAST = 2_000;
const POLL_SLOW = 6_000;
const GIVE_UP_MS = 20 * 60_000;

function poll(id: string) {
  const it = items.get(id);
  if (!it || it.status.status !== "queued") return;
  const age = Date.now() - it.submittedAt;
  if (age > GIVE_UP_MS) {
    items.set(id, { ...it, stale: true });
    emit();
    return;
  }
  const next = () => setTimeout(() => poll(id), age < 60_000 ? POLL_FAST : POLL_SLOW);
  const signer = getSigner(it.network);
  if (!signer) return void next(); // locked: wait, keep the entry
  api
    .getAction(signer, id)
    .then((status) => {
      const cur = items.get(id);
      if (!cur) return;
      rememberRate(cur.network, cur.op, status.rate);
      if (JSON.stringify(status) !== JSON.stringify(cur.status)) {
        items.set(id, { ...cur, status });
        emit();
        if (status.status !== "queued") announce({ ...cur, status });
      }
      if (status.status === "queued") next();
    })
    .catch((e: unknown) => {
      if (e instanceof ApiError && e.code === "not_found") {
        items.delete(id);
        emit();
        return;
      }
      next();
    });
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
  }
}

function settledText(a: TrackedAction): string | undefined {
  if (a.op === "withdraw_token") return "Tokens sent to your fresh address.";
  if (a.op === "withdraw_zec") return "Shielded payout sent.";
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
    submittedAt: Date.now(),
    status: { status: receipt.status, rate: receipt.rate },
  };
  items.set(it.id, it);
  emit();
  if (receipt.status === "queued") setTimeout(() => poll(it.id), POLL_FAST);
  return it;
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
