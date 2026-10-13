// Client copy of the scenario plan validator, API.md v0.19 (Scenarios section). Checked against the shared vectors
// core/testdata/scenario-vectors.json (lib/scenarios/vectors.test.ts): same codes, same steps, same run count.
// The mock server runs it too, so the builder and the "server" answer alike.
//
// Outputs:
//   - issues, by kind:
//       "invalid"     -> 400 scenario_invalid  (details.code from the contract list)
//       "rule"        -> 422 scenario_rule     (P1 now_not_first, P2 withdraw_too_soon, P8 unpriced_mint)
//       "bad_request" -> 400 bad_request, details.code "feature_disabled" (block of a feature that is off)
//       "client"      -> not a server answer: what the server only finds out when the step runs (pool
//                        minimum, venue of a known token, order support) or what could never run (a sealed
//                        step inside a repeat). The builder still blocks signing on it;
//   - floors:   server floors that change WHEN or HOW MUCH a step runs (P3–P7, P9), shown on the chain;
//   - warnings: UI-only nudges, never a rejection.

import type { AmountSpec, Guard, MintRef, OnFail, OrdersParams, Quote, ScenarioBlock, ScenarioParams, ScenarioPlan, ScenarioStep, Venue, VenueInfo } from "@/lib/api/types";
import type { Network } from "@/lib/network";
import { checkChatText } from "@/lib/chat/text";
import { isSolanaAddress, PAYOUT_REVIEW_ABOVE_ZAT } from "@/lib/trade";
import { checkWithdrawUa } from "@/lib/zcash/ua";
import { BLOCKS, formatRange, formatSecs, TRADE_TYPES } from "./catalog";

/** What the builder knows about a pool token (client-only checks). */
export interface TokenFacts {
  mint: string;
  symbol: string;
  decimals: number;
  venue: Venue;
  quote: Quote;
  status: "curve" | "graduated";
  priced: boolean;
}

export interface ValidateCtx {
  params: ScenarioParams;
  now: number;
  minDepositZat: string;
  /** Venues the pool has on (PoolInfo.venues[].venue). Absent = not checked. */
  venues?: Venue[];
  /** fl: the sealed-bid launch is on (its name must not reach the public bundle, P10). */
  features: { fl?: boolean; chat?: boolean; fullTrades?: boolean };
  /** The indexer has a price tick for this literal mint (P8). */
  priced(mint: string): boolean;
  // ---- client-only extras (absent in the vector run) ----
  network?: Network;
  minActionZat?: string;
  venueInfo?: VenueInfo[];
  orders?: OrdersParams;
  token?(mint: string): TokenFacts | null;
  recentDepositAt?: number | null;
}

export type IssueKind = "invalid" | "rule" | "bad_request" | "client";

export interface PlanIssue {
  /** Step index, -1 for the plan as a whole (details.step absent). */
  step: number;
  code: string;
  kind: IssueKind;
  message: string;
}

export interface PlanNote {
  step: number;
  code: string;
  text: string;
}

export interface PlanCheck {
  ok: boolean;
  issues: PlanIssue[];
  warnings: PlanNote[];
  floors: PlanNote[];
  /** Executions as the server counts them (maxRuns). */
  runs: number;
  /** Effective TTL (ttlSecs or the default). */
  ttlSecs: number;
  /** TTL ceiling of this plan (maxNoWithdraw without withdrawals). */
  maxTtlSecs: number;
}

const H = 3600;
const DECIMAL_RE = /^(0|[1-9]\d*)(\.\d+)?$/;
const UINT_RE = /^[1-9]\d*$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const I64_MAX = BigInt("9223372036854775807");
const FAIR = "fl_";
const isFair = (t: string) => t.startsWith(FAIR);

/** Fields each block may carry (anything else -> bad_field). */
const FIELDS: Record<string, readonly string[]> = {
  manual_start: [],
  time_at: ["at"],
  price_cross: ["mint", "op", "priceSol", "timeoutSecs"],
  deposit_received: ["minZat", "timeoutSecs"],
  own_result: ["ref", "on", "timeoutSecs"],
  curve_progress: ["mint", "gtePct", "graduated", "timeoutSecs"],
  wait_fixed: ["secs"],
  wait_random: ["minSecs", "maxSecs"],
  buy: ["venue", "mint", "zec", "guard", "exec"],
  sell: ["venue", "mint", "amount", "guard", "exec"],
  sell_all: ["venue", "mint", "guard", "exec"],
  swap: ["from", "to", "amount", "guardSell", "guardBuy", "venueSell", "venueBuy", "exec"],
  dca: ["side", "venue", "mint", "total", "slices", "everySecs", "guard", "exec"],
  order_place: ["order"],
  order_cancel: ["ref"],
  create: ["create"],
  claim: ["mint"],
  withdraw_token: ["mint", "amount", "to", "smart", "exec"],
  withdraw_zec: ["to", "amount", "exec"],
  check_safety: ["mint", "require", "onFalse"],
  repeat: ["from", "times"],
  end: [],
  chat: ["mint", "text", "showCreatorBadge"],
};

/** Runs of a step (API.md: triggers, waits, checks, repeat, end, manual start = 0; swap 2; dca slices). */
function weight(b: ScenarioBlock): number {
  if (b.type === "swap") return 2;
  if (b.type === "dca") return Number.isInteger(b.slices) ? Math.max(0, b.slices) : 0;
  if (["manual_start", "time_at", "price_cross", "deposit_received", "own_result", "curve_progress", "wait_fixed", "wait_random", "check_safety", "repeat", "end"].includes(b.type)) return 0;
  return 1;
}

