import { PUMP_PROGRAM_ID, bondingCurvePda } from "@pump-fun/pump-sdk";
import type { Connection, PublicKey } from "@solana/web3.js";
import { extractCreateEvents, extractTradeEvents } from "../events";
import { getTransactionAnyVersion } from "../tx";
import { pct } from "./metrics";
import type { TokenSafety } from "./types";

/**
 * Expensive tier behind INTEL_FULL=1 (OFF by default; designed, not enabled).
 * token-intel.md §1 "Снайперы", "Бандлы", "История дева"; rpc-providers P1/P2.
 *
 * - First blocks: the curve's oldest signatures -> create slot, CreateEvent.user;
 *   TradeEvents in [createSlot, createSlot + N] -> same-slot buyers (bundle-like)
 *   and snipers (+1..+N). Computed once per mint (immutable after N slots),
 *   cost: up to `maxPages` getSignaturesForAddress + up to `maxTx` getTransaction.
 *   Unzeen launches: our atomic create+buy / fair-launch is flagged
 *   `unzeenLaunchBuy` and pool vaults are never counted (T8).
 * - Dev history: only "launches seen by our own CreateEvent index" (DAS
 *   getAssetsByCreator is empty for pump.fun, T7); needs a program-wide stream
 *   that the 12.10 decision does not buy. Interface only: `LaunchIndex`.
 *   Never for Unzeen launches (T1).
 * Read provider only (Shyft), like the cheap tier.
 */

export function intelFullEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INTEL_FULL?.trim() === "1";
}

export interface FirstBlockTrade {
  slot: number;
  user: string;
  isBuy: boolean;
  tokenAmount: bigint;
}

export function classifyFirstBlocks(p: {
  createSlot: number;
  devs: ReadonlySet<string>;
  poolVaults: ReadonlySet<string>;
  trades: readonly FirstBlockTrade[];
  supply: bigint;
  windowSlots: number;
  unzeenLaunch: boolean;
}): NonNullable<TokenSafety["firstBlocks"]> {
  const same = new Map<string, bigint>();
  const snipe = new Map<string, bigint>();
  let unzeenLaunchBuy = false;
  for (const t of p.trades) {
    if (!t.isBuy) continue;
    if (p.poolVaults.has(t.user)) {
      if (p.unzeenLaunch && t.slot === p.createSlot) unzeenLaunchBuy = true;
      continue;
    }
    if (p.devs.has(t.user)) continue;
    if (t.slot === p.createSlot) same.set(t.user, (same.get(t.user) ?? 0n) + t.tokenAmount);
    else if (t.slot > p.createSlot && t.slot <= p.createSlot + p.windowSlots) snipe.set(t.user, (snipe.get(t.user) ?? 0n) + t.tokenAmount);
  }
  const sum = (m: Map<string, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n);
  return {
    snipers: snipe.size,
    sniperPct: pct(sum(snipe), p.supply),
    sameSlotBuyers: same.size,
    sameSlotPct: pct(sum(same), p.supply),
    unzeenLaunchBuy,
  };
}

/** Own index of CreateEvents (program-wide stream): not built (decision 12.10). */
export interface LaunchIndex {
  launchesBy(dev: string): Promise<{ launches: number; rugs: number; since: number } | null>;
}

export interface FullIntel {
  firstBlocks(
    mint: PublicKey,
    ctx: { supply: bigint; poolVaults: ReadonlySet<string>; unzeenLaunch: boolean },
  ): Promise<{ firstBlocks: NonNullable<TokenSafety["firstBlocks"]>; createUser: string | null } | null>;
  devHistory(dev: string): Promise<TokenSafety["dev"] | null>;
}

export class RpcFullIntel implements FullIntel {
  constructor(
    private readonly read: Pick<Connection, "getSignaturesForAddress" | "getTransaction">,
    private readonly launches: LaunchIndex | null = null,
    private readonly windowSlots = 4,
    private readonly maxPages = 3,
    private readonly maxTx = 12,
  ) {}

  async firstBlocks(
    mint: PublicKey,
    ctx: { supply: bigint; poolVaults: ReadonlySet<string>; unzeenLaunch: boolean },
  ): Promise<{ firstBlocks: NonNullable<TokenSafety["firstBlocks"]>; createUser: string | null } | null> {
    const curve = bondingCurvePda(mint);
    let before: string | undefined;
    let oldest: { signature: string; slot: number }[] = [];
    for (let page = 0; page < this.maxPages; page++) {
      const sigs = await this.read.getSignaturesForAddress(curve, { limit: 1000, ...(before ? { before } : {}) });
      if (sigs.length === 0) break;
      oldest = sigs.map((s) => ({ signature: s.signature, slot: s.slot }));
      before = sigs[sigs.length - 1]!.signature;
      if (sigs.length < 1000) break;
      if (page === this.maxPages - 1) return null; // history too long for the budget: no claim
    }
    if (oldest.length === 0) return null;
    const createSlot = Math.min(...oldest.map((s) => s.slot));
    const window = oldest.filter((s) => s.slot <= createSlot + this.windowSlots).slice(-this.maxTx);
    const trades: FirstBlockTrade[] = [];
    let createUser: string | null = null;
    for (const s of window) {
      const tx = await getTransactionAnyVersion(this.read, s.signature).catch(() => null); // v1 included
      if (!tx || tx.meta?.err) continue;
      for (const c of extractCreateEvents(tx, PUMP_PROGRAM_ID)) if (c.mint.equals(mint)) createUser = c.user.toBase58();
      for (const t of extractTradeEvents(tx, PUMP_PROGRAM_ID)) {
        if (!t.mint.equals(mint)) continue;
        trades.push({ slot: tx.slot, user: t.user.toBase58(), isBuy: t.isBuy, tokenAmount: BigInt(t.tokenAmount.toString(10)) });
      }
    }
    const devs = new Set(createUser && !ctx.unzeenLaunch ? [createUser] : []);
    return {
      firstBlocks: classifyFirstBlocks({ createSlot, devs, poolVaults: ctx.poolVaults, trades, supply: ctx.supply, windowSlots: this.windowSlots, unzeenLaunch: ctx.unzeenLaunch }),
      createUser: ctx.unzeenLaunch ? null : createUser,
    };
  }

  async devHistory(dev: string): Promise<TokenSafety["dev"] | null> {
    if (!this.launches) return null;
    const h = await this.launches.launchesBy(dev);
    return h ? { address: dev, launchesSeen: h.launches, rugsSeen: h.rugs, since: h.since } : null;
  }
}

