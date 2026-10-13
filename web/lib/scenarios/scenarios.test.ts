// Scenario plan validator (structure, limits, privacy rules P1/P2/P8), floors on the chain, templates and the
// draft model (stable uids -> plan ids). DRAFT v0.19; to be re-run against core/testdata/scenario-vectors.json.

import { describe, expect, it } from "vitest";
import { base58 } from "@scure/base";
import vectors from "@/lib/crypto/testdata/ua-vectors.json";
import type { ScenarioBlock, ScenarioPlan, ScenarioStep } from "@/lib/api/types";
import { DEFAULT_SCENARIO_PARAMS, defaultBlock, formatRange, formatSecs } from "./catalog";
import { emptyDraft, insertStep, moveStep, removeStep, toPlan, fromPlan } from "./draft";
import { planTotals } from "./describe";
import { draftFromTemplate, TEMPLATES } from "./templates";
import { validatePlan, type TokenFacts, type ValidateCtx } from "./validate";

const addr = (seed: number) => base58.encode(new Uint8Array(32).map((_, i) => (seed * 31 + i * 7 + 1) & 255));
const PEPE = addr(1); // pump.fun, priced
const DBC = addr(2); // Meteora, priced
const LAB = addr(3); // LaunchLab: no price tick
const ZECPAIR = addr(4); // pump.fun ZEC pair: no tick
const BONK = addr(5); // pump.fun, priced
const UNKNOWN = addr(9);
const WALLET_A = addr(20);
const UA = vectors.unified.find((v) => v.orchard && !v.unknownTypecode)!.ua;
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const H = 3600;

const TOKENS: Record<string, TokenFacts> = {
  [PEPE]: { mint: PEPE, symbol: "PEPE", decimals: 6, venue: "pumpfun", quote: "SOL", status: "curve", priced: true },
  [DBC]: { mint: DBC, symbol: "MET", decimals: 9, venue: "meteora-dbc", quote: "SOL", status: "curve", priced: true },
  [LAB]: { mint: LAB, symbol: "LAB", decimals: 6, venue: "raydium-launchlab", quote: "SOL", status: "curve", priced: false },
  [BONK]: { mint: BONK, symbol: "BONK", decimals: 6, venue: "pumpfun", quote: "SOL", status: "curve", priced: true },
  [ZECPAIR]: { mint: ZECPAIR, symbol: "ZP", decimals: 6, venue: "pumpfun", quote: "ZEC", status: "curve", priced: false },
};

const ctx: ValidateCtx = {
  params: DEFAULT_SCENARIO_PARAMS,
  now: NOW,
  network: "mainnet",
  minDepositZat: "1000000",
  minActionZat: "100000",
  venues: ["pumpfun", "meteora-dbc", "raydium-launchlab", "jupiter"],
  features: { chat: true },
  priced: (m) => !!TOKENS[m]?.priced,
  token: (m) => TOKENS[m] ?? null,
};

const plan = (blocks: (ScenarioBlock | [ScenarioBlock, ScenarioStep["onFail"]])[], ttlSecs = 24 * H): ScenarioPlan => ({
  v: 1,
  ttlSecs,
  steps: blocks.map((b, id) => (Array.isArray(b) ? { id, block: b[0], onFail: b[1] } : { id, block: b })),
});

const buy = (over: Partial<Extract<ScenarioBlock, { type: "buy" }>> = {}): ScenarioBlock => ({ type: "buy", venue: "pumpfun", mint: PEPE, zec: { abs: "10000000" }, guard: { slippageBps: 500 }, exec: "delayed", ...over });
const wait = (minSecs: number, maxSecs = minSecs * 2): ScenarioBlock => ({ type: "wait_random", minSecs, maxSecs });
const codes = (p: ScenarioPlan, c: ValidateCtx = ctx) => validatePlan(p, c).issues.map((i) => `${i.step}:${i.code}`);

