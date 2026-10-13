// Plain-English plan for the chain cards and the Review & sign screen, plus the totals the plan can take
// from the balance. Pure functions over the plan (ids = positions, shown 1-based).

import type { AmountSpec, Guard, MintRef, OnFail, PoolInfo, ScenarioBlock, ScenarioPlan, ScenarioStep, SafetyRequire } from "@/lib/api/types";
import { formatUnits, shortAddr, VENUE_LABEL } from "@/lib/format";
import { ORDER_LABEL } from "@/lib/orders";
import { WITHDRAW_TOKEN_COST_LAMPORTS, WITHDRAW_TOKEN_GAS_LAMPORTS } from "@/lib/trade";
import { BLOCKS, formatRange, formatSecs } from "./catalog";
import { mintKey } from "./validate";

export interface TokenLabel {
  symbol: string;
  decimals: number;
}

export type TokenLookup = (mint: string) => TokenLabel | null;

const ZAT = 100_000_000;
export const zecText = (zat: string | bigint) => {
  const n = Number(zat) / ZAT;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: n < 0.01 ? 8 : 4 })} ZEC`;
};

export function mintText(plan: ScenarioPlan, ref: MintRef | undefined, tok: TokenLookup): string {
  if (ref === undefined || ref === "") return "a token";
  if (typeof ref === "string") {
    const t = tok(ref);
    return t ? `$${t.symbol}` : shortAddr(ref, 4, 4);
  }
  const s = plan.steps[ref.step];
  if (!s) return "a token";
  if (s.block.type === "create") return s.block.create.meta.symbol ? `$${s.block.create.meta.symbol.toUpperCase()}` : `the token from step ${ref.step + 1}`;
  if (s.block.type === "swap") return mintText(plan, s.block.to, tok);
  return `the token from step ${ref.step + 1}`;
}

function decimalsOf(plan: ScenarioPlan, ref: MintRef | undefined, tok: TokenLookup): number {
  if (typeof ref === "string") return tok(ref)?.decimals ?? 6;
  const key = ref ? mintKey(plan, ref) : null;
  if (key?.startsWith("m:")) return tok(key.slice(2))?.decimals ?? 6;
  return 6;
}

export function amountText(plan: ScenarioPlan, a: AmountSpec | undefined, unit: "zat" | { mint: MintRef | undefined }, tok: TokenLookup): string {
  if (!a) return "—";
  if ("abs" in a) {
    if (!/^\d+$/.test(a.abs)) return "—";
    if (unit === "zat") return zecText(a.abs);
    return `${formatUnits(a.abs, decimalsOf(plan, unit.mint, tok))} ${mintText(plan, unit.mint, tok)}`;
  }
  const what = unit === "zat" ? "ZEC" : mintText(plan, unit.mint, tok);
  if (a.of === "balance") return a.pct === 100 ? `all your ${what}` : `${a.pct}% of your ${what}`;
  const src = plan.steps[a.of.step];
  const from = src ? (src.block.type === "deposit_received" ? `the deposit` : `what step ${a.of.step + 1} got`) : "a missing step";
  return a.pct === 100 ? from : `${a.pct}% of ${from}`;
}

export function guardText(g: Guard | undefined, quote = "SOL"): string {
  if (!g) return "";
  return "slippageBps" in g ? `slippage ${g.slippageBps / 100}%` : `limit ${g.limitPrice} ${quote}`;
}

const execText = (e: string | undefined) => (e === "now" ? "Now" : e === "max" ? "Max privacy" : "Delayed");

function requireText(r: SafetyRequire): string {
  const out: string[] = [];
  if (r.authoritiesRevoked) out.push("mint & freeze revoked");
  if (r.noRiskyExtensions) out.push("no risky extensions");
  if (r.maxTop10Pct !== undefined) out.push(`top-10 ≤ ${r.maxTop10Pct}%`);
  if (r.maxDevPct !== undefined) out.push(`dev ≤ ${r.maxDevPct}%`);
  if (r.minLpBurnedPct !== undefined) out.push(`LP burned ≥ ${r.minLpBurnedPct}%`);
  if (r.maxSniperPct !== undefined) out.push(`snipers ≤ ${r.maxSniperPct}%`);
  return out.join(", ") || "nothing yet";
}

const stepRef = (r: { step: number } | { orderId: string } | { actionId: string }) =>
  "step" in r ? (r.step >= 0 ? `the order from step ${r.step + 1}` : "an order") : "orderId" in r ? `order ${r.orderId.slice(0, 6)}…` : `action ${r.actionId.slice(0, 6)}…`;

/** One sentence per block. `sealed`: show addresses / text masked. */
export function describeBlock(plan: ScenarioPlan, b: ScenarioBlock, tok: TokenLookup, opts: { sealed?: boolean } = {}): string {
  const m = (r: MintRef | undefined) => mintText(plan, r, tok);
  const addr = (a: string) => (!a ? "an address" : opts.sealed ? shortAddr(a, 4, 4) : shortAddr(a, 6, 6));
  switch (b.type) {
    case "manual_start":
      return "Wait until you press Start.";
    case "time_at":
      return `Wait until ${new Date(b.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}.`;
    case "price_cross":
      return `Wait until ${m(b.mint)} trades ${b.op === "gte" ? "at or above" : "at or below"} ${b.priceSol || "…"} SOL.`;
    case "deposit_received":
      return `Wait for a shielded deposit of at least ${zecText(b.minZat || "0")}.`;
    case "own_result":
      return `Wait until ${stepRef(b.ref)} ${b.on === "filled" ? "fills" : b.on === "failed" ? "fails" : "fills or closes"}.`;
    case "curve_progress":
      return b.graduated ? `Wait until ${m(b.mint)} graduates.` : `Wait until ${m(b.mint)}'s curve is ${b.gtePct ?? "…"}% full.`;
    case "wait_fixed":
      return `Wait about ${formatSecs(b.secs)}.`;
    case "wait_random":
      return `Wait a random ${formatRange(b.minSecs, b.maxSecs)}.`;
    case "buy":
      return `Buy ${m(b.mint)} with ${amountText(plan, b.zec, "zat", tok)} on ${VENUE_LABEL[b.venue] ?? b.venue} · ${guardText(b.guard)} · ${execText(b.exec)}.`;
    case "sell":
      return `Sell ${amountText(plan, b.amount, { mint: b.mint }, tok)} · ${guardText(b.guard)} · ${execText(b.exec)}.`;
    case "sell_all":
      return `Sell all ${m(b.mint)} · ${guardText(b.guard)} · ${execText(b.exec)}.`;
    case "swap":
      return `Rotate ${amountText(plan, b.amount, { mint: b.from }, tok)} into ${m(b.to)}: sell, a hidden pause, buy with the proceeds minus a random cut · ${execText(b.exec)}.`;
    case "dca":
      return `${b.side === "buy" ? "Buy" : "Sell"} ${m(b.mint)} for ${amountText(plan, b.total, b.side === "buy" ? "zat" : { mint: b.mint }, tok)} in ${b.slices} random slices, every ${formatRange(b.everySecs.min, b.everySecs.max)} · ${execText(b.exec)}.`;
    case "order_place": {
      const o = b.order;
      const amount = amountText(plan, o.amount, o.kind === "limit_buy" ? "zat" : { mint: o.mint }, tok);
      const price = o.kind === "bracket" ? `take profit at ${o.tpPriceSol || "…"}, stop at ${o.slPriceSol || "…"} SOL` : `at ${o.triggerPriceSol || "…"} SOL`;
      return `Place a private ${ORDER_LABEL[o.kind].toLowerCase()} on ${m(o.mint)} for ${amount}, ${price}.`;
    }
    case "order_cancel":
      return `Cancel ${stepRef(b.ref)}.`;
    case "create": {
      const c = b.create;
      const first = c.initialBuyZec ? ` with a first buy of ${amountText(plan, c.initialBuyZec, "zat", tok)}` : "";
      const name = opts.sealed ? "a token (name sealed)" : c.meta.symbol ? `$${c.meta.symbol.toUpperCase()}${c.meta.name ? ` “${c.meta.name}”` : ""}` : "a token";
      return `Launch ${name} on ${VENUE_LABEL[c.venue] ?? c.venue}${first}.`;
    }
    case "claim":
      return b.mint ? `Claim creator fees of ${m(b.mint)} into your ZEC balance.` : "Claim all creator fees into your ZEC balance.";
    case "withdraw_zec":
      return `Withdraw ${amountText(plan, b.amount, "zat", tok)} to ${addr(b.to)} (shielded) · ${execText(b.exec)}.`;
    case "withdraw_token": {
      const to = Array.isArray(b.to) ? b.to : [b.to];
      return `Withdraw ${amountText(plan, b.amount, { mint: b.mint }, tok)} to ${to.length > 1 ? `${to.length} fresh addresses` : addr(to[0])} · ${execText(b.exec)}.`;
    }
    case "check_safety":
      return `Check ${m(b.mint)}: ${requireText(b.require)}. Otherwise ${b.onFalse === "stop" ? "stop" : `go to step ${b.onFalse.goto + 1}`}.`;
    case "repeat":
      return b.from >= 0 ? `Go back to step ${b.from + 1} — ${b.times} rounds in total.` : "Go back to an earlier step.";
    case "end":
      return "Finish.";
    case "chat":
      return opts.sealed || !b.text ? `Post in ${m(b.mint)}'s chat.` : `Post in ${m(b.mint)}'s chat: “${b.text.length > 60 ? b.text.slice(0, 60) + "…" : b.text}”.`;
  }
}