const isStepRef = (r: unknown): r is { step: number } => !!r && typeof r === "object" && typeof (r as { step?: unknown }).step === "number";

/** Identity of a mint inside the plan: "m:<base58>" or "c:<create step>"; null when unresolvable. */
export function mintKey(plan: ScenarioPlan, ref: MintRef | undefined, depth = 0): string | null {
  if (typeof ref === "string") return ref ? `m:${ref}` : null;
  if (!isStepRef(ref) || depth > 12) return null;
  const s = plan.steps[ref.step];
  if (!s || !s.block) return null;
  if (s.block.type === "create") return `c:${ref.step}`;
  if (s.block.type === "swap") return mintKey(plan, s.block.to, depth + 1);
  return null;
}

const literal = (key: string | null) => (key && key.startsWith("m:") ? key.slice(2) : null);

type Unit = { kind: "zat" } | { kind: "tokens"; mint: string | null };

function outputUnit(plan: ScenarioPlan, s: ScenarioStep): Unit | null {
  const b = s.block;
  switch (b.type) {
    case "deposit_received":
    case "sell":
    case "sell_all":
    case "claim":
      return { kind: "zat" };
    case "buy":
      return { kind: "tokens", mint: mintKey(plan, b.mint) };
    case "create":
      return { kind: "tokens", mint: `c:${s.id}` };
    case "swap":
      return { kind: "tokens", mint: mintKey(plan, b.to) };
    default:
      return null;
  }
}

function tradedKeys(plan: ScenarioPlan, s: ScenarioStep): string[] {
  const b = s.block;
  if (b.type === "swap") return [mintKey(plan, b.from), mintKey(plan, b.to)].filter((k): k is string => !!k);
  if (b.type === "create") return [`c:${s.id}`];
  if (b.type === "buy" || b.type === "sell" || b.type === "sell_all" || b.type === "dca") {
    const k = mintKey(plan, b.mint);
    return k ? [k] : [];
  }
  return [];
}

/** Guaranteed minimum of a wait (API.md P2: wait_fixed counts as secs − max(30, 10 %)). */
function guaranteedWait(b: ScenarioBlock, p: ScenarioParams): number {
  if (b.type === "wait_random") return Number.isFinite(b.minSecs) ? b.minSecs : 0;
  if (b.type === "wait_fixed") return Number.isFinite(b.secs) ? b.secs - Math.max(p.floors.fixedWaitJitterMinSecs ?? 30, (b.secs * p.floors.fixedWaitJitterPct) / 100) : 0;
  return 0;
}