describe("structure and limits", () => {
  it("accepts a plain plan", () => {
    const r = validatePlan(plan([{ type: "manual_start" }, buy(), wait(H), { type: "sell_all", venue: "pumpfun", mint: PEPE, guard: { slippageBps: 500 }, exec: "delayed" }]), ctx);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("caps blocks at 12 and runs at 40", () => {
    const many = Array.from({ length: 13 }, () => wait(60));
    expect(codes(plan(many))).toContain("-1:too_many_steps");
    const dca: ScenarioBlock = { type: "dca", side: "buy", venue: "pumpfun", mint: PEPE, total: { abs: "100000000" }, slices: 12, everySecs: { min: 600, max: 600 }, guard: { slippageBps: 500 }, exec: "delayed" };
    // 12 slices × 4 rounds = 48 > 40
    expect(codes(plan([dca, wait(60), { type: "repeat", from: 0, times: 4 }], 72 * H))).toContain("-1:too_many_runs");
  });

  it("checks the TTL: 1–72 h, up to 7 days only without a withdrawal", () => {
    expect(codes(plan([wait(60)], 1800))).toContain("-1:bad_ttl");
    expect(codes(plan([wait(60)], 7 * 24 * H))).toEqual([]);
    expect(codes(plan([{ type: "withdraw_zec", to: UA, amount: { pct: 100, of: "balance" }, exec: "max" }], 7 * 24 * H))).toContain("-1:bad_ttl");
  });

  it("keeps waits inside the plan's TTL (bad_range)", () => {
    expect(codes(plan([wait(20 * H, 25 * H)], 24 * H))).toContain("0:bad_range");
    expect(codes(plan([{ type: "wait_fixed", secs: 10 }]))).toContain("0:bad_range");
    expect(codes(plan([{ type: "wait_random", minSecs: 600, maxSecs: 600 }]))).toContain("0:bad_range");
  });

  it("allows manual start only first and one deposit trigger", () => {
    expect(codes(plan([wait(60), { type: "manual_start" }]))).toContain("1:manual_start_not_first");
    expect(codes(plan([{ type: "deposit_received", minZat: "1000000" }, { type: "deposit_received", minZat: "1000000" }]))).toContain("1:deposit_twice");
    expect(codes(plan([{ type: "deposit_received", minZat: "10" }]))).toContain("0:bad_amount");
  });

  it("lets goto and onFail jump only forward", () => {
    expect(codes(plan([wait(60), [buy(), { goto: 0 }]]))).toContain("1:bad_goto");
    expect(codes(plan([[buy(), { retry: 2, then: { goto: 2 } }], wait(60), { type: "end" }]))).toEqual([]);
    expect(codes(plan([[buy(), { retry: 4 as 3, then: "skip" }]]))).toContain("0:bad_on_fail");
  });

  it("repeat goes back only, 2–10 rounds, never over a start, deposit, launch or sealed step", () => {
    expect(codes(plan([buy(), wait(60), { type: "repeat", from: 0, times: 3 }]))).toEqual([]);
    expect(codes(plan([buy(), { type: "repeat", from: 1, times: 3 }]))).toContain("1:bad_repeat");
    expect(codes(plan([buy(), { type: "repeat", from: 0, times: 11 }]))).toContain("1:bad_repeat");
    expect(codes(plan([{ type: "deposit_received", minZat: "1000000" }, buy(), { type: "repeat", from: 0, times: 2 }]))).toContain("2:bad_repeat");
    // a sealed step can't run twice: its address / text is deleted after the first use
    const sealed = validatePlan(plan([wait(60), { type: "withdraw_zec", to: UA, amount: { pct: 10, of: "balance" }, exec: "max" }, { type: "repeat", from: 0, times: 2 }]), ctx);
    expect(sealed.issues).toEqual([expect.objectContaining({ step: 2, code: "bad_repeat", kind: "invalid" })]);
  });

  it("references point to earlier steps of the right kind and unit", () => {
    // buy with the tokens of another buy: wrong unit
    expect(codes(plan([buy(), buy({ zec: { pct: 50, of: { step: 0 } } })]))).toContain("1:bad_ref");
    // own_result needs an earlier order_place
    expect(codes(plan([buy(), { type: "own_result", ref: { step: 0 }, on: "any" }]))).toContain("1:bad_ref");
    // a reference to a later step
    expect(codes(plan([buy({ zec: { pct: 50, of: { step: 1 } } }), { type: "deposit_received", minZat: "1000000" }]))).toContain("0:bad_ref");
  });

  it("rejects a block of a feature that is off as bad_request / feature_disabled", () => {
    const off = { ...ctx, features: {} };
    const r = validatePlan(plan([{ type: "chat", mint: PEPE, text: "gm" }]), off);
    expect(r.issues[0]).toMatchObject({ code: "feature_disabled", kind: "bad_request" });
    expect(validatePlan(plan([{ type: "fl" + "_bid" } as unknown as ScenarioBlock]), ctx).issues[0]).toMatchObject({ code: "feature_disabled", kind: "bad_request" });
    expect(validatePlan(plan([{ type: "teleport" } as unknown as ScenarioBlock]), ctx).issues[0]).toMatchObject({ code: "unknown_block", kind: "invalid" });
  });

  it("withdrawals are never instant and need valid, distinct addresses", () => {
    expect(codes(plan([{ type: "withdraw_zec", to: UA, amount: { pct: 100, of: "balance" }, exec: "now" as "max" }]))).toContain("0:bad_exec");
    expect(codes(plan([{ type: "withdraw_zec", to: "t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU", amount: { pct: 100, of: "balance" }, exec: "max" }]))).toContain("0:bad_address");
    const smart: ScenarioBlock = { type: "withdraw_token", mint: PEPE, amount: { pct: 100, of: "balance" }, to: [WALLET_A, WALLET_A], smart: { parts: 2, maxDelayMin: 30 }, exec: "max" };
    expect(codes(plan([smart]))).toContain("0:bad_address");
  });
});

describe("privacy rules (422 scenario_rule)", () => {
  it("P1: Now only on step 1 right after manual start", () => {
    expect(codes(plan([buy({ exec: "now" })]))).toContain("0:now_not_first");
    expect(codes(plan([{ type: "manual_start" }, buy({ exec: "now" })]))).toEqual([]);
    const r = validatePlan(plan([{ type: "deposit_received", minZat: "1000000" }, buy({ exec: "now" })]), ctx);
    expect(r.issues[0]).toMatchObject({ step: 1, code: "now_not_first", kind: "rule" });
    expect(r.issues[0].message).toMatch(/^Now only right after manual start/);
    // a Now step that a repeat runs again is no longer "right after start"
    expect(codes(plan([{ type: "manual_start" }, buy({ exec: "now" }), wait(60), { type: "repeat", from: 1, times: 2 }]))).toContain("1:now_not_first");
    // and never on swap / DCA
    expect(codes(plan([{ type: "swap", from: PEPE, to: DBC, amount: { pct: 100, of: "balance" }, guardSell: { slippageBps: 500 }, guardBuy: { slippageBps: 500 }, exec: "now" as "delayed" }]))).toContain("0:bad_exec");
  });

  it("P2: token withdrawal needs a ≥1 h wait after a trade of that mint", () => {
    const wd: ScenarioBlock = { type: "withdraw_token", mint: PEPE, amount: { pct: 100, of: "balance" }, to: WALLET_A, exec: "max" };
    const r = validatePlan(plan([buy(), wait(600, 1200), wd]), ctx);
    expect(r.issues).toContainEqual(expect.objectContaining({ step: 2, code: "withdraw_too_soon", kind: "rule" }));
    expect(r.issues.find((x) => x.code === "withdraw_too_soon")!.message).toMatch(/^Withdraw waits ≥1 h after the trade/);
    const ok = validatePlan(plan([buy(), wait(H, 2 * H), wd]), ctx);
    expect(ok.issues).toEqual([]);
    expect(ok.floors).toContainEqual(expect.objectContaining({ step: 2, code: "withdraw_after_trade" }));
    expect(ok.warnings).toContainEqual(expect.objectContaining({ step: 2, code: "withdraw_soon" })); // < 12 h
    // another mint: no rule
    expect(codes(plan([buy({ mint: DBC, venue: "meteora-dbc" }), wd]))).toEqual([]);
    // a token launched in the plan: the create counts as the trade
    const create: ScenarioBlock = { type: "create", create: { venue: "pumpfun", meta: { name: "Ghost", symbol: "GHOST" }, exec: "delayed", quote: "SOL" } };
    expect(codes(plan([create, { ...wd, mint: { step: 0 }, amount: { pct: 100, of: { step: 0 } } }]))).toContain("1:withdraw_too_soon");
    // shielded ZEC withdrawals are not subject to it
    expect(codes(plan([buy(), { type: "withdraw_zec", to: UA, amount: { pct: 100, of: "balance" }, exec: "max" }]))).toEqual([]);
  });

  it("P2 holds on every path: goto, repeat, swap and orders count", () => {
    const wd: ScenarioBlock = { type: "withdraw_token", mint: PEPE, amount: { pct: 100, of: "balance" }, to: WALLET_A, exec: "max" };
    // a goto from the buy skips the long wait
    expect(codes(plan([[buy(), { goto: 2 }], wait(H, 2 * H), wd]))).toContain("2:withdraw_too_soon");
    // check_safety can jump past the wait too
    const check: ScenarioBlock = { type: "check_safety", mint: PEPE, require: { authoritiesRevoked: true }, onFalse: { goto: 3 } };
    expect(codes(plan([buy(), check, wait(H, 2 * H), wd]))).toContain("3:withdraw_too_soon");
    // waits add up along the path (v0.19): 2 × 30 min is enough, 2 × 20 min is not
    expect(codes(plan([buy(), wait(1800, 2400), wait(1800, 2400), wd]))).toEqual([]);
    expect(codes(plan([buy(), wait(1200, 2400), wait(1200, 2400), wd]))).toContain("3:withdraw_too_soon");
    // a rotation into the mint is a trade of it
    const swap: ScenarioBlock = { type: "swap", from: DBC, to: PEPE, amount: { pct: 100, of: "balance" }, guardSell: { slippageBps: 500 }, guardBuy: { slippageBps: 500 }, exec: "delayed" };
    expect(codes(plan([swap, wd]))).toContain("1:withdraw_too_soon");
    // an order on the mint is a trade of it (its fill is public)
    const order: ScenarioBlock = { type: "order_place", order: { venue: "pumpfun", kind: "take_profit", mint: PEPE, amount: { pct: 100, of: "balance" }, triggerPriceSol: "1", exec: "delayed" } };
    expect(codes(plan([order, { type: "own_result", ref: { step: 0 }, on: "any" }, wd]))).toContain("2:withdraw_too_soon");
    expect(codes(plan([order, { type: "own_result", ref: { step: 0 }, on: "any" }, wait(H, 2 * H), wd]))).toEqual([]);
  });

  it("P8: price triggers and slippage only on mints with a price tick", () => {
    expect(codes(plan([{ type: "price_cross", mint: LAB, op: "gte", priceSol: "0.001" }]))).toContain("0:unpriced_mint");
    expect(codes(plan([{ type: "price_cross", mint: UNKNOWN, op: "gte", priceSol: "0.001" }]))).toContain("0:unpriced_mint");
    expect(codes(plan([buy({ mint: ZECPAIR })]))).toContain("0:unpriced_mint");
    // limitPrice is fine for any mint
    expect(codes(plan([buy({ mint: LAB, venue: "raydium-launchlab", guard: { limitPrice: "0.00001" } })]))).toEqual([]);
    // a mint launched by the plan on pump.fun / SOL has a tick
    const create: ScenarioBlock = { type: "create", create: { venue: "pumpfun", meta: { name: "Ghost", symbol: "GHOST" }, exec: "delayed", quote: "SOL" } };
    expect(codes(plan([create, wait(60), { type: "curve_progress", mint: { step: 0 }, gtePct: 50 }]))).toEqual([]);
    // API.md v0.19: any mint the plan launches itself is allowed (the server prices it from its own launch).
    expect(codes(plan([{ ...create, create: { ...(create as Extract<ScenarioBlock, { type: "create" }>).create, venue: "raydium-launchlab" } }, { type: "price_cross", mint: { step: 0 }, op: "gte", priceSol: "1" }]))).toEqual([]);
  });
});

describe("floors on the chain", () => {
  it("names every server floor where it applies", () => {
    const r = validatePlan(
      plan([
        { type: "deposit_received", minZat: "1000000" },
        buy(),
        { type: "sell", venue: "pumpfun", mint: PEPE, amount: { pct: 50, of: "balance" }, guard: { slippageBps: 500 }, exec: "delayed" },
        { type: "wait_fixed", secs: H },
        { type: "time_at", at: NOW + 2 * H * 1000 },
        { type: "swap", from: PEPE, to: DBC, amount: { pct: 100, of: "balance" }, guardSell: { slippageBps: 500 }, guardBuy: { slippageBps: 500 }, exec: "delayed" },
        { type: "chat", mint: DBC, text: "gm" },
      ]),
      ctx,
    );
    expect(r.issues).toEqual([]);
    const f = Object.fromEntries(r.floors.map((x) => [x.code, x]));
    expect(f.after_deposit).toMatchObject({ step: 0, text: "After a deposit: random 10–40 min" });
    expect(f.trade_gap).toMatchObject({ step: 2 });
    expect(f.fixed_jitter.step).toBe(3);
    expect(f.time_jitter.step).toBe(4);
    expect(f.swap_gap.step).toBe(5);
    expect(f.chat_after_trade.step).toBe(6);
  });

  it("marks Now after manual start", () => {
    const r = validatePlan(plan([{ type: "manual_start" }, buy({ exec: "now" })]), ctx);
    expect(r.floors).toContainEqual({ step: 1, code: "now_after_start", text: "Now only right after manual start" });
  });

  it("formats durations", () => {
    expect(formatSecs(5400)).toBe("1 h 30 min");
    expect(formatRange(600, 2400)).toBe("10–40 min");
    expect(formatRange(1200, 5400)).toBe("20 min – 1 h 30 min");
  });
});

describe("templates", () => {
  const seed = { mint: PEPE, venue: "pumpfun" as const, priceSol: "0.00003", mintB: BONK, venueB: "pumpfun" as const, priceSolB: "0.0000005", minDepositZat: "1000000" };

  it("all four exist with the spec's names and TTLs", () => {
    expect(TEMPLATES.map((t) => [t.name, t.ttlSecs])).toEqual([
      ["Private buy & exit", 72 * H],
      ["Launch & take profit", 72 * H],
      ["DCA in", 72 * H],
      ["Rotate", 24 * H],
    ]);
  });

  it("use only random waits and delayed / max (behavioural k-anonymity)", () => {
    for (const t of TEMPLATES) {
      const p = toPlan(draftFromTemplate(t, seed));
      for (const s of p.steps) {
        expect(s.block.type).not.toBe("wait_fixed");
        const exec = "exec" in s.block ? s.block.exec : s.block.type === "order_place" ? s.block.order.exec : s.block.type === "create" ? s.block.create.exec : undefined;
        if (exec !== undefined) expect(["delayed", "max"]).toContain(exec);
      }
    }
  });

  it("fill a valid chain once the user adds what only they know", () => {
    const fill = (p: ScenarioPlan): ScenarioPlan => ({
      ...p,
      steps: p.steps.map((s) =>
        s.block.type === "withdraw_zec"
          ? { ...s, block: { ...s.block, to: UA } }
          : s.block.type === "create"
            ? { ...s, block: { ...s.block, create: { ...s.block.create, meta: { name: "Ghost", symbol: "GHOST" } } } }
            : s,
      ),
    });
    for (const t of TEMPLATES) {
      const r = validatePlan(fill(toPlan(draftFromTemplate(t, seed))), ctx);
      expect([t.id, r.issues]).toEqual([t.id, []]);
    }
  });

  it("Private buy & exit: deposit floor, bracket from the buy, shielded exit", () => {
    const p = toPlan(draftFromTemplate(TEMPLATES[0], seed));
    expect(p.steps.map((s) => s.block.type)).toEqual(["deposit_received", "wait_random", "check_safety", "buy", "order_place", "own_result", "wait_random", "withdraw_zec"]);
    const bracket = p.steps[4].block as Extract<ScenarioBlock, { type: "order_place" }>;
    expect(bracket.order).toMatchObject({ kind: "bracket", tpPriceSol: "0.00006", slPriceSol: "0.000018", amount: { pct: 100, of: { step: 3 } } });
  });

  it("Launch & take profit waits out the 24 h creator lock", () => {
    const p = toPlan(draftFromTemplate(TEMPLATES[1], seed));
    const w = p.steps[1].block as Extract<ScenarioBlock, { type: "wait_random" }>;
    expect(w.minSecs).toBeGreaterThan(24 * H);
  });

  it("totals count repeats and fees", () => {
    const p = plan([buy(), wait(60), { type: "repeat", from: 0, times: 3 }, { type: "withdraw_zec", to: UA, amount: { pct: 100, of: "balance" }, exec: "max" }]);
    const t = planTotals(p, null, () => null);
    expect(t.fixedZat).toBe(BigInt(30_000_000));
    expect(t.fees.find((f) => f.label === "Shielded payout fee")?.zat).toBe(BigInt(15_000));
    expect(t.shares).toEqual(["Step 4: all your ZEC"]);
  });
});

describe("draft model", () => {
  it("keeps references when steps move, and breaks them visibly when the target is removed", () => {
    let d = emptyDraft(24 * H, NOW);
    ({ draft: d } = insertStep(d, buy()));
    const w = insertStep(d, wait(H));
    d = w.draft;
    const wUid = w.uid;
    ({ draft: d } = insertStep(d, { type: "sell", venue: "pumpfun", mint: PEPE, amount: { pct: 100, of: { step: 0 } }, guard: { slippageBps: 500 }, exec: "delayed" }));
    ({ draft: d } = insertStep(d, { type: "repeat", from: 0, times: 2 }));
    // move the wait to the end: the sell's { step: uid 0 } still points at the buy
    d = moveStep(d, wUid, 3);
    const p = toPlan(d);
    expect(p.steps.map((s) => s.block.type)).toEqual(["buy", "sell", "repeat", "wait_random"]);
    expect((p.steps[1].block as Extract<ScenarioBlock, { type: "sell" }>).amount).toEqual({ pct: 100, of: { step: 0 } });
    expect((p.steps[2].block as Extract<ScenarioBlock, { type: "repeat" }>).from).toBe(0);
    // remove the buy: both references become -1 and the validator says so
    d = removeStep(d, 0);
    const broken = toPlan(d);
    expect((broken.steps[0].block as Extract<ScenarioBlock, { type: "sell" }>).amount).toEqual({ pct: 100, of: { step: -1 } });
    expect(codes(broken)).toEqual(expect.arrayContaining(["0:bad_ref", "1:bad_repeat"]));
  });

  it("round-trips through a plan", () => {
    const d = draftFromTemplate(TEMPLATES[0], {});
    const p = toPlan(d);
    expect(toPlan(fromPlan(p, { id: "x", name: "n", updatedAt: 0 }))).toEqual(p);
  });

  it("new blocks start with sane defaults", () => {
    const b = defaultBlock("wait_random");
    expect(b).toEqual({ type: "wait_random", minSecs: 1200, maxSecs: 5400 });
    expect(defaultBlock("withdraw_zec")).toMatchObject({ exec: "max" });
  });
});
