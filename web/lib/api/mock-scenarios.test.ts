// Mock of the DRAFT v0.19 scenario executor through the real mock API: body sizes, validation codes, limits,
// manual start, floors on the compressed clock, onFail, cancel / stop all (with the plan's orders), expiry,
// and the masked echo in Portfolio.scenarios.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bech32m } from "@scure/base";
import { signRequest, signerFromSecret } from "@/lib/crypto/sign";
import { unz1MemoString } from "@/lib/crypto/unz1";
import { depositFields, depositUri, poolChainId } from "@/lib/deposit";
import { padExact, padScenario } from "@/lib/pad";
import { f4jumble } from "@/lib/zcash/ua";
import type { ActionReceipt, Portfolio, Scenario, ScenarioBlock, ScenarioPlan, SignedAction, Token } from "./types";
import { handle, mockPay, mockPool } from "./mock";
import { MOCK_SCENARIO_SCALE } from "./mock-scenarios";

let SK = crypto.getRandomValues(new Uint8Array(32));
let signer = signerFromSecret(SK);
beforeEach(() => {
  vi.useFakeTimers({ now: 1_760_600_000_000 });
  SK = crypto.getRandomValues(new Uint8Array(32));
  signer = signerFromSecret(SK);
});
afterEach(() => vi.useRealTimers());

function encodeUa(hrp: string): string {
  const parts = [2, 43, ...new Uint8Array(43).fill(9), 3, 43, ...new Uint8Array(43).fill(7)];
  const pad = new Uint8Array(16);
  pad.set(Array.from(hrp, (c) => c.charCodeAt(0)));
  return bech32m.encode(hrp, bech32m.toWords(f4jumble(new Uint8Array([...parts, ...pad]))), false);
}
const UA = encodeUa("utest");

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const b = body === undefined ? undefined : JSON.stringify(body);
  const h = signRequest(signer, { chainId: "0202", method, pathWithQuery: path, body: b });
  const p = handle("devnet", method, path, b, h);
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(500);
  return (await p) as T;
}
const portfolio = () => call<Portfolio>("GET", "/api/portfolio");
const post = (a: SignedAction, pad: "scenario" | "exact" | "none" = a.op === "scenario_create" ? "scenario" : "exact") =>
  call<ActionReceipt>("POST", "/api/actions", pad === "scenario" ? padScenario(a) : pad === "exact" ? padExact(a) : a);
const createPlan = (steps: ScenarioBlock[], ttlSecs = 24 * 3600, onFail?: Record<number, ScenarioPlan["steps"][number]["onFail"]>) =>
  post({ op: "scenario_create", plan: { v: 1, ttlSecs, steps: steps.map((block, id) => ({ id, block, ...(onFail?.[id] ? { onFail: onFail[id] } : {}) })) } });
const scenarioOf = async (id: string): Promise<Scenario> => (await portfolio()).scenarios!.find((s) => s.id === id)!;

async function fund(zat: string) {
  const pool = mockPool("devnet");
  const memo = unz1MemoString(depositFields(Math.floor(Date.now() / 1000)), SK, poolChainId(pool, "devnet"));
  mockPay("devnet", depositUri(pool, zat, memo));
  await vi.advanceTimersByTimeAsync(20_000);
}

async function pumpToken(): Promise<Token> {
  return (await call<Token[]>("GET", "/api/tokens")).find((t) => t.venue === "pumpfun" && t.status === "curve" && t.quote === "SOL")!;
}

/** Run the executor for `ms` of demo time, polling like the portfolio loop does. */
async function run(ms: number, step = 2_000) {
  // Each poll itself takes 500 ms of the fake clock.
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(step - 500);
    await portfolio();
  }
}

const H = 3600;
const planMs = (secs: number) => (secs * 1000) / MOCK_SCENARIO_SCALE;

