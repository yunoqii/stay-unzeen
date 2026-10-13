"use client";

// Your private orders as this tab has seen them (Portfolio.orders, from the regular fixed-interval
// portfolio poll: orders add no request of their own). Memory only: never written to storage, gone on
// reload. Orders that triggered, expired, failed or were cancelled stay listed for the session even
// after the server erases them (24 h after closing, D1).
//
// Placing / cancelling an order is a signed POST /api/actions like any other action (padded body).

import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api, ApiError, errorText } from "@/lib/api/client";
import type { ActionReceipt, Order, SignedAction } from "@/lib/api/types";
import { notifyAccepted } from "@/lib/activity";
import { getSigner } from "@/lib/crypto/session";
import type { HistoryEntry } from "@/lib/history/crypto";
import type { Network } from "@/lib/network";
import { firedAs, isLive, isSellKind, ORDER_LABEL } from "./orders";

export interface SessionOrder {
  order: Order;
  network: Network;
  pubkey: string;
  /** Still in the last Portfolio.orders we got. */
  listed: boolean;
}

const seen = new Map<string, SessionOrder>();
/** Symbols learned from the pages that placed or showed an order (labels for toasts only). */
const symbols = new Map<string, string>();
let snapshot: SessionOrder[] = [];
const listeners = new Set<() => void>();

function emit() {
  snapshot = [...seen.values()].sort((a, b) => Number(isLive(b.order)) - Number(isLive(a.order)) || b.order.createdAt - a.order.createdAt);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function rememberSymbol(mint: string, symbol: string) {
  symbols.set(mint, symbol);
}

const label = (o: Order) => `${ORDER_LABEL[o.kind]} ${symbols.has(o.mint) ? "$" + symbols.get(o.mint) : "order"}`;

function announce(prev: Order, next: Order) {
  // v0.15: a trade that failed on slippage sent the order back to open (rearm).
  if (next.status === "open" && (next.rearms ?? 0) > (prev.rearms ?? 0)) {
    toast(`${label(next)}: retrying`, { description: `The trade missed your slippage limit. The order is open again with the same hold (retry ${next.rearms}).` });
    return;
  }
  if (prev.status === next.status) {
    if (!prev.armed && next.armed) toast(`${label(next)}: armed`, { description: "The price is at your trigger. One more check in a row and it sells." });
    return;
  }
  switch (next.status) {
    case "triggered":
      toast(`${label(next)}: triggered`, {
        description: `${next.kind === "bracket" ? (next.leg === "sl" ? "Stop-loss leg: selling" : "Take-profit leg: selling") : isSellKind(next.kind) ? "Selling" : "Buying"} in the next batch.${next.kind === "bracket" ? " The other leg is cancelled." : ""} On-chain it reads “unzeen”.`,
      });
      break;
    case "filled":
      toast.success(`${label(next)}: filled`, { description: "Unzeen made the trade from your private balance." });
      break;
    case "expired":
      toast(`${label(next)}: expired`, { description: "Nothing traded. The hold is back on your balance." });
      break;
    case "failed":
      toast.error(`${label(next)}: failed`, { description: errorText(new ApiError(next.error ?? "internal", "")) + " The hold is back on your balance." });
      break;
  }
}

/**
 * Fold one poll into the session. Returns the trades your orders turned into (Order.actionId) as
 * local history entries, so their fills feed PnL and the chart markers like manual trades do.
 */
export function applyPolledOrders(network: Network, pubkey: string, list: Order[] | undefined, now: number = Date.now()): Omit<HistoryEntry, "status" | "fill">[] {
  let changed = false;
  const ids = new Set<string>();
  const fromOrders: Omit<HistoryEntry, "status" | "fill">[] = [];
  for (const o of list ?? []) {
    ids.add(o.id);
    const key = `${network}:${pubkey}:${o.id}`;
    const prev = seen.get(key);
    if (!prev || JSON.stringify(prev.order) !== JSON.stringify(o) || !prev.listed) {
      if (prev) announce(prev.order, o);
      seen.set(key, { order: o, network, pubkey, listed: true });
      changed = true;
    }
    if (o.actionId && (o.status === "triggered" || o.status === "filled")) {
      fromOrders.push({ id: o.actionId, kind: isSellKind(o.kind) ? "sell" : "buy", mint: o.mint, symbol: symbols.get(o.mint), via: firedAs(o), submittedAt: now });
    }
  }
  for (const [key, s] of seen) {
    if (s.network !== network || s.pubkey !== pubkey || !s.listed || ids.has(s.order.id)) continue;
    // Gone from the server's list (erased 24 h after closing): keep the last state for this session.
    seen.set(key, { ...s, listed: false });
    changed = true;
  }
  if (changed) emit();
  return fromOrders;
}

export function useSessionOrders(network: Network, pubkey: string | null): SessionOrder[] {
  const all = useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
  return pubkey ? all.filter((s) => s.network === network && s.pubkey === pubkey) : EMPTY;
}
const EMPTY: SessionOrder[] = [];

// ---- signed ops ----

type CreateBody = Extract<SignedAction, { op: "order_create" }>;

async function post(network: Network, action: SignedAction): Promise<ActionReceipt> {
  const signer = getSigner(network);
  if (!signer) throw new ApiError("locked", "key locked");
  const r = await api.postAction(signer, action);
  // Balances moved (hold taken / released) at a moment the POST already revealed: refetch now.
  notifyAccepted();
  return r;
}

export async function placeOrder(network: Network, body: Omit<CreateBody, "op">, symbol?: string): Promise<ActionReceipt> {
  if (symbol) rememberSymbol(body.mint, symbol);
  return post(network, { op: "order_create", ...body });
}

export async function cancelOrder(network: Network, orderId: string): Promise<ActionReceipt> {
  return post(network, { op: "order_cancel", orderId });
}

/** TEST helper: forget the session. */
export function resetOrderSession() {
  seen.clear();
  symbols.clear();
  emit();
}
