// Block catalogue of the scenario builder (docs/analysis/scenarios.md §1): categories, labels, one-line
// hints and the defaults a freshly dropped block starts with. Pure data, no React.

import type { ScenarioBlock, ScenarioBlockType, ScenarioFloors, ScenarioParams, Venue } from "@/lib/api/types";

export type CategoryId = "triggers" | "waits" | "trade" | "orders" | "launch" | "withdraw" | "logic" | "social";

export interface Category {
  id: CategoryId;
  label: string;
  hint: string;
  blocks: ScenarioBlockType[];
}

export const CATEGORIES: readonly Category[] = [
  { id: "triggers", label: "Triggers", hint: "Hold the chain until something happens", blocks: ["manual_start", "deposit_received", "price_cross", "time_at", "own_result", "curve_progress"] },
  { id: "waits", label: "Waits", hint: "Pause between steps", blocks: ["wait_random", "wait_fixed"] },
  { id: "trade", label: "Trade", hint: "Buy and sell from your balance", blocks: ["buy", "sell", "sell_all", "swap", "dca"] },
  { id: "orders", label: "Orders", hint: "Private limit, take-profit and stop-loss", blocks: ["order_place", "order_cancel"] },
  { id: "launch", label: "Launch", hint: "Launch a token, claim its fees", blocks: ["create", "claim"] },
  { id: "withdraw", label: "Withdraw", hint: "Leave the pool", blocks: ["withdraw_zec", "withdraw_token"] },
  { id: "logic", label: "Logic", hint: "Checks, loops and the end", blocks: ["check_safety", "repeat", "end"] },
  { id: "social", label: "Social", hint: "Say something in a token chat", blocks: ["chat"] },
];

export interface BlockMeta {
  label: string;
  hint: string;
  category: CategoryId;
}

export const BLOCKS: Record<ScenarioBlockType, BlockMeta> = {
  manual_start: { label: "Manual start", hint: "Waits for your tap. Only as the first block", category: "triggers" },
  time_at: { label: "At a time", hint: "Waits for a date and time", category: "triggers" },
  price_cross: { label: "Price crosses", hint: "Waits for a pool token's price", category: "triggers" },
  deposit_received: { label: "Deposit arrives", hint: "Waits for a shielded top-up", category: "triggers" },
  own_result: { label: "Order result", hint: "Waits for your order to fill or close", category: "triggers" },
  curve_progress: { label: "Curve progress", hint: "Waits for a bonding curve to fill", category: "triggers" },
  wait_random: { label: "Random wait", hint: "A random pause in a range. Recommended", category: "waits" },
  wait_fixed: { label: "Fixed wait", hint: "About this long, never exactly", category: "waits" },
  buy: { label: "Buy", hint: "Spend ZEC on a token", category: "trade" },
  sell: { label: "Sell", hint: "Sell part of a position", category: "trade" },
  sell_all: { label: "Sell all", hint: "Close a position", category: "trade" },
  swap: { label: "Rotate", hint: "Sell one token, buy another", category: "trade" },
  dca: { label: "DCA / TWAP", hint: "Split a trade into random slices", category: "trade" },
  order_place: { label: "Place order", hint: "Limit, take-profit, stop-loss or bracket", category: "orders" },
  order_cancel: { label: "Cancel order", hint: "Cancel an order of this plan", category: "orders" },
  create: { label: "Launch token", hint: "Create a token with a first buy", category: "launch" },
  claim: { label: "Claim fees", hint: "Creator fees into your ZEC balance", category: "launch" },
  withdraw_zec: { label: "Withdraw ZEC", hint: "Shielded payout to your wallet", category: "withdraw" },
  withdraw_token: { label: "Withdraw tokens", hint: "To fresh Solana addresses", category: "withdraw" },
  check_safety: { label: "Safety check", hint: "Stop or jump if a token looks risky", category: "logic" },
  repeat: { label: "Repeat", hint: "Run earlier steps again", category: "logic" },
  end: { label: "End", hint: "Finish the plan here", category: "logic" },
  chat: { label: "Post in chat", hint: "A message in a token's chat", category: "social" },
};

export const categoryOf = (t: ScenarioBlockType): CategoryId => BLOCKS[t].category;

/** Trade steps: they go through a batch and touch a mint's price. */
export const TRADE_TYPES: ReadonlySet<ScenarioBlockType> = new Set(["buy", "sell", "sell_all", "swap", "dca", "create"]);
/** Steps that wait for something (not a pause). */
export const TRIGGER_TYPES: ReadonlySet<ScenarioBlockType> = new Set(["manual_start", "time_at", "price_cross", "deposit_received", "own_result", "curve_progress"]);

const HOUR = 3600;