describe("mock v0.19 scenarios: API surface", () => {
  it("PoolInfo carries the flag and the published floors", () => {
    const p = mockPool("devnet");
    expect(p.features?.scenarios).toBe(true);
    expect(p.scenarios).toMatchObject({ maxSteps: 12, maxRuns: 40, maxActivePerKey: 3, ttlSecs: { min: 3600, max: 259_200, default: 86_400 } });
    expect(p.scenarios!.floors.afterDepositSecs).toEqual([600, 2400]);
    expect(p.scenarios!.blocks.some((b) => b.startsWith("fl"))).toBe(false);
  });

  it("bodies are fixed size: create 16 KiB, start / cancel 1 KiB", async () => {
    const plan: ScenarioPlan = { v: 1, steps: [{ id: 0, block: { type: "wait_random", minSecs: 60, maxSecs: 120 } }] };
    await expect(post({ op: "scenario_create", plan }, "none")).rejects.toMatchObject({ code: "bad_request" });
    expect(JSON.stringify(padScenario({ op: "scenario_create", plan })).length).toBe(16_384);
    const r = await post({ op: "scenario_create", plan });
    expect(r).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}$/), status: "active" });
    await expect(post({ op: "scenario_cancel", id: r.id }, "none")).rejects.toMatchObject({ code: "bad_request" });
  });

  it("answers scenario_invalid / scenario_rule with the step and code", async () => {
    const t = await pumpToken();
    await expect(createPlan([{ type: "wait_fixed", secs: 5 }])).rejects.toMatchObject({ code: "scenario_invalid", status: 400, details: { step: 0, code: "bad_range" } });
    await expect(
      createPlan([{ type: "deposit_received", minZat: "1000000" }, { type: "buy", venue: "pumpfun", mint: t.mint, zec: { abs: "1000000" }, guard: { slippageBps: 500 }, exec: "now" }]),
    ).rejects.toMatchObject({ code: "scenario_rule", status: 422, details: { step: 1, code: "now_not_first" } });
  });

  it("at most 3 active plans per key; replaces swaps one atomically", async () => {
    const w: ScenarioBlock = { type: "wait_random", minSecs: H, maxSecs: 2 * H };
    const a = await createPlan([w]);
    await createPlan([w]);
    await createPlan([w]);
    await expect(createPlan([w])).rejects.toMatchObject({ code: "scenario_limit", status: 422 });
    const b = await post({ op: "scenario_create", plan: { v: 1, steps: [{ id: 0, block: w }] }, replaces: a.id });
    // v0.21: at most 3 listed, active first — the replaced (cancelled) plan drops out of the capped list.
    const p = await portfolio();
    expect(p.scenarios!.map((s) => s.status)).toEqual(["active", "active", "active"]);
    expect(p.scenarios!.some((s) => s.id === b.id)).toBe(true);
    expect(p.scenarios!.some((s) => s.id === a.id)).toBe(false);
    expect(p.more?.scenarios).toBe(1);
  });

  it("manual start: waiting_start until started once", async () => {
    const r = await createPlan([{ type: "manual_start" }, { type: "wait_random", minSecs: H, maxSecs: 2 * H }]);
    expect(r.status).toBe("waiting_start");
    expect((await scenarioOf(r.id)).steps[0].status).toBe("waiting");
    expect(await post({ op: "scenario_start", id: r.id })).toEqual({ id: r.id, status: "active" });
    const s = await scenarioOf(r.id);
    expect(s.status).toBe("active");
    expect(s.steps.map((x) => x.status)).toEqual(["done", "waiting"]);
    await expect(post({ op: "scenario_start", id: r.id })).rejects.toMatchObject({ code: "scenario_not_active", status: 409 });
  });

  it("v0.20: Portfolio carries no plan at all, so no address or fragment of one", async () => {
    const r = await createPlan([{ type: "manual_start" }, { type: "withdraw_zec", to: UA, amount: { pct: 100, of: "balance" }, exec: "max" }]);
    const s = await scenarioOf(r.id);
    expect(s.plan).toBeUndefined();
    expect(s.steps).toHaveLength(2);
    const text = JSON.stringify(await portfolio());
    expect(text).not.toContain(UA);
    expect(text).not.toContain(UA.slice(-4));
  });
});

