// Templates v1 (docs/analysis/scenarios.md §5). Constants in the bundle, identical for everyone: their only
// knobs are random-wait ranges and delayed / max, so everyone running a template leaves the same timing
// distribution on-chain (behavioural k-anonymity, §4.2). The server never learns a plan came from one.

import type { ScenarioBlock, Venue } from "@/lib/api/types";
import type { Draft, DraftStep } from "./draft";
import { newDraftId } from "./draft";

const H = 3600;

export type TemplateId = "private-buy-exit" | "launch-take-profit" | "dca-in" | "rotate";

export interface TemplateSeed {
  /** Token to trade (pool mint), when the builder was opened for one. */
  mint?: string;
  venue?: Venue;
  /** Its current price, SOL per whole token: the starting point of order prices. */
  priceSol?: string;
  /** A second token for Rotate. */
  mintB?: string;
  venueB?: Venue;
  priceSolB?: string;
  /** Pool minimum deposit, zat. */
  minDepositZat?: string;
}

export interface Template {
  id: TemplateId;
  name: string;
  line: string;
  ttlSecs: number;
  /** For the template card: the chain in words. */
  outline: string[];
  build(seed: TemplateSeed): { ttlSecs: number; blocks: { block: ScenarioBlock; onFail?: DraftStep["onFail"] }[] };
}

/** Decimal string with ~4 significant digits of price × factor (no e-notation). */
export function scalePrice(price: string | undefined, factor: number): string {
  const p = Number(price);
  if (!(p > 0)) return "";
  const v = p * factor;
  const digits = Math.min(20, Math.max(0, 3 - Math.floor(Math.log10(v))));
  return v.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export const TEMPLATES: readonly Template[] = [
  {
    id: "private-buy-exit",
    name: "Private buy & exit",
    line: "Top up, buy after a human-like pause, bracket it, leave in shielded ZEC.",
    ttlSecs: 72 * H,
    outline: ["Deposit arrives", "Random wait", "Safety check", "Buy", "Bracket", "Order result", "Random wait", "Withdraw ZEC"],
    build: (s) => ({
      ttlSecs: 72 * H,
      blocks: [
        { block: { type: "deposit_received", minZat: s.minDepositZat && BigInt(s.minDepositZat) > BigInt(10_000_000) ? s.minDepositZat : "10000000" } },
        { block: { type: "wait_random", minSecs: 20 * 60, maxSecs: 90 * 60 } },
        { block: { type: "check_safety", mint: s.mint ?? "", require: { authoritiesRevoked: true, noRiskyExtensions: true }, onFalse: "stop" } },
        { block: { type: "buy", venue: s.venue ?? "pumpfun", mint: s.mint ?? "", zec: { pct: 95, of: { step: 0 } }, guard: { slippageBps: 500 }, exec: "max" } },
        {
          block: {
            type: "order_place",
            order: { venue: "pumpfun", kind: "bracket", mint: s.mint ?? "", amount: { pct: 100, of: { step: 3 } }, tpPriceSol: scalePrice(s.priceSol, 2), slPriceSol: scalePrice(s.priceSol, 0.6), rearm: true, exec: "max", ttlSecs: 72 * H },
          },
        },
        { block: { type: "own_result", ref: { step: 4 }, on: "any" } },
        { block: { type: "wait_random", minSecs: H, maxSecs: 6 * H } },
        { block: { type: "withdraw_zec", to: "", amount: { pct: 100, of: "balance" }, exec: "max" } },
      ],
    }),
  },
  {
    id: "launch-take-profit",
    name: "Launch & take profit",
    line: "Launch, sit out the 24 h creator lock, take profit, claim fees, cash out shielded.",
    ttlSecs: 72 * H,
    outline: ["Launch token", "Random wait 24–26 h", "Take-profit", "Order result", "Claim fees", "Random wait", "Withdraw ZEC"],
    build: () => ({
      ttlSecs: 72 * H,
      blocks: [
        { block: { type: "create", create: { venue: "pumpfun", meta: { name: "", symbol: "" }, initialBuyZec: { abs: "10000000" }, exec: "delayed", quote: "SOL" } } },
        // The creator's launch buy is locked for 24 h: without this pause the take-profit gets creator_locked.
        { block: { type: "wait_random", minSecs: 24 * H + 5 * 60, maxSecs: 26 * H } },
        { block: { type: "order_place", order: { venue: "pumpfun", kind: "take_profit", mint: { step: 0 }, amount: { pct: 100, of: { step: 0 } }, triggerPriceSol: "0.0000001", exec: "delayed", ttlSecs: 44 * H } } },
        { block: { type: "own_result", ref: { step: 2 }, on: "filled" } },
        { block: { type: "claim", mint: { step: 0 } } },
        { block: { type: "wait_random", minSecs: H, maxSecs: 6 * H } },
        { block: { type: "withdraw_zec", to: "", amount: { pct: 100, of: "balance" }, exec: "max" } },
      ],
    }),
  },
  {
    id: "dca-in",
    name: "DCA in",
    line: "One tap, then a position built in random slices over hours.",
    ttlSecs: 72 * H,
    outline: ["Manual start", "DCA 4–8 slices, every 2–6 h", "End"],
    build: (s) => ({
      ttlSecs: 72 * H,
      blocks: [
        { block: { type: "manual_start" } },
        {
          block: { type: "dca", side: "buy", venue: s.venue ?? "pumpfun", mint: s.mint ?? "", total: { abs: "50000000" }, slices: 6, everySecs: { min: 2 * H, max: 6 * H }, guard: { slippageBps: 500 }, exec: "delayed" },
          onFail: { retry: 2, then: "skip" },
        },
        { block: { type: "end" } },
      ],
    }),
  },
  {
    id: "rotate",
    name: "Rotate",
    line: "Move a position from one token to another without a mirrored trade.",
    ttlSecs: 24 * H,
    outline: ["Manual start", "Rotate A → B", "Stop-loss on B"],
    build: (s) => ({
      ttlSecs: 24 * H,
      blocks: [
        { block: { type: "manual_start" } },
        { block: { type: "swap", from: s.mint ?? "", to: s.mintB ?? "", amount: { pct: 100, of: "balance" }, guardSell: { slippageBps: 500 }, guardBuy: { slippageBps: 500 }, exec: "delayed" } },
        { block: { type: "order_place", order: { venue: "pumpfun", kind: "stop_loss", mint: { step: 1 }, amount: { pct: 100, of: { step: 1 } }, triggerPriceSol: scalePrice(s.priceSolB, 0.8), exec: "delayed", ttlSecs: 24 * H } } },
      ],
    }),
  },
];

export const templateById = (id: string | undefined) => TEMPLATES.find((t) => t.id === id);

/** A fresh draft from a template: uids = positions, so the template's { step } references hold as written. */
export function draftFromTemplate(t: Template, seed: TemplateSeed, now = Date.now()): Draft {
  const { ttlSecs, blocks } = t.build(seed);
  return {
    id: newDraftId(),
    name: t.name,
    template: t.id,
    ttlSecs,
    steps: blocks.map((b, i) => ({ uid: i, block: b.block, ...(b.onFail ? { onFail: b.onFail } : {}) })),
    nextUid: blocks.length,
    updatedAt: now,
  };
}