export const SCENARIO_FLOORS: ScenarioFloors = {
  afterDepositSecs: [600, 2400],
  timeAtJitterSecs: [0, 600],
  fixedWaitJitterPct: 10,
  fixedWaitJitterMinSecs: 30,
  withdrawAfterTradeMinSecs: HOUR,
  withdrawExtraSecs: [0, 1800],
  swapGapSecs: [180, 900],
  swapShaveBps: [200, 800],
  chatAfterTradeSecs: [600, 1800],
  repeatJitterPct: 10,
  dcaWeightJitterPct: 20,
  tradeGapEpochs: [1, 3],
};

/** API.md v0.19 ScenarioParams. The server's PoolInfo.scenarios wins. */
export const DEFAULT_SCENARIO_PARAMS: ScenarioParams = {
  blocks: CATEGORIES.flatMap((c) => c.blocks),
  maxSteps: 12,
  maxRuns: 40,
  maxActivePerKey: 3,
  ttlSecs: { min: HOUR, max: 72 * HOUR, maxNoWithdraw: 7 * 24 * HOUR, default: 24 * HOUR },
  floors: SCENARIO_FLOORS,
};

/** What a new block starts with. `mint` / `venue`: the token the builder was opened for, if any. */
export function defaultBlock(type: ScenarioBlockType, seed: { mint?: string; venue?: Venue; now?: number } = {}): ScenarioBlock {
  const mint = seed.mint ?? "";
  const venue: Venue = seed.venue ?? "pumpfun";
  const slip = { slippageBps: 500 };
  switch (type) {
    case "manual_start":
      return { type };
    case "time_at":
      return { type, at: Math.ceil(((seed.now ?? Date.now()) + 2 * HOUR * 1000) / 60_000) * 60_000 };
    case "price_cross":
      return { type, mint, op: "gte", priceSol: "" };
    case "deposit_received":
      return { type, minZat: "10000000" };
    case "own_result":
      return { type, ref: { step: -1 }, on: "any" };
    case "curve_progress":
      return { type, mint, gtePct: 80 };
    case "wait_random":
      return { type, minSecs: 20 * 60, maxSecs: 90 * 60 };
    case "wait_fixed":
      return { type, secs: HOUR };
    case "buy":
      return { type, venue, mint, zec: { abs: "10000000" }, guard: slip, exec: "delayed" };
    case "sell":
      return { type, venue, mint, amount: { pct: 50, of: "balance" }, guard: slip, exec: "delayed" };
    case "sell_all":
      return { type, venue, mint, guard: slip, exec: "delayed" };
    case "swap":
      return { type, from: mint, to: "", amount: { pct: 100, of: "balance" }, guardSell: slip, guardBuy: slip, exec: "delayed" };
    case "dca":
      return { type, side: "buy", venue, mint, total: { abs: "50000000" }, slices: 4, everySecs: { min: 2 * HOUR, max: 6 * HOUR }, guard: slip, exec: "delayed" };
    case "order_place":
      return { type, order: { venue: "pumpfun", kind: "take_profit", mint, amount: { pct: 100, of: "balance" }, triggerPriceSol: "", exec: "delayed", ttlSecs: 24 * HOUR } };
    case "order_cancel":
      return { type, ref: { step: -1 } };
    case "create":
      return { type, create: { venue: "pumpfun", meta: { name: "", symbol: "" }, initialBuyZec: { abs: "10000000" }, exec: "delayed", quote: "SOL" } };
    case "claim":
      return { type };
    case "withdraw_zec":
      return { type, to: "", amount: { pct: 100, of: "balance" }, exec: "max" };
    case "withdraw_token":
      return { type, mint, amount: { pct: 100, of: "balance" }, to: "", exec: "max" };
    case "check_safety":
      return { type, mint, require: { authoritiesRevoked: true, noRiskyExtensions: true }, onFalse: "stop" };
    case "repeat":
      return { type, from: -1, times: 2 };
    case "end":
      return { type };
    case "chat":
      return { type, mint, text: "" };
  }
}

/** "20 min", "1 h 30 min", "24 h 5 min", "3 d". */
export function formatSecs(secs: number): string {
  if (!Number.isFinite(secs)) return "—";
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s} s`;
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0 && h === 0 && m === 0) return `${d} d`;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

/** "10–40 min" / "1–6 h" / "20 min – 1 h 30 min". */
export function formatRange(a: number, b: number): string {
  const fa = formatSecs(a);
  const fb = formatSecs(b);
  const ua = fa.split(" ").pop();
  const ub = fb.split(" ").pop();
  if (fa.split(" ").length === 2 && fb.split(" ").length === 2 && ua === ub) return `${fa.split(" ")[0]}–${fb}`;
  return `${fa} – ${fb}`;
}