describe("mock v0.19 scenarios: executor on the compressed clock", () => {
  it("deposit → floor 10–40 min → buy → wait → token withdrawal", async () => {
    const t = await pumpToken();
    const fresh = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const r = await createPlan([
      { type: "deposit_received", minZat: "5000000" },
      { type: "buy", venue: "pumpfun", mint: t.mint, zec: { pct: 90, of: { step: 0 } }, guard: { slippageBps: 3000 }, exec: "delayed" },
      { type: "wait_random", minSecs: H, maxSecs: 2 * H },
      { type: "withdraw_token", mint: t.mint, amount: { pct: 100, of: { step: 1 } }, to: fresh, exec: "max" },
    ], 24 * H);
    await run(6_000);
    // Armed, but a deposit made before nothing; still waiting.
    expect((await scenarioOf(r.id)).steps[0].status).toBe("waiting");
    const t0 = Date.now();
    await fund("20000000");
    const s0 = await scenarioOf(r.id);
    // P3: the trigger fires 10–40 min (plan time) after the credit, not at once.
    expect(s0.steps[0].status).toBe("waiting");
    expect(s0.steps[0].nextAt! - t0).toBeGreaterThanOrEqual(planMs(600) - 1);
    expect(s0.steps[0].nextAt! - t0).toBeLessThanOrEqual(planMs(2400) + 21_000);
    await run(planMs(2400) + 40_000);
    const s1 = await scenarioOf(r.id);
    expect(s1.steps[0].status).toBe("done");
    expect(s1.steps[1].status).toBe("done");
    const p = await portfolio();
    const bought = p.actions!.find((a) => a.id === s1.steps[1].actionId)!;
    expect(bought.kind).toBe("buy");
    expect(bought.fill!.zecSpent).toBe("18000000"); // 90 % of the 0.2 ZEC deposit
    // Wait (≥1 h plan time) then the withdrawal, through the same path as a manual one.
    await run(planMs(2 * H + 1800) + 80_000);
    const s2 = await scenarioOf(r.id);
    expect(s2.steps.map((x) => x.status)).toEqual(["done", "done", "done", "done"]);
    expect(s2.status).toBe("done");
    const wd = (await portfolio()).actions!.find((a) => a.id === s2.steps[3].actionId)!;
    expect(wd.kind).toBe("withdraw_token");
    // The sealed address is gone from the echo.
    expect(JSON.stringify(s2)).not.toContain(fresh);
  });

  it("onFail: skip goes on, stop fails the plan with the step's error", async () => {
    const t = await pumpToken();
    const b: ScenarioBlock = { type: "buy", venue: "pumpfun", mint: t.mint, zec: { abs: "50000000" }, guard: { slippageBps: 500 }, exec: "delayed" };
    const skip = await createPlan([b, { type: "end" }], 24 * H, { 0: "skip" });
    const stop = await createPlan([b, { type: "end" }]);
    await run(4_000);
    const a = await scenarioOf(skip.id);
    expect(a.steps.map((x) => x.status)).toEqual(["skipped", "done"]);
    expect(a.steps[0].error).toBe("insufficient_balance");
    expect(a.status).toBe("done");
    const z = await scenarioOf(stop.id);
    expect(z.status).toBe("failed");
    expect(z.error).toBe("insufficient_balance");
  });

  it("cancel closes the plan's open orders and frees their hold; stop all", async () => {
    await fund("30000000");
    const t = await pumpToken();
    const order: ScenarioBlock = { type: "order_place", order: { venue: "pumpfun", kind: "limit_buy", mint: t.mint, amount: { abs: "5000000" }, triggerPriceSol: "0.000000000001", exec: "delayed", ttlSecs: 6 * H } };
    const r = await createPlan([order, { type: "own_result", ref: { step: 0 }, on: "filled" }]);
    await run(2_000);
    const s = await scenarioOf(r.id);
    expect(s.steps[0].status).toBe("done");
    const p = await portfolio();
    const o = p.orders!.find((x) => x.id === s.steps[0].orderId)!;
    expect(o.status).toBe("open");
    expect(p.zecHeld).toBe("5000000");
    expect(await post({ op: "scenario_cancel", id: r.id })).toEqual({ id: r.id, status: "cancelled" });
    const after = await portfolio();
    expect(after.orders!.find((x) => x.id === o.id)!.status).toBe("cancelled");
    expect(after.zecHeld).toBe("0");
    await expect(post({ op: "scenario_cancel", id: r.id })).rejects.toMatchObject({ code: "scenario_not_active" });

    const w: ScenarioBlock = { type: "wait_random", minSecs: H, maxSecs: 2 * H };
    await createPlan([w]);
    await createPlan([{ type: "manual_start" }, w]);
    const all = (await post({ op: "scenario_cancel", all: true })) as ActionReceipt & { ids: string[] };
    expect(all.status).toBe("cancelled");
    expect(all.ids).toHaveLength(2);
    expect((await portfolio()).scenarios!.filter((x) => x.status === "active" || x.status === "waiting_start")).toEqual([]);
  });

  it("expires after its TTL, like a cancel", async () => {
    // A trigger that never fires: the plan closes as expired at its (compressed) TTL.
    const r = await createPlan([{ type: "deposit_received", minZat: "100000000" }, { type: "end" }], H);
    await run(planMs(H) - 4_000);
    expect((await scenarioOf(r.id)).status).toBe("active");
    await run(8_000);
    const s = await scenarioOf(r.id);
    expect(s.status).toBe("expired");
    expect(s.steps[0].status).toBe("pending");
  });

  it("random waits and DCA slices never repeat a fixed rhythm", async () => {
    await fund("100000000");
    const t = await pumpToken();
    const r = await createPlan([
      { type: "dca", side: "buy", venue: "pumpfun", mint: t.mint, total: { abs: "40000000" }, slices: 4, everySecs: { min: 600, max: 1200 }, guard: { slippageBps: 3000 }, exec: "delayed" },
    ]);
    await run(planMs(4 * 1200) + 120_000);
    const s = await scenarioOf(r.id);
    expect(s.status).toBe("done");
    const ids = (await portfolio()).actions!.filter((a) => a.kind === "buy").map((a) => BigInt(a.fill?.zecSpent ?? "0"));
    expect(ids.length).toBe(4);
    expect(ids.reduce((x, y) => x + y, BigInt(0))).toBe(BigInt(40_000_000));
    // P5: slices are not equal.
    expect(new Set(ids.map(String)).size).toBeGreaterThan(1);
  });
});