export function validatePlan(plan: ScenarioPlan, ctx: ValidateCtx): PlanCheck {
  const issues: PlanIssue[] = [];
  const warnings: PlanNote[] = [];
  const floors: PlanNote[] = [];
  const P = ctx.params;
  const F = P.floors;
  const steps: ScenarioStep[] = Array.isArray(plan?.steps) ? plan.steps : [];
  const bad = (step: number, code: string, message: string, kind: IssueKind = "invalid") => issues.push({ step, code, kind, message });
  const warn = (step: number, code: string, text: string) => warnings.push({ step, code, text });
  const floor = (step: number, code: string, text: string) => floors.push({ step, code, text });

  const hasWithdraw = steps.some((s) => s?.block?.type === "withdraw_token" || s?.block?.type === "withdraw_zec");
  const maxTtl = hasWithdraw ? P.ttlSecs.max : (P.ttlSecs.maxNoWithdraw ?? P.ttlSecs.max);
  const ttl = plan?.ttlSecs ?? P.ttlSecs.default;
  let runs = 0;

  // ---- the plan ----
  if (plan?.v !== 1) bad(-1, "bad_version", "Unknown plan version.");
  if (steps.length === 0) bad(-1, "empty", "Add at least one block.");
  if (steps.length > P.maxSteps) bad(-1, "too_many_steps", `At most ${P.maxSteps} blocks in one scenario.`);
  if (!Number.isInteger(ttl) || ttl < P.ttlSecs.min || ttl > maxTtl)
    bad(-1, "bad_ttl", hasWithdraw && ttl > P.ttlSecs.max ? `Plans with a withdrawal live at most ${formatSecs(P.ttlSecs.max)}.` : `The plan must live ${formatSecs(P.ttlSecs.min)} – ${formatSecs(maxTtl)}.`);
  steps.forEach((s, i) => {
    if (s?.id !== i) bad(i, "bad_step_id", "Step ids must be 0, 1, 2… in order.");
  });
  if (issues.length) return done();

  // ---- runs and repeat bodies ----
  const mult = steps.map(() => 1);
  const inRepeat = new Set<number>();
  for (const [i, s] of steps.entries()) {
    const b = s.block;
    if (b?.type === "repeat" && Number.isInteger(b.from) && b.from >= 0 && b.from < i && Number.isInteger(b.times))
      for (let j = b.from; j < i; j++) {
        mult[j] *= Math.max(1, b.times);
        inRepeat.add(j);
      }
  }
  runs = steps.reduce((sum, s, i) => sum + (s.block && typeof s.block === "object" && String(s.block.type) in BLOCKS ? mult[i] * weight(s.block) : s.block && isFair(String(s.block.type)) ? mult[i] : 0), 0);

  let deposits = 0;
  for (const [i, s] of steps.entries()) {
    const b = s.block;
    const type = b && typeof b === "object" ? String((b as { type?: unknown }).type) : "";
    if (isFair(type)) {
      if (!ctx.features.fl) bad(i, "feature_disabled", "This block is not available on this pool.", "bad_request");
      continue;
    }
    if (!(type in BLOCKS)) {
      bad(i, "unknown_block", "This block is not available on this pool.");
      continue;
    }
    if (type === "chat" && !ctx.features.chat) {
      bad(i, "feature_disabled", "Token chat is off on this pool.", "bad_request");
      continue;
    }
    const extra = Object.keys(b).filter((k) => k !== "type" && !FIELDS[type].includes(k));
    if (extra.length) {
      bad(i, "bad_field", `Unknown field: ${extra[0]}.`);
      continue;
    }
    for (const k of Object.keys(s)) if (!["id", "block", "onFail"].includes(k)) bad(i, "bad_field", `Unknown field: ${k}.`);
    const label = BLOCKS[b.type].label;

    const ref = (r: unknown, what: string, ok: (t: string) => boolean): ScenarioStep | null => {
      if (!isStepRef(r) || !Number.isInteger(r.step) || r.step < 0) {
        bad(i, "bad_ref", `${label}: choose ${what}.`);
        return null;
      }
      if (r.step >= i) {
        bad(i, "bad_ref", `${label}: ${what} must come before this step.`);
        return null;
      }
      const t = steps[r.step];
      if (!ok(t.block.type)) {
        bad(i, "bad_ref", `${label}: step ${r.step + 1} is not ${what}.`);
        return null;
      }
      return t;
    };

    /** A MintRef: literal base58 or { step } of an earlier create / swap. Returns the plan key. */
    const checkMint = (m: MintRef | undefined, field = "token"): string | null => {
      if (typeof m === "string") {
        if (!m) {
          bad(i, "bad_mint", `${label}: choose a ${field}.`);
          return null;
        }
        if (!isSolanaAddress(m)) {
          bad(i, "bad_mint", `${label}: the ${field} is not a Solana address.`);
          return null;
        }
        return `m:${m}`;
      }
      if (!ref(m, "a launch or rotation step", (t) => t === "create" || t === "swap")) return null;
      return mintKey(plan, m);
    };

    /** Pair of a mint in the plan: the pool's token facts for a literal, create.quote for the plan's own launch. */
    const pairOf = (m: MintRef | undefined): string | null => {
      const key = typeof m === "string" ? (m ? `m:${m}` : null) : mintKey(plan, m);
      if (!key) return null;
      if (key.startsWith("c:")) {
        const c = steps[Number(key.slice(2))]?.block;
        return c?.type === "create" ? (c.create?.quote ?? "SOL") : null;
      }
      return ctx.token?.(key.slice(2))?.quote ?? null;
    };

    /** P8: price-dependent checks only on a mint with a tick: a pool token that has one, or the plan's own SOL-pair launch. */
    const needPrice = (m: MintRef | undefined, what: string) => {
      const key = typeof m === "string" ? (m ? `m:${m}` : null) : mintKey(plan, m);
      const lit = literal(key);
      const own = key?.startsWith("c:") ? pairOf(m) : null;
      if ((lit && isSolanaAddress(lit) && !ctx.priced(lit)) || (own !== null && own !== "SOL"))
        bad(i, "unpriced_mint", `${label}: ${lit && ctx.token?.(lit) ? `$${ctx.token(lit)!.symbol}` : "this token"} has no price tick, so ${what} can't be checked. Use a limit price.`, "rule");
    };

    const checkGuard = (g: Guard | undefined, m: MintRef | undefined, name = "price guard") => {
      if (!g || typeof g !== "object") return bad(i, "bad_guard", `${label}: set slippage or a limit price.`);
      // v0.19: no price unit for USDC / USD1 pairs without reading the pool -> no price guard at all.
      const pair = pairOf(m);
      if (pair === "USDC" || pair === "USD1") return bad(i, "unsupported_pair", `${label}: price guards don't work on ${pair} pairs yet.`);
      if ("slippageBps" in g) {
        if (!Number.isInteger(g.slippageBps) || g.slippageBps < 50 || g.slippageBps > 5000) return bad(i, "bad_guard", `${label}: slippage must be 0.5–50 %.`);
        needPrice(m, "slippage");
      } else if ("limitPrice" in g) {
        if (!DECIMAL_RE.test(String(g.limitPrice)) || !(Number(g.limitPrice) > 0) || g.limitPrice.replace(".", "").replace(/^0+/, "").length > 18) bad(i, "bad_guard", `${label}: the ${name} needs a positive price.`);
      } else bad(i, "bad_guard", `${label}: set slippage or a limit price.`);
    };

    const checkAmount = (a: AmountSpec | undefined, unit: Unit, field = "amount", min = true) => {
      if (!a || typeof a !== "object") return bad(i, "bad_amount", `${label}: set the ${field}.`);
      if ("abs" in a) {
        const v = String(a.abs);
        if (!UINT_RE.test(v)) return bad(i, "bad_amount", `${label}: the ${field} must be more than zero.`);
        if (unit.kind === "zat" ? BigInt(v) > I64_MAX : v.length > 38) return bad(i, "bad_amount", `${label}: the ${field} is too large.`);
        if (unit.kind === "zat" && min && ctx.minActionZat && BigInt(v) < BigInt(ctx.minActionZat))
          bad(i, "bad_amount", `${label}: below the pool minimum of ${Number(ctx.minActionZat) / 1e8} ZEC.`);
        return;
      }
      if (!Number.isInteger(a.pct) || a.pct < 1 || a.pct > 100) return bad(i, "bad_amount", `${label}: the share must be 1–100 %.`);
      if (a.of === "balance") return;
      const t = ref(a.of, "a step with a result", (x) => ["deposit_received", "sell", "sell_all", "claim", "buy", "create", "swap"].includes(x));
      if (!t) return;
      const out = outputUnit(plan, t);
      if (!out || out.kind !== unit.kind) return bad(i, "bad_ref", `${label}: step ${t.id + 1} yields ${out?.kind === "zat" ? "ZEC" : "tokens"}, this needs ${unit.kind === "zat" ? "ZEC" : "tokens"}.`);
      if (out.kind === "tokens" && unit.kind === "tokens" && unit.mint && out.mint && unit.mint !== out.mint) bad(i, "bad_ref", `${label}: step ${t.id + 1} yields a different token.`);
    };

    const checkVenue = (v: Venue | undefined, mint: MintRef | undefined) => {
      if (!v || (ctx.venues && !ctx.venues.includes(v))) return bad(i, "bad_venue", `${label}: ${v ? `${v} is not available on this pool` : "choose a venue"}.`);
      const t = typeof mint === "string" && mint ? ctx.token?.(mint) : null;
      if (t && v !== "jupiter" && t.venue !== v) bad(i, "venue_mismatch", `${label}: $${t.symbol} trades on ${t.venue}.`, "client");
      if (ctx.venueInfo && !ctx.venueInfo.find((x) => x.venue === v)?.trade) bad(i, "venue_off", `${label}: ${v} takes no trades on this network.`, "client");
    };

    const checkExec = (e: unknown, allowNow: boolean) => {
      if (e !== "now" && e !== "delayed" && e !== "max") return bad(i, "bad_exec", `${label}: choose Delayed or Max privacy.`);
      if (e === "now" && !allowNow) return bad(i, "bad_exec", `${label}: never instant. Choose Delayed or Max privacy.`);
      if (e === "now") {
        // API.md v0.19 (lead 13.10): only step 1 of a plan that begins with manual_start; a retry runs delayed.
        const afterStart = i === 1 && steps[0].block.type === "manual_start";
        if (!afterStart || inRepeat.has(i)) bad(i, "now_not_first", "Now only right after manual start. After any other event an instant trade would point straight at it.", "rule");
        else floor(i, "now_after_start", "Now only right after manual start");
      }
    };

    const range = (ok: boolean, message: string) => {
      if (!ok) bad(i, "bad_range", `${label}: ${message}`);
    };
    const checkTimeout = (t: number | undefined) => {
      if (t !== undefined) range(Number.isInteger(t) && t >= 30 && t <= ttl, `the time limit must be 30 s – ${formatSecs(ttl)}.`);
    };
    const price = (v: unknown) => typeof v === "string" && DECIMAL_RE.test(v) && Number(v) > 0;

    switch (b.type) {
      case "manual_start":
        if (i !== 0) bad(i, "manual_start_not_first", "Manual start can only be the first block.");
        break;
      case "time_at":
        range(Number.isInteger(b.at) && b.at % 60_000 === 0 && b.at >= ctx.now + 60_000 && b.at <= ctx.now + ttl * 1000, "pick a whole minute between 1 min from now and when the plan expires.");
        floor(i, "time_jitter", `Fires up to ${formatSecs(F.timeAtJitterSecs[1])} after the set time`);
        break;
      case "price_cross":
        checkMint(b.mint);
        needPrice(b.mint, "a price trigger");
        if (b.op !== "gte" && b.op !== "lte") bad(i, "bad_field", `${label}: above or below?`);
        range(price(b.priceSol), "set a price.");
        if (b.op === "lte") floor(i, "two_ticks", "Below: needs two price ticks in a row (~2 min)");
        checkTimeout(b.timeoutSecs);
        break;
      case "deposit_received":
        deposits++;
        if (deposits > 1) bad(i, "deposit_twice", "Only one deposit trigger per scenario.");
        else if (!UINT_RE.test(String(b.minZat)) || BigInt(b.minZat) < BigInt(ctx.minDepositZat) || BigInt(b.minZat) > I64_MAX)
          bad(i, "bad_amount", `${label}: at least ${Number(ctx.minDepositZat) / 1e8} ZEC (the pool's minimum deposit).`);
        floor(i, "after_deposit", `After a deposit: random ${formatRange(...F.afterDepositSecs)}`);
        checkTimeout(b.timeoutSecs);
        break;
      case "own_result":
        if (isStepRef(b.ref)) ref(b.ref, "a Place order step", (x) => x === "order_place");
        else if (!b.ref || ("orderId" in b.ref ? !HEX32_RE.test(b.ref.orderId) : "actionId" in b.ref ? !HEX32_RE.test(b.ref.actionId) : true)) bad(i, "bad_ref", `${label}: choose an order.`);
        if (!["filled", "failed", "any"].includes(b.on)) bad(i, "bad_field", `${label}: wait for filled, failed or either.`);
        checkTimeout(b.timeoutSecs);
        break;
      case "curve_progress":
        checkMint(b.mint);
        needPrice(b.mint, "the curve");
        if ((b.gtePct !== undefined) === (b.graduated !== undefined)) bad(i, "bad_field", `${label}: either a fill level or graduation.`);
        else if (b.gtePct !== undefined) range(Number.isInteger(b.gtePct) && b.gtePct >= 1 && b.gtePct <= 100, "fill level 1–100 %.");
        else if (b.graduated !== true) bad(i, "bad_field", `${label}: either a fill level or graduation.`);
        checkTimeout(b.timeoutSecs);
        break;
      case "wait_fixed":
        range(Number.isInteger(b.secs) && b.secs >= 30 && b.secs <= ttl, `30 s – ${formatSecs(ttl)}.`);
        floor(i, "fixed_jitter", `≈ ±${F.fixedWaitJitterPct} % (at least ±${F.fixedWaitJitterMinSecs ?? 30} s), never exact`);
        break;
      case "wait_random":
        range(Number.isInteger(b.minSecs) && Number.isInteger(b.maxSecs) && b.minSecs >= 30 && b.minSecs < b.maxSecs && b.maxSecs <= ttl, `from 30 s, the shortest below the longest, up to ${formatSecs(ttl)}.`);
        break;
      case "buy":
        checkMint(b.mint);
        checkVenue(b.venue, b.mint);
        checkAmount(b.zec, { kind: "zat" }, "ZEC amount");
        checkGuard(b.guard, b.mint);
        checkExec(b.exec, true);
        break;
      case "sell":
      case "sell_all": {
        const key = checkMint(b.mint);
        checkVenue(b.venue, b.mint);
        if (b.type === "sell") checkAmount(b.amount, { kind: "tokens", mint: key });
        checkGuard(b.guard, b.mint);
        checkExec(b.exec, true);
        break;
      }
      case "swap": {
        const from = checkMint(b.from, "token to sell");
        const to = checkMint(b.to, "token to buy");
        if (from && to && from === to) bad(i, "same_mint", `${label}: pick two different tokens.`);
        checkAmount(b.amount, { kind: "tokens", mint: from });
        checkGuard(b.guardSell, b.from, "sell guard");
        checkGuard(b.guardBuy, b.to, "buy guard");
        if (b.venueSell) checkVenue(b.venueSell, b.from);
        if (b.venueBuy) checkVenue(b.venueBuy, b.to);
        checkExec(b.exec, false);
        floor(i, "swap_gap", `Hidden pause ${formatRange(...F.swapGapSecs)}, buy side shaved ${F.swapShaveBps[0] / 100}–${F.swapShaveBps[1] / 100} %`);
        break;
      }
      case "dca": {
        const key = checkMint(b.mint);
        checkVenue(b.venue, b.mint);
        if (b.side !== "buy" && b.side !== "sell") bad(i, "bad_field", `${label}: buy or sell?`);
        checkAmount(b.total, b.side === "sell" ? { kind: "tokens", mint: key } : { kind: "zat" }, "total", false);
        const ev = b.everySecs;
        range(
          Number.isInteger(b.slices) && b.slices >= 2 && b.slices <= 12 && !!ev && Number.isInteger(ev.min) && Number.isInteger(ev.max) && ev.min >= 600 && ev.max >= ev.min && b.slices * ev.max <= ttl,
          `2–12 slices, at least 10 min apart, and slices × the longest gap within the plan's ${formatSecs(ttl)}.`,
        );
        if (ctx.minActionZat && b.side === "buy" && b.total && "abs" in b.total && UINT_RE.test(b.total.abs) && Number.isInteger(b.slices) && b.slices > 0 && BigInt(b.total.abs) / BigInt(b.slices) < BigInt(ctx.minActionZat))
          bad(i, "bad_amount", `${label}: each slice would be below the pool minimum of ${Number(ctx.minActionZat) / 1e8} ZEC.`);
        checkGuard(b.guard, b.mint);
        checkExec(b.exec, false);
        floor(i, "dca_jitter", `Slices ±${F.dcaWeightJitterPct} %, random gaps — never equal, never on a clock`);
        break;
      }
      case "order_place": {
        const o = b.order;
        if (!o || typeof o !== "object") {
          bad(i, "bad_field", `${label}: set up the order.`);
          break;
        }
        const key = checkMint(o.mint);
        const kinds = ctx.orders?.kinds ?? ["limit_buy", "limit_sell", "take_profit", "stop_loss", "bracket"];
        if (!kinds.includes(o.kind)) bad(i, "bad_field", `${label}: unknown order type.`);
        if (o.venue !== "pumpfun") bad(i, "bad_venue", `${label}: orders run on pump.fun only.`);
        checkAmount(o.amount, o.kind === "limit_buy" ? { kind: "zat" } : { kind: "tokens", mint: key }, "amount", false);
        if (o.kind === "bracket") {
          range(price(o.tpPriceSol) && price(o.slPriceSol), "set the take-profit and stop-loss prices.");
          if (price(o.tpPriceSol) && price(o.slPriceSol)) range(Number(o.tpPriceSol) > Number(o.slPriceSol), "take-profit must be above stop-loss.");
        } else range(price(o.triggerPriceSol), "set the trigger price.");
        if (o.slippageBps !== undefined && (!Number.isInteger(o.slippageBps) || o.slippageBps < 50 || o.slippageBps > 5000)) bad(i, "bad_guard", `${label}: slippage must be 0.5–50 %.`);
        const maxOrderTtl = ctx.orders?.maxTtlSecs ?? 72 * H;
        if (o.ttlSecs !== undefined) range(Number.isInteger(o.ttlSecs) && o.ttlSecs >= H && o.ttlSecs <= maxOrderTtl, `the order lives 1 h – ${formatSecs(maxOrderTtl)}.`);
        checkExec(o.exec ?? "delayed", false);
        // What the server only checks when the order is placed (orders.md): pump.fun SOL-curve pool mints.
        const lit = literal(key);
        const t = lit ? ctx.token?.(lit) : undefined;
        const created = key?.startsWith("c:") ? (steps[Number(key.slice(2))]?.block as Extract<ScenarioBlock, { type: "create" }>)?.create : null;
        if (ctx.token && ((lit && (!t || t.venue !== "pumpfun" || t.status !== "curve" || t.quote !== "SOL")) || (created && (created.venue !== "pumpfun" || (created.quote ?? "SOL") !== "SOL"))))
          bad(i, "unsupported_mint", `${label}: orders work only for pump.fun SOL-curve tokens the pool trades.`);
        break;
      }
      case "order_cancel":
        if (isStepRef(b.ref)) ref(b.ref, "a Place order step", (x) => x === "order_place");
        else if (!b.ref || !("orderId" in b.ref) || !HEX32_RE.test(b.ref.orderId)) bad(i, "bad_ref", `${label}: choose an order.`);
        break;
      case "create": {
        const c = b.create;
        if (!c || typeof c !== "object") {
          bad(i, "bad_field", `${label}: set up the launch.`);
          break;
        }
        if (c.venue === "jupiter" || !c.venue || (ctx.venues && !ctx.venues.includes(c.venue))) bad(i, "bad_venue", `${label}: choose a launchpad this pool has on.`);
        else if (ctx.venueInfo && !ctx.venueInfo.find((x) => x.venue === c.venue)?.create) bad(i, "venue_off", `${label}: launches are off on ${c.venue} right now.`, "client");
        const name = c.meta?.name ?? "";
        const symbol = c.meta?.symbol ?? "";
        if (name.trim().length < 1 || name.length > 32 || !/^[A-Za-z0-9]{1,10}$/.test(symbol)) bad(i, "bad_meta", `${label}: a name of 1–32 characters and a ticker of 1–10 letters or digits.`);
        if (c.initialBuyZec !== undefined) checkAmount(c.initialBuyZec, { kind: "zat" }, "first buy");
        checkExec(c.exec ?? "delayed", true);
        break;
      }
      case "claim":
        if (b.mint !== undefined) checkMint(b.mint);
        break;
      case "withdraw_token": {
        const key = checkMint(b.mint);
        checkAmount(b.amount, { kind: "tokens", mint: key });
        const dests = Array.isArray(b.to) ? b.to : [b.to];
        const parts = b.smart ? b.smart.parts : 1;
        if (b.smart) range(Number.isInteger(b.smart.parts) && b.smart.parts >= 2 && b.smart.parts <= 5 && Number.isInteger(b.smart.maxDelayMin) && b.smart.maxDelayMin >= 1 && b.smart.maxDelayMin <= 1440, "smart withdraw takes 2–5 parts and a delay of 1 min – 24 h.");
        if (dests.some((d) => !d)) bad(i, "bad_address", `${label}: paste ${parts > 1 ? "one fresh address per part" : "a fresh Solana address"}.`);
        else if (dests.some((d) => typeof d !== "string" || !isSolanaAddress(d))) bad(i, "bad_address", `${label}: not a Solana address.`);
        else if (new Set(dests).size !== dests.length) bad(i, "bad_address", `${label}: every part needs its own address.`);
        else if (dests.length !== parts) bad(i, "bad_address", `${label}: one address per part.`);
        checkExec(b.exec, false);
        if (b.exec !== "max") warn(i, "withdraw_not_max", "Max privacy (5–15 min) hides a withdrawal better than Delayed.");
        // P2: on EVERY path (goto, skip, repeat) from a trade of this mint — buy, sell, swap, DCA, launch, or an
        // order on it (placed or observed filled) — to this withdrawal there must be a wait with a guaranteed
        // minimum of ≥ 1 h.
        if (key) {
          // v0.19: the guaranteed waits along every path add up to ≥ 1 h.
          const shortest = tradesOf(plan, key).length ? shortestWaitTo(plan, i, key, P) : Infinity;
          if (shortest < F.withdrawAfterTradeMinSecs)
            bad(i, "withdraw_too_soon", `Withdraw waits ≥${formatSecs(F.withdrawAfterTradeMinSecs)} after the trade. On some path (next step, a skip, a go-to or a repeat) the waits since a trade of this token add up to less — “bought → withdrew 40 s later” links your new address to the buy.`, "rule");
          else if (shortest !== Infinity) {
            if (shortest < 12 * H) warn(i, "withdraw_soon", "Less than 12 h between the trade and the withdrawal on some path. Longer is safer.");
            floor(i, "withdraw_after_trade", `Withdraw waits ≥${formatSecs(F.withdrawAfterTradeMinSecs)} after the trade, plus random ${formatRange(...F.withdrawExtraSecs)}`);
          }
        }
        break;
      }
      case "withdraw_zec":
        if (!b.to) bad(i, "bad_address", `${label}: paste a shielded address (Unified, Orchard).`);
        else if (ctx.network) {
          // The server checks the UA at creation (check_ua); the shared vectors leave it out.
          const v = checkWithdrawUa(b.to, ctx.network);
          if (!v.ok) bad(i, "bad_address", `${label}: ${v.message}`);
        }
        checkAmount(b.amount, { kind: "zat" });
        checkExec(b.exec, false);
        if (b.exec !== "max") warn(i, "withdraw_not_max", "Max privacy (5–15 min) hides a withdrawal better than Delayed.");
        if (ctx.network && ctx.network !== "devnet" && b.amount && "abs" in b.amount && UINT_RE.test(b.amount.abs) && BigInt(b.amount.abs) > PAYOUT_REVIEW_ABOVE_ZAT) warn(i, "payout_review", "Above 1 ZEC the payout waits for the operator's review.");
        break;
      case "check_safety": {
        checkMint(b.mint);
        const r = b.require ?? {};
        if ((r.maxDevPct !== undefined || r.maxSniperPct !== undefined) && !ctx.features.fullTrades) {
          bad(i, "feature_disabled", `${label}: dev and sniper shares are not available on this pool.`, "bad_request");
          break;
        }
        if (!Object.values(r).some((v) => v !== undefined && v !== false)) bad(i, "bad_field", `${label}: pick at least one condition.`);
        for (const k of ["maxTop10Pct", "maxDevPct", "minLpBurnedPct", "maxSniperPct"] as const) if (r[k] !== undefined) range(Number.isFinite(r[k]) && r[k]! >= 0 && r[k]! <= 100, "percentages are 0–100.");
        if (b.onFalse !== "stop") checkGoto(b.onFalse?.goto, i, "Otherwise go to");
        break;
      }
      case "repeat":
        if (!Number.isInteger(b.from) || b.from < 0 || b.from >= i) bad(i, "bad_repeat", `${label}: choose an earlier step to go back to.`);
        else if (!Number.isInteger(b.times) || b.times < 2 || b.times > 10) bad(i, "bad_repeat", `${label}: 2–10 rounds in total.`);
        else {
          const inside = steps.slice(b.from, i).map((x) => String(x.block.type));
          if (inside.some((t) => t === "manual_start" || t === "deposit_received" || t === "create" || t === "repeat" || isFair(t)))
            bad(i, "bad_repeat", `${label}: cannot run a start, a deposit, a launch or another repeat again.`);
          else if (inside.some((t) => t === "withdraw_zec" || t === "withdraw_token" || t === "chat"))
            // Sealed values (addresses, chat text) are deleted once used: a second round could not rebuild them.
            bad(i, "bad_repeat", `${label}: withdrawals and chat messages run once — their sealed address or text is deleted after use.`);
          if (steps.slice(b.from, i).some((x) => tradedKeys(plan, x).length && hasAbs(x.block))) floor(i, "repeat_jitter", `Each round ±${F.repeatJitterPct} % on fixed amounts`);
        }
        break;
      case "end":
        break;
      case "chat": {
        const key = checkMint(b.mint);
        const t = checkChatText(b.text ?? "");
        if (!t.ok) bad(i, "bad_text", t.problem === "empty" ? `${label}: write the message.` : `${label}: the message has hidden characters or is too long.`);
        if (key && steps.slice(0, i).some((x) => tradedKeys(plan, x).includes(key))) floor(i, "chat_after_trade", `After your trade: slow mode + random ${formatRange(...F.chatAfterTradeSecs)}`);
        break;
      }
    }

    checkOnFail(s.onFail, i);

    // P6: a buy funded by an earlier sale.
    if (b.type === "buy" && b.zec && "of" in b.zec && isStepRef(b.zec.of)) {
      const src = steps[b.zec.of.step];
      if (src && ["sell", "sell_all", "swap"].includes(src.block.type)) floor(i, "mirror", `Pause ${formatRange(...F.swapGapSecs)} and amount shaved ${F.swapShaveBps[0] / 100}–${F.swapShaveBps[1] / 100} % after the sale`);
    }
    // P9: two trade steps back to back.
    if (TRADE_TYPES.has(b.type) && i > 0 && TRADE_TYPES.has(steps[i - 1].block?.type)) floor(i, "trade_gap", `Runs ${F.tradeGapEpochs[0]}–${F.tradeGapEpochs[1]} batches after the previous trade`);
  }

  if (runs > P.maxRuns) bad(-1, "too_many_runs", `This plan would run ${runs} times (repeats, DCA slices and rotations count). The limit is ${P.maxRuns}.`);

  // UI-only warnings.
  steps.forEach((s, i) => {
    if (s.block?.type !== "sell_all") return;
    const key = mintKey(plan, s.block.mint);
    for (let j = i - 1; j >= 0; j--) {
      const t = steps[j];
      if (t.block?.type === "buy" && mintKey(plan, t.block.mint) === key) {
        const between = steps.slice(j + 1, i).reduce((sum, x) => sum + Math.max(0, guaranteedWait(x.block, P)), 0);
        if (between < H) warn(i, "sell_all_soon", "Selling everything within 1 h of the buy makes the pair easy to match.");
        break;
      }
    }
  });
  const addrs = new Map<string, number>();
  steps.forEach((s, i) => {
    if (s.block?.type !== "withdraw_token") return;
    for (const a of Array.isArray(s.block.to) ? s.block.to : [s.block.to]) {
      if (!a) continue;
      if (addrs.has(a)) warn(i, "address_reused", `The same address as step ${addrs.get(a)! + 1}. Use a fresh one for each withdrawal.`);
      else addrs.set(a, i);
    }
  });
  if (steps.length && steps[0].block?.type !== "manual_start" && ctx.recentDepositAt && ctx.now - ctx.recentDepositAt < 10 * 60_000)
    warn(0, "fresh_deposit", "You topped up minutes ago. Starting right away ties the plan to that deposit — add Manual start or a random wait.");

  return done();

  function done(): PlanCheck {
    const seen = new Set<string>();
    const unique = issues.filter((x) => {
      const k = `${x.step}|${x.code}|${x.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { ok: unique.length === 0, issues: unique, warnings, floors, runs, ttlSecs: ttl, maxTtlSecs: maxTtl };
  }

  function checkGoto(g: unknown, i: number, what: string) {
    if (!Number.isInteger(g) || (g as number) <= i || (g as number) >= steps.length)
      bad(i, "bad_goto", `${what}: ${Number.isInteger(g) && (g as number) >= 0 && (g as number) <= i ? "only forward. Use Repeat to go back" : "choose a later step"}.`);
  }

  function checkOnFail(f: OnFail | undefined, i: number) {
    if (f === undefined || f === "stop" || f === "skip") return;
    if (!f || typeof f !== "object") return bad(i, "bad_on_fail", "If it fails: stop, skip, retry or go to a later step.");
    if ("retry" in f) {
      if (!([1, 2, 3] as number[]).includes(f.retry)) return bad(i, "bad_on_fail", "Retry 1–3 times.");
      const t = f.then;
      if (t === "stop" || t === "skip") return;
      if (t && typeof t === "object" && "goto" in t) return checkGoto(t.goto, i, "Then go to");
      return bad(i, "bad_on_fail", "After retries: stop, skip or go to a later step.");
    }
    if ("goto" in f) return checkGoto(f.goto, i, "If it fails, go to");
    bad(i, "bad_on_fail", "If it fails: stop, skip, retry or go to a later step.");
  }
}

// ---- P2 over the plan's graph ----

/** Where control can go after step i: the next step, forward gotos (onFail, check_safety), repeat's back edge. */
function successors(plan: ScenarioPlan, i: number): number[] {
  const s = plan.steps[i];
  const out = new Set<number>([i + 1]);
  const f = s.onFail;
  if (f && typeof f === "object") {
    if ("goto" in f) out.add(f.goto);
    if ("retry" in f && typeof f.then === "object") out.add(f.then.goto);
  }
  const b = s.block;
  if (b?.type === "check_safety" && typeof b.onFalse === "object") out.add(b.onFalse.goto);
  if (b?.type === "repeat" && Number.isInteger(b.from) && b.from >= 0 && b.from < i && Number.isInteger(b.times) && b.times >= 2 && b.times <= 10) {
    const body = plan.steps.slice(b.from, i).map((x) => String(x.block?.type));
    // An invalid body is reported as bad_repeat; its back edge does not exist.
    if (!body.some((t) => ["manual_start", "deposit_received", "create", "repeat", "withdraw_token", "withdraw_zec", "chat"].includes(t) || isFair(t))) out.add(b.from);
  }
  return [...out].filter((x) => Number.isInteger(x) && x >= 0 && x <= plan.steps.length);
}

/** Steps that trade mint `key`: buy / sell / sell_all / dca / swap / create, an order on it, and the own_result that sees it fill. */
function tradesOf(plan: ScenarioPlan, key: string): number[] {
  const out: number[] = [];
  plan.steps.forEach((s, i) => {
    const b = s.block;
    if (!b) return;
    if (tradedKeys(plan, s).includes(key)) out.push(i);
    else if (b.type === "order_place" && mintKey(plan, b.order?.mint) === key) out.push(i);
  });
  return out;
}

/** The smallest total guaranteed wait over all paths from a trade of `key` to `target` (for the 12 h hint). */
function shortestWaitTo(plan: ScenarioPlan, target: number, key: string, p: ScenarioParams): number {
  let best = Infinity;
  for (const t of tradesOf(plan, key)) {
    // Dijkstra over steps, weight = guaranteed wait of the step entered.
    const dist = new Map<number, number>([[t, 0]]);
    const queue: [number, number][] = [[0, t]];
    while (queue.length) {
      queue.sort((a, b) => a[0] - b[0]);
      const [d, n] = queue.shift()!;
      if (d > (dist.get(n) ?? Infinity)) continue;
      for (const m of successors(plan, n)) {
        if (m === target) {
          best = Math.min(best, d);
          continue;
        }
        if (m >= plan.steps.length) continue;
        const nd = d + Math.max(0, guaranteedWait(plan.steps[m].block, p));
        if (nd < (dist.get(m) ?? Infinity) && nd < 100 * 86_400) {
          dist.set(m, nd);
          queue.push([nd, m]);
        }
      }
    }
  }
  return best;
}

const hasAbs = (b: ScenarioBlock): boolean => {
  const specs: (AmountSpec | undefined)[] = b.type === "buy" ? [b.zec] : b.type === "sell" || b.type === "swap" ? [b.amount] : b.type === "dca" ? [b.total] : [];
  return specs.some((a) => !!a && "abs" in a);
};

/** Issues the server itself would answer (everything but "client"). */
export const serverIssues = (c: PlanCheck) => c.issues.filter((x) => x.kind !== "client");