export function onFailText(f: OnFail | undefined): string {
  const t = (x: unknown) => (x === "skip" ? "skip it" : x === "stop" || x === undefined ? "stop the plan" : `go to step ${(x as { goto: number }).goto + 1}`);
  if (f === undefined || f === "stop") return "If it fails: stop the plan";
  if (f === "skip") return "If it fails: skip it";
  if ("retry" in f) return `If it fails: retry ${f.retry}×, then ${t(f.then)}`;
  return `If it fails: ${t(f)}`;
}

export const stepTitle = (s: ScenarioStep) => BLOCKS[s.block.type]?.label ?? s.block.type;

export interface PlanTotals {
  /** Fixed ZEC the plan may hold at most (abs amounts × rounds), zat. */
  fixedZat: bigint;
  /** Shares of the balance or of earlier results, in words. */
  shares: string[];
  fees: { label: string; zat: bigint }[];
  feesZat: bigint;
}

/** What the plan can take from the balance, counting repeats. Hold is taken step by step, never up front. */
export function planTotals(plan: ScenarioPlan, pool: PoolInfo | null, tok: TokenLookup): PlanTotals {
  const mult = plan.steps.map(() => 1);
  for (const s of plan.steps) if (s.block.type === "repeat" && s.block.from >= 0) for (let j = s.block.from; j < s.id; j++) mult[j] *= Math.max(1, s.block.times);
  let fixed = BigInt(0);
  const shares: string[] = [];
  const fees = new Map<string, bigint>();
  const fee = (label: string, zat: bigint) => fees.set(label, (fees.get(label) ?? BigInt(0)) + zat);
  const createFee = BigInt(pool?.fees?.createFeeZat ?? "100000");
  const wzFee = BigInt(pool?.fees?.withdrawZecFeeZat ?? "15000");
  const nowFee = BigInt(pool?.fees?.nowFeeZat ?? "0");
  const lamportsPerZec = BigInt(pool?.rate?.lamportsPerZecBuy ?? pool?.rate?.lamportsPerZec ?? "0");
  const zecSpec = (a: AmountSpec | undefined, k: number, label: string) => {
    if (!a) return;
    if ("abs" in a) {
      if (/^\d+$/.test(a.abs)) fixed += BigInt(a.abs) * BigInt(k);
    } else shares.push(`${label}: ${amountText(plan, a, "zat", tok)}`);
  };
  plan.steps.forEach((s, i) => {
    const b = s.block;
    const k = mult[i];
    if ("exec" in b && b.exec === "now" && nowFee > BigInt(0)) fee("Now fee", nowFee * BigInt(k));
    switch (b.type) {
      case "buy":
        zecSpec(b.zec, k, `Step ${i + 1}`);
        break;
      case "dca":
        if (b.side === "buy") zecSpec(b.total, k, `Step ${i + 1}`);
        break;
      case "create":
        zecSpec(b.create.initialBuyZec, k, `Step ${i + 1}`);
        fee("Launch fee", createFee * BigInt(k));
        break;
      case "order_place":
        if (b.order.kind === "limit_buy") zecSpec(b.order.amount, k, `Step ${i + 1}`);
        break;
      case "withdraw_zec":
        zecSpec(b.amount, k, `Step ${i + 1}`);
        fee("Shielded payout fee", wzFee * BigInt(k));
        break;
      case "withdraw_token": {
        const parts = b.smart?.parts ?? 1;
        const lamports = (WITHDRAW_TOKEN_GAS_LAMPORTS + WITHDRAW_TOKEN_COST_LAMPORTS) * BigInt(parts * k);
        if (lamportsPerZec > BigInt(0)) fee("Withdrawal gas", (lamports * BigInt(ZAT) + lamportsPerZec - BigInt(1)) / lamportsPerZec);
        break;
      }
    }
  });
  const list = [...fees].map(([label, zat]) => ({ label, zat }));
  return { fixedZat: fixed, shares, fees: list, feesZat: list.reduce((a, f) => a + f.zat, BigInt(0)) };
}

/** Sealed fields of a plan (scenarios.md §4.4): what the operator cannot read even from a database leak. */
export function sealedFields(plan: ScenarioPlan): { step: number; what: string; value: string }[] {
  const out: { step: number; what: string; value: string }[] = [];
  for (const s of plan.steps) {
    const b = s.block;
    if (b.type === "withdraw_zec" && b.to) out.push({ step: s.id, what: "Shielded address", value: b.to });
    if (b.type === "withdraw_token") for (const a of Array.isArray(b.to) ? b.to : [b.to]) if (a) out.push({ step: s.id, what: "Solana address", value: a });
    if (b.type === "chat" && b.text) out.push({ step: s.id, what: "Chat message", value: b.text });
    if (b.type === "create" && (b.create.meta.name || b.create.meta.symbol)) out.push({ step: s.id, what: "Launch name & image", value: `$${b.create.meta.symbol} ${b.create.meta.name}`.trim() });
  }
  return out;
}

/** Mask the way Portfolio echoes it: Ab3d…9xYz. */
export const maskAddr = (a: string) => (a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);
