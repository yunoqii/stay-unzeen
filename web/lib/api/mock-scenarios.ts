// In-browser mock of the scenario executor (v0.19, docs/analysis/scenarios.md §2–§4). Same shape as the
// draft API: scenario_create / scenario_start / scenario_cancel through POST /api/actions, plans echoed in
// Portfolio.scenarios. Every step goes through the host's ordinary action path (the same accept / execute
// as a manual buy), so the feed, balances and orders react exactly as they would to a manual action.
//
// Time is compressed: one hour of plan time runs in MOCK_SCENARIO_SCALE-th of it (20 s by default). All
// floors (P3–P9) apply on the compressed clock. Time is injected (`now`) so tests walk through it.

import type { Network } from "@/lib/network";
import { validatePlan, type ValidateCtx } from "@/lib/scenarios/validate";
import { ApiError } from "./errors";
import type {
  ActionReceipt,
  ActionStatus,
  AmountSpec,
  Guard,
  MintRef,
  Order,
  PoolInfo,
  Scenario,
  ScenarioBlock,
  ScenarioParams,
  ScenarioPlan,
  ScenarioStatus,
  ScenarioStep,
  ScenarioStepError,
  ScenarioStepStatus,
  SignedAction,
  TokenSafety,
} from "./types";

/** 1 h of plan time = 20 s on the demo clock. */
export const MOCK_SCENARIO_SCALE = 180;
/** Delayed batch length used for P9 and retry pauses (core: 30–60 s epochs). */
const EPOCH_SECS = 45;
const KEEP_CLOSED_MS = 24 * 3_600_000;
const TRANSIENT: ReadonlySet<string> = new Set(["slippage", "pool_liquidity", "venue_unavailable", "rate_limited"]);
const N0 = BigInt(0);

export interface ScenarioHost {
  pool(network: Network): PoolInfo;
  validateCtx(network: Network, now: number): ValidateCtx;
  zecBalance(network: Network, pubkey: string): bigint;
  tokenBalance(network: Network, pubkey: string, mint: string): bigint;
  /** Sum of every credited shielded deposit of the key (not sales, not claims). */
  depositedTotal(network: Network, pubkey: string): bigint;
  frozen(network: Network, pubkey: string): boolean;
  /** The ordinary action path: validates, holds, queues. Throws ApiError like POST /api/actions would. */
  submit(network: Network, pubkey: string, action: SignedAction, now: number): ActionReceipt;
  action(id: string): ActionStatus | undefined;
  order(id: string): Order | undefined;
  /** Latest indexer tick of a pool mint. */
  priceTick(mint: string): { tick: number; priceSol: number } | null;
  curve(mint: string): { pct: number; graduated: boolean } | null;
  safety(mint: string): TokenSafety | null;
  /** minOut of a buy of `zat` under the guard (price of the current tick), token base units. */
  buyMinOut(mint: string, zat: bigint, guard: Guard): bigint;
  /** minZecOut of a sell of `amount` under the guard, zat. */
  sellMinOut(mint: string, amount: bigint, guard: Guard): bigint;
}

type Phase = "idle" | "timer" | "watch" | "inflight";

interface StepRt {
  status: ScenarioStepStatus;
  runs: number;
  phase: Phase;
  then?: "complete" | "submit";
  nextAt?: number;
  deadline?: number;
  attempt: number;
  actionId?: string;
  orderId?: string;
  error?: ScenarioStepError;
  armedTotal?: bigint;
  lastTick?: number;
  armed?: boolean;
  dca?: { slice: number; amounts: bigint[]; got: bigint; zat: bigint; ok: number };
  swap?: { leg: "sell" | "pause" | "buy"; zat?: bigint };
}

interface Out {
  zat?: bigint;
  tokens?: bigint;
  mint?: string;
}

interface Run {
  id: string;
  network: Network;
  pubkey: string;
  /** Full plan, sealed fields included; their values are dropped once the step used them or the plan closed. */
  plan: ScenarioPlan;
  sealed: Set<number>;
  status: ScenarioStatus;
  createdAt: number;
  expiresAt: number;
  cursor: number;
  steps: StepRt[];
  out: Map<number, Out>;
  rounds: Map<number, number>;
  iter: number;
  orders: Set<string>;
  /** Time-based floors (review-scenarios.md 1, 3, 4, 6): last trade per mint and of the plan, real ms. */
  lastTrade: Map<string, number>;
  lastTradeAt?: number;
  lastKind?: "buy" | "sell";
  closedAt?: number;
  error?: ScenarioStepError;
}

export interface ScenarioMock {
  params(network: Network): ScenarioParams;
  submit(network: Network, pubkey: string, action: Extract<SignedAction, { op: `scenario_${string}` }>, now: number): ActionReceipt;
  list(network: Network, pubkey: string, now: number): Scenario[];
  tick(now: number): void;
  /** Test hook: everything the mock holds for a plan (never exposed by the API). */
  inspect(id: string): Readonly<Run> | undefined;
}

const hex16 = (rnd: () => number) => Array.from({ length: 16 }, () => Math.floor(rnd() * 256).toString(16).padStart(2, "0")).join("");

export function createScenarioMock(host: ScenarioHost, params: (network: Network) => ScenarioParams, opts: { scale?: number; rnd?: () => number } = {}): ScenarioMock {
  const scale = opts.scale ?? MOCK_SCENARIO_SCALE;
  const rnd = opts.rnd ?? Math.random;
  const runs = new Map<string, Run>();
  const ms = (secs: number) => (secs * 1000) / scale;
  const U = (a: number, b: number) => a + rnd() * (b - a);

  // ---- create / start / cancel ----

  function create(network: Network, pubkey: string, plan: ScenarioPlan, replaces: string | undefined, now: number): ActionReceipt {
    const P = params(network);
    const check = validatePlan(plan, host.validateCtx(network, now));
    // Only what the server itself answers; the builder's client-only checks are not a server rule.
    const first = check.issues.find((x) => x.kind !== "client");
    if (first) {
      const details = first.step >= 0 ? { step: first.step, code: first.code } : { code: first.code };
      if (first.kind === "bad_request") throw new ApiError("bad_request", first.message, 400, details);
      if (first.kind === "rule") throw new ApiError("scenario_rule", first.message, 422, details);
      throw new ApiError("scenario_invalid", first.message, 400, details);
    }
    const own = [...runs.values()].filter((r) => r.network === network && r.pubkey === pubkey);
    const replaced = replaces === undefined ? undefined : own.find((r) => r.id === replaces);
    if (replaces !== undefined && (!replaced || !live(replaced))) throw new ApiError("scenario_not_active", "replaces: not an active plan of this key", 409);
    if (own.filter((r) => live(r) && r !== replaced).length >= P.maxActivePerKey) throw new ApiError("scenario_limit", "too many active plans", 422);
    if (replaced) close(replaced, "cancelled", now);
    const id = hex16(rnd);
    const ttl = plan.ttlSecs ?? P.ttlSecs.default;
    const waiting = plan.steps[0]?.block.type === "manual_start";
    const r: Run = {
      id,
      network,
      pubkey,
      plan: structuredClone(plan),
      sealed: new Set(plan.steps.filter((s) => isSealed(s.block)).map((s) => s.id)),
      status: waiting ? "waiting_start" : "active",
      createdAt: now,
      expiresAt: now + ms(ttl),
      cursor: 0,
      steps: plan.steps.map((): StepRt => ({ status: "pending", runs: 0, phase: "idle", attempt: 0 })),
      out: new Map(),
      rounds: new Map(),
      iter: 0,
      orders: new Set(),
      lastTrade: new Map(),
    };
    if (waiting) r.steps[0].status = "waiting";
    runs.set(id, r);
    return { id, status: r.status as ActionReceipt["status"] };
  }

  function owned(network: Network, pubkey: string, id: unknown): Run {
    const r = typeof id === "string" ? runs.get(id) : undefined;
    if (!r || r.network !== network || r.pubkey !== pubkey) throw new ApiError("not_found", "unknown scenario", 404);
    return r;
  }

  function submit(network: Network, pubkey: string, x: Extract<SignedAction, { op: `scenario_${string}` }>, now: number): ActionReceipt {
    if (x.op === "scenario_create") {
      if (!x.plan || typeof x.plan !== "object") throw new ApiError("bad_request", "plan required", 400);
      return create(network, pubkey, x.plan, x.replaces, now);
    }
    if (x.op === "scenario_start") {
      const r = owned(network, pubkey, x.id);
      if (r.status !== "waiting_start") throw new ApiError("scenario_not_active", `plan is ${r.status}`, 409);
      r.status = "active";
      complete(r, 0, now);
      step(r, now);
      return { id: r.id, status: "active" };
    }
    if ("all" in x) {
      if (x.all !== true) throw new ApiError("bad_request", "all: true", 400);
      const ids: string[] = [];
      for (const r of runs.values())
        if (r.network === network && r.pubkey === pubkey && live(r)) {
          close(r, "cancelled", now);
          ids.push(r.id);
        }
      // v0.19: { ids, status } — no single id for "all".
      return { ids, status: "cancelled" } as unknown as ActionReceipt;
    }
    const r = owned(network, pubkey, x.id);
    if (!live(r)) throw new ApiError("scenario_not_active", `plan is ${r.status}`, 409);
    close(r, "cancelled", now);
    return { id: r.id, status: "cancelled" };
  }

  // ---- executor ----

  function tick(now: number) {
    const active = [...runs.values()].filter((r) => r.status === "active" || r.status === "waiting_start");
    // Random order every pass, like the core loop (no plan is always first).
    for (let i = active.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [active[i], active[j]] = [active[j], active[i]];
    }
    for (const r of active) {
      if (now >= r.expiresAt) {
        close(r, "expired", now);
        continue;
      }
      if (r.status !== "active") continue;
      // A frozen balance (reorg) is not a step error: the cursor just waits (§2.3).
      if (host.frozen(r.network, r.pubkey)) continue;
      step(r, now);
    }
    // Retention: closed plans leave the portfolio after 24 h (D1).
    for (const [id, r] of runs) if (r.closedAt !== undefined && now - r.closedAt > KEEP_CLOSED_MS) runs.delete(id);
  }

  /** Advance one plan as far as it can go right now (instant steps chain, timed ones stop the loop). */
  function step(r: Run, now: number) {
    for (let guard = 0; guard < 16 && r.status === "active"; guard++) if (!advance(r, now)) break;
  }

  function advance(r: Run, now: number): boolean {
    if (r.cursor >= r.plan.steps.length) {
      close(r, "done", now);
      return false;
    }
    const s = r.plan.steps[r.cursor];
    const rt = r.steps[r.cursor];
    switch (rt.phase) {
      case "idle":
        return begin(r, s, rt, now);
      case "timer":
        if (now < (rt.nextAt ?? 0)) return false;
        rt.nextAt = undefined;
        rt.phase = "idle";
        if (rt.then === "complete") {
          complete(r, s.id, now);
          return true;
        }
        return execute(r, s, rt, now);
      case "watch":
        return watch(r, s, rt, now);
      case "inflight":
        return inflight(r, s, rt, now);
    }
  }

  const timer = (rt: StepRt, at: number, then: "complete" | "submit", status: ScenarioStepStatus = "waiting") => {
    rt.phase = "timer";
    rt.nextAt = at;
    rt.then = then;
    rt.status = status;
    return false;
  };

  function begin(r: Run, s: ScenarioStep, rt: StepRt, now: number): boolean {
    const b = s.block;
    const F = params(r.network).floors;
    switch (b.type) {
      case "manual_start":
        complete(r, s.id, now);
        return true;
      case "time_at": {
        // P7: the set time plus 0–10 min; the plan clock runs from creation.
        const planMs = Math.max(0, b.at - r.createdAt) + U(F.timeAtJitterSecs[0], F.timeAtJitterSecs[1]) * 1000;
        return timer(rt, r.createdAt + planMs / scale, "complete");
      }
      case "wait_fixed": {
        const j = Math.max(F.fixedWaitJitterMinSecs ?? 30, (b.secs * F.fixedWaitJitterPct) / 100);
        return timer(rt, now + ms(b.secs + U(-j, j)), "complete");
      }
      case "wait_random":
        return timer(rt, now + ms(U(b.minSecs, b.maxSecs)), "complete");
      case "deposit_received":
        rt.armedTotal = host.depositedTotal(r.network, r.pubkey);
        return arm(rt, now, b.timeoutSecs);
      case "price_cross":
      case "curve_progress":
      case "own_result":
        rt.lastTick = undefined;
        rt.armed = false;
        return arm(rt, now, b.timeoutSecs);
      case "check_safety": {
        const mint = mintOf(r, b.mint);
        const sf = mint ? host.safety(mint) : null;
        const q = b.require;
        const ok =
          !!sf &&
          (!q.authoritiesRevoked || (sf.authorities.mintRevoked && sf.authorities.freezeRevoked)) &&
          (!q.noRiskyExtensions || sf.authorities.riskyExtensions.length === 0) &&
          (q.maxTop10Pct === undefined || (!!sf.holders && Number(sf.holders.top10Pct) <= q.maxTop10Pct)) &&
          (q.maxDevPct === undefined || (!!sf.holders && Number(sf.holders.devPct ?? 0) <= q.maxDevPct)) &&
          (q.minLpBurnedPct === undefined || Number(sf.market.lpBurnedPct ?? 0) >= q.minLpBurnedPct) &&
          (q.maxSniperPct === undefined || (!!sf.firstBlocks && Number(sf.firstBlocks.sniperPct) <= q.maxSniperPct));
        if (ok) {
          complete(r, s.id, now);
          return true;
        }
        rt.runs++;
        if (b.onFalse === "stop") {
          rt.status = "failed";
          rt.error = "check_failed";
          close(r, "failed", now, "check_failed");
          return false;
        }
        rt.status = "skipped";
        jump(r, b.onFalse.goto);
        return true;
      }
      case "repeat": {
        const done = r.rounds.get(s.id) ?? 1;
        if (done < b.times) {
          r.rounds.set(s.id, done + 1);
          r.iter++;
          rt.runs++;
          for (let j = b.from; j < s.id; j++) {
            const x = r.steps[j];
            Object.assign(x, { status: "pending", phase: "idle", attempt: 0, nextAt: undefined, deadline: undefined, dca: undefined, swap: undefined, then: undefined });
          }
          r.cursor = b.from;
          return true;
        }
        complete(r, s.id, now);
        return true;
      }
      case "end":
        complete(r, s.id, now);
        close(r, "done", now);
        return false;
      case "order_place":
      case "order_cancel":
      case "claim":
        return execute(r, s, rt, now);
      default: {
        // Trade-like steps: server floors first (P2, P4, P6, P9), then the ordinary action path.
        const wait = floorSecs(r, s, F, now);
        if (wait > 0) return timer(rt, now + ms(wait), "submit");
        return execute(r, s, rt, now);
      }
    }
  }

  function arm(rt: StepRt, now: number, timeoutSecs?: number): boolean {
    rt.phase = "watch";
    rt.status = "waiting";
    rt.deadline = timeoutSecs ? now + ms(timeoutSecs) : undefined;
    return false;
  }

  /** Plan seconds since a real timestamp (compressed clock). */
  const since = (t: number | undefined, now: number) => (t === undefined ? Infinity : ((now - t) * scale) / 1000);

  /**
   * Seconds of server floors before a trade-like step, measured from the time of the actual last trade (not
   * from the neighbouring step): a gap after another step, a repeat or `of: "balance"` does not shorten it.
   */
  function floorSecs(r: Run, s: ScenarioStep, F: ScenarioParams["floors"], now: number): number {
    const b = s.block;
    let wait = 0;
    const tradeTypes = ["buy", "sell", "sell_all", "swap", "dca", "create"];
    // P9: any trade step at least 1–3 batches after the plan's last trade.
    if (tradeTypes.includes(b.type)) wait = Math.max(wait, U(F.tradeGapEpochs[0], F.tradeGapEpochs[1]) * EPOCH_SECS - since(r.lastTradeAt, now));
    // P6: a buy after the plan's last trade was a sale, whatever its amount spec.
    if (b.type === "buy" && r.lastKind === "sell") wait = Math.max(wait, U(F.swapGapSecs[0], F.swapGapSecs[1]) - since(r.lastTradeAt, now));
    // P2: ≥ 1 h + U(0, 30 min) after the last trade of this mint (order fills included).
    if (b.type === "withdraw_token") {
      const m = mintOf(r, b.mint);
      const last = m ? lastTradeOf(r, m) : undefined;
      const extra = U(F.withdrawExtraSecs[0], F.withdrawExtraSecs[1]);
      wait = Math.max(wait, last === undefined ? extra : F.withdrawAfterTradeMinSecs + extra - since(last, now));
    }
    // P4: chat after the plan's own trade of the mint: slow mode + U(10, 30 min) from that trade.
    if (b.type === "chat") {
      const m = mintOf(r, b.mint);
      const last = m ? lastTradeOf(r, m) : undefined;
      if (last !== undefined) wait = Math.max(wait, U(F.chatAfterTradeSecs[0], F.chatAfterTradeSecs[1]) - since(last, now));
    }
    return Math.max(0, wait);
  }

  /** Last trade of a mint by this plan, including fills of the orders it placed. */
  function lastTradeOf(r: Run, mint: string): number | undefined {
    let t = r.lastTrade.get(mint);
    for (const id of r.orders) {
      const o = host.order(id);
      if (!o || o.mint !== mint || !o.actionId) continue;
      const a = host.action(o.actionId);
      if (a?.status === "executed") {
        const at = a.executedAt ?? Date.now();
        t = t === undefined ? at : Math.max(t, at);
      }
    }
    return t;
  }

  function noteTrade(r: Run, mint: string | null | undefined, kind: "buy" | "sell", now: number) {
    if (mint) r.lastTrade.set(mint, now);
    r.lastTradeAt = now;
    r.lastKind = kind;
  }

  function mintOf(r: Run, ref: MintRef | undefined): string | null {
    if (ref === undefined || ref === "") return null;
    if (typeof ref === "string") return ref;
    const src = r.plan.steps[ref.step];
    if (src?.block.type === "swap") return mintOf(r, src.block.to);
    return r.out.get(ref.step)?.mint ?? null;
  }

  /** AmountSpec -> base units now. Fixed amounts get ±10 % on repeat rounds (P5). */
  function amountOf(r: Run, a: AmountSpec, unit: "zat" | { mint: string }): bigint {
    const F = params(r.network).floors;
    if ("abs" in a) {
      const v = BigInt(a.abs);
      if (r.iter === 0) return v;
      const f = 1 + U(-F.repeatJitterPct, F.repeatJitterPct) / 100;
      return BigInt(Math.max(1, Math.floor(Number(v) * f)));
    }
    let base: bigint;
    if (a.of === "balance") base = unit === "zat" ? host.zecBalance(r.network, r.pubkey) : host.tokenBalance(r.network, r.pubkey, unit.mint);
    else {
      const o = r.out.get(a.of.step);
      base = (unit === "zat" ? o?.zat : o?.tokens) ?? N0;
    }
    return (base * BigInt(a.pct)) / BigInt(100);
  }

  /** Builds the step's action from the current balance / results and sends it through the ordinary path. */
  function execute(r: Run, s: ScenarioStep, rt: StepRt, now: number): boolean {
    const b = s.block;
    const F = params(r.network).floors;
    rt.status = "running";
    try {
      const need = (m: string | null) => {
        if (!m) throw new ApiError("not_found", "mint of an earlier step is unknown", 404);
        return m;
      };
      const send = (action: SignedAction) => host.submit(r.network, r.pubkey, action, now);
      // Now is only ever the first try right after start; a retry goes in a Delayed batch (it follows a failure).
      const execOf = <E extends string>(e: E): E | "delayed" => (e === "now" && rt.attempt > 0 ? "delayed" : e);
      // A sealed value is gone once its step queued a job; a later retry cannot rebuild it.
      if (!r.sealed.has(s.id) && isSealed(b) && rt.runs + rt.attempt > 0) throw new ApiError("bad_request", "sealed field already used", 400);
      const inflightOn = (receipt: ActionReceipt) => {
        rt.actionId = receipt.id;
        rt.phase = "inflight";
        return false;
      };
      switch (b.type) {
        case "buy": {
          const mint = need(mintOf(r, b.mint));
          let zat = amountOf(r, b.zec, "zat");
          // P6: proceeds of a sale are never re-spent one to one.
          if (r.lastKind === "sell") zat = (zat * BigInt(10_000 - Math.round(U(F.swapShaveBps[0], F.swapShaveBps[1])))) / BigInt(10_000);
          return inflightOn(send({ op: "buy", venue: b.venue, mint, zecIn: zat.toString(), minOut: host.buyMinOut(mint, zat, b.guard).toString(), exec: execOf(b.exec) }));
        }
        case "sell":
        case "sell_all": {
          const mint = need(mintOf(r, b.mint));
          const amount = b.type === "sell_all" ? host.tokenBalance(r.network, r.pubkey, mint) : amountOf(r, b.amount, { mint });
          return inflightOn(send({ op: "sell", venue: b.venue, mint, amount: amount.toString(), minZecOut: host.sellMinOut(mint, amount, b.guard).toString(), exec: execOf(b.exec) }));
        }
        case "swap": {
          const from = need(mintOf(r, b.from));
          const to = need(mintOf(r, b.to));
          const venueOf = (m: string, v?: string) => (v ?? host.validateCtx(r.network, now).token?.(m)?.venue ?? "pumpfun") as Extract<SignedAction, { op: "buy" }>["venue"];
          if (!rt.swap || rt.swap.leg === "sell") {
            rt.swap = { leg: "sell" };
            const amount = amountOf(r, b.amount, { mint: from });
            return inflightOn(send({ op: "sell", venue: venueOf(from, b.venueSell), mint: from, amount: amount.toString(), minZecOut: host.sellMinOut(from, amount, b.guardSell).toString(), exec: b.exec }));
          }
          // Buy leg (P6): proceeds minus a random 2–8 %.
          const zat = ((rt.swap.zat ?? N0) * BigInt(10_000 - Math.round(U(F.swapShaveBps[0], F.swapShaveBps[1])))) / BigInt(10_000);
          rt.swap.leg = "buy";
          return inflightOn(send({ op: "buy", venue: venueOf(to, b.venueBuy), mint: to, zecIn: zat.toString(), minOut: host.buyMinOut(to, zat, b.guardBuy).toString(), exec: b.exec }));
        }
        case "dca": {
          const mint = need(mintOf(r, b.mint));
          if (!rt.dca) {
            // P5: weights ±20 %, normalized; the last slice takes the rounding rest.
            const total = amountOf(r, b.total, b.side === "buy" ? "zat" : { mint });
            const w = Array.from({ length: b.slices }, () => 1 + U(-F.dcaWeightJitterPct, F.dcaWeightJitterPct) / 100);
            const sum = w.reduce((x, y) => x + y, 0);
            const amounts = w.map((x) => BigInt(Math.floor((Number(total) * x) / sum)));
            amounts[amounts.length - 1] += total - amounts.reduce((x, y) => x + y, N0);
            rt.dca = { slice: 0, amounts, got: N0, zat: N0, ok: 0 };
          }
          const v = rt.dca.amounts[rt.dca.slice];
          const action: SignedAction =
            b.side === "buy"
              ? { op: "buy", venue: b.venue, mint, zecIn: v.toString(), minOut: host.buyMinOut(mint, v, b.guard).toString(), exec: b.exec }
              : { op: "sell", venue: b.venue, mint, amount: v.toString(), minZecOut: host.sellMinOut(mint, v, b.guard).toString(), exec: b.exec };
          return inflightOn(send(action));
        }
        case "create": {
          const { initialBuyZec, ...rest } = b.create;
          const initial = initialBuyZec ? amountOf(r, initialBuyZec, "zat") : undefined;
          const receipt = send({ op: "create", ...rest, ...(rest.exec ? { exec: execOf(rest.exec) } : {}), ...(initial !== undefined ? { initialBuyZec: initial.toString() } : {}) });
          unseal(r, s.id);
          return inflightOn(receipt);
        }
        case "withdraw_zec": {
          const receipt = send({ op: "withdraw_zec", to: b.to, amount: amountOf(r, b.amount, "zat").toString(), exec: b.exec });
          unseal(r, s.id);
          return inflightOn(receipt);
        }
        case "withdraw_token": {
          const mint = need(mintOf(r, b.mint));
          const receipt = send({ op: "withdraw_token", mint, amount: amountOf(r, b.amount, { mint }).toString(), to: b.to, ...(b.smart ? { smart: b.smart } : {}), exec: b.exec });
          unseal(r, s.id);
          return inflightOn(receipt);
        }
        case "chat": {
          const mint = need(mintOf(r, b.mint));
          send({ op: "chat", mint, text: b.text, ...(b.showCreatorBadge ? { showCreatorBadge: true } : {}), ...(lastTradeOf(r, mint) !== undefined ? { slow: true } : {}) });
          unseal(r, s.id);
          complete(r, s.id, now);
          return true;
        }
        case "order_place": {
          const { amount, mint: ref, ...rest } = b.order;
          const mint = need(mintOf(r, ref));
          const v = amountOf(r, amount, rest.kind === "limit_buy" ? "zat" : { mint });
          const receipt = send({ op: "order_create", ...rest, mint, amount: v.toString() });
          rt.orderId = receipt.id;
          r.orders.add(receipt.id);
          // Done once the order stands; waiting for it to fill is own_result's job.
          complete(r, s.id, now);
          return true;
        }
        case "order_cancel": {
          const orderId = "step" in b.ref ? r.steps[b.ref.step]?.orderId : b.ref.orderId;
          if (!orderId) throw new ApiError("not_found", "no order", 404);
          send({ op: "order_cancel", orderId });
          complete(r, s.id, now);
          return true;
        }
        case "claim": {
          const mint = b.mint === undefined || b.mint === "" ? undefined : need(mintOf(r, b.mint));
          const before = host.zecBalance(r.network, r.pubkey);
          send({ op: "claim", ...(mint ? { mint } : {}) });
          r.out.set(s.id, { zat: host.zecBalance(r.network, r.pubkey) - before });
          complete(r, s.id, now);
          return true;
        }
        default:
          complete(r, s.id, now);
          return true;
      }
    } catch (e) {
      const code = (e instanceof ApiError ? e.code : "internal") as ScenarioStepError;
      return fail(r, s, rt, code === ("network" as string) || code === ("locked" as string) ? "internal" : code, now);
    }
  }

  function watch(r: Run, s: ScenarioStep, rt: StepRt, now: number): boolean {
    const b = s.block;
    if (rt.deadline !== undefined && now >= rt.deadline) return fail(r, s, rt, "timeout", now);
    switch (b.type) {
      case "deposit_received": {
        const delta = host.depositedTotal(r.network, r.pubkey) - (rt.armedTotal ?? N0);
        if (delta < BigInt(b.minZat)) return false;
        r.out.set(s.id, { zat: delta });
        // P3: fires 10–40 min after the credit, never on a fixed offset from the Zcash block.
        const F = params(r.network).floors;
        rt.deadline = undefined;
        return timer(rt, now + ms(U(F.afterDepositSecs[0], F.afterDepositSecs[1])), "complete");
      }
      case "price_cross": {
        const mint = mintOf(r, b.mint);
        const pt = mint ? host.priceTick(mint) : null;
        if (!pt || pt.tick === rt.lastTick) return false;
        rt.lastTick = pt.tick;
        const hit = b.op === "gte" ? pt.priceSol >= Number(b.priceSol) : pt.priceSol <= Number(b.priceSol);
        if (!hit) {
          rt.armed = false;
          return false;
        }
        // Below: two ticks in a row, like a stop-loss (O4).
        if (b.op === "lte" && !rt.armed) {
          rt.armed = true;
          return false;
        }
        complete(r, s.id, now);
        return true;
      }
      case "curve_progress": {
        const mint = mintOf(r, b.mint);
        const c = mint ? host.curve(mint) : null;
        if (!c || !(c.graduated || (b.gtePct !== undefined && c.pct >= b.gtePct))) return false;
        complete(r, s.id, now);
        return true;
      }
      case "own_result": {
        const ref = b.ref;
        let state: "open" | "filled" | "failed";
        if ("actionId" in ref) {
          const a = host.action(ref.actionId);
          if (!a) return fail(r, s, rt, "not_found", now);
          state = a.status === "executed" ? "filled" : a.status === "failed" ? "failed" : "open";
        } else {
          const id = "step" in ref ? r.steps[ref.step]?.orderId : ref.orderId;
          const o = id ? host.order(id) : undefined;
          if (!o) return fail(r, s, rt, "not_found", now);
          state = o.status === "filled" ? "filled" : o.status === "open" || o.status === "triggered" ? "open" : "failed";
        }
        if (state === "open") return false;
        if (b.on === "any" || b.on === state) {
          complete(r, s.id, now);
          return true;
        }
        // Waiting for a fill of an order that closed otherwise (cancelled by hand, expired, failed).
        return fail(r, s, rt, "order_not_open", now);
      }
      default:
        return false;
    }
  }

  function inflight(r: Run, s: ScenarioStep, rt: StepRt, now: number): boolean {
    const a = rt.actionId ? host.action(rt.actionId) : undefined;
    if (!a) return fail(r, s, rt, "not_found", now);
    if (a.status === "queued" || a.status === "sent") return false;
    if (a.status === "failed") return fail(r, s, rt, (a.error ?? "internal") as ScenarioStepError, now);
    const b = s.block;
    const fill = a.fill;
    const tokens = fill?.tokenAmount ? BigInt(fill.tokenAmount) : undefined;
    const zat = fill?.zecCredited ? BigInt(fill.zecCredited) : undefined;
    rt.attempt = 0;
    // Record the trade for the time-based floors.
    if (b.type === "buy") noteTrade(r, mintOf(r, b.mint), "buy", now);
    else if (b.type === "sell" || b.type === "sell_all") noteTrade(r, mintOf(r, b.mint), "sell", now);
    else if (b.type === "create") noteTrade(r, fill?.mint, "buy", now);
    else if (b.type === "dca") noteTrade(r, mintOf(r, b.mint), b.side === "buy" ? "buy" : "sell", now);
    else if (b.type === "swap") noteTrade(r, rt.swap?.leg === "sell" ? mintOf(r, b.from) : mintOf(r, b.to), rt.swap?.leg === "sell" ? "sell" : "buy", now);
    if (b.type === "swap" && rt.swap?.leg === "sell") {
      rt.swap = { leg: "pause", zat: zat ?? N0 };
      const F = params(r.network).floors;
      return timer(rt, now + ms(U(F.swapGapSecs[0], F.swapGapSecs[1])), "submit", "running");
    }
    if (b.type === "dca" && rt.dca) {
      rt.dca.got += tokens ?? N0;
      rt.dca.zat += zat ?? N0;
      rt.dca.ok++;
      return nextSlice(r, s, rt, now);
    }
    if (b.type === "buy" || b.type === "swap") r.out.set(s.id, { tokens, mint: mintOf(r, b.type === "buy" ? b.mint : b.to) ?? undefined });
    else if (b.type === "create") r.out.set(s.id, { tokens, mint: fill?.mint });
    else if (b.type === "sell" || b.type === "sell_all") r.out.set(s.id, { zat });
    complete(r, s.id, now);
    return true;
  }

  function nextSlice(r: Run, s: ScenarioStep, rt: StepRt, now: number): boolean {
    const b = s.block as Extract<ScenarioBlock, { type: "dca" }>;
    const d = rt.dca!;
    d.slice++;
    if (d.slice >= d.amounts.length) {
      r.out.set(s.id, b.side === "buy" ? { tokens: d.got, mint: mintOf(r, b.mint) ?? undefined } : { zat: d.zat });
      if (d.ok === 0) {
        rt.status = "skipped";
        rt.runs++;
        r.cursor = s.id + 1;
        return true;
      }
      complete(r, s.id, now);
      return true;
    }
    rt.attempt = 0;
    rt.runs++;
    return timer(rt, now + ms(U(b.everySecs.min, b.everySecs.max)), "submit", "running");
  }

  /** onFail of a step (§2.3): retry only transient errors, then stop / skip / goto. */
  function fail(r: Run, s: ScenarioStep, rt: StepRt, code: ScenarioStepError, now: number): boolean {
    const f = s.onFail ?? "stop";
    rt.error = code;
    if (typeof f === "object" && "retry" in f && TRANSIENT.has(code) && rt.attempt < f.retry) {
      rt.attempt++;
      // Swap: a failed buy leg retries the buy, not the sale.
      if (s.block.type === "swap" && rt.swap?.leg === "buy") rt.swap.leg = "pause";
      return timer(rt, now + ms(U(1, 5) * EPOCH_SECS), "submit", "running");
    }
    const target = typeof f === "object" && "retry" in f ? f.then : f;
    rt.attempt = 0;
    // DCA: a slice that failed for good is dropped when the plan says skip; the others still run.
    if (s.block.type === "dca" && rt.dca && target === "skip") return nextSlice(r, s, rt, now);
    if (target === "stop") {
      rt.status = "failed";
      rt.runs++;
      close(r, "failed", now, code);
      return false;
    }
    rt.status = target === "skip" ? "skipped" : "failed";
    rt.runs++;
    if (target === "skip") r.cursor = s.id + 1;
    else jump(r, target.goto);
    return true;
  }

  function jump(r: Run, to: number) {
    for (let j = r.cursor + 1; j < to; j++) if (r.steps[j].status === "pending") r.steps[j].status = "skipped";
    r.cursor = to;
  }

  function complete(r: Run, id: number, now: number) {
    void now;
    const rt = r.steps[id];
    rt.status = "done";
    rt.runs++;
    rt.phase = "idle";
    rt.nextAt = undefined;
    rt.deadline = undefined;
    if (r.cursor === id) r.cursor = id + 1;
  }

  function close(r: Run, status: ScenarioStatus, now: number, error?: ScenarioStepError) {
    r.status = status;
    r.closedAt = now;
    if (error) r.error = error;
    // Cancel / expiry close the plan's open orders; a finished plan leaves them to their own TTL (§2.4).
    if (status === "cancelled" || status === "expired") {
      for (const id of r.orders) {
        if (host.order(id)?.status !== "open") continue;
        try {
          host.submit(r.network, r.pubkey, { op: "order_cancel", orderId: id }, now);
        } catch {
          /* triggered meanwhile: its trade finishes like any fired order */
        }
      }
    }
    for (const x of r.steps) {
      if (x.phase !== "inflight") {
        x.phase = "idle";
        x.nextAt = undefined;
        if (x.status === "waiting" || (x.status === "running" && status !== "done")) x.status = "pending";
      }
    }
    // Sealed fields go with the plan, at once (§4.4).
    for (const id of [...r.sealed]) unseal(r, id);
  }

  /** Drop the sealed values of a step (after its job was queued, or when the plan closes). */
  function unseal(r: Run, id: number) {
    if (!r.sealed.delete(id)) return;
    const s = r.plan.steps[id];
    s.block = mask(s.block);
  }

  // ---- views ----

  function list(network: Network, pubkey: string, now: number): Scenario[] {
    // An action that settled after the plan closed still updates its step (it was already in a batch).
    return [...runs.values()]
      .filter((r) => r.network === network && r.pubkey === pubkey && (live(r) || now - (r.closedAt ?? now) <= KEEP_CLOSED_MS))
      .sort((a, b) => Number(live(b)) - Number(live(a)) || b.createdAt - a.createdAt)
      .slice(0, 5)
      .map((r) => view(r));
  }

  function view(r: Run): Scenario {
    return {
      id: r.id,
      status: r.status,
      createdAt: Math.floor(r.createdAt / 60_000) * 60_000,
      // Compressed clock: not rounded up to the hour like core, or a demo plan would seem to live for hours.
      expiresAt: Math.round(r.expiresAt),
      cursor: r.cursor,
      steps: r.steps.map((x, id) => ({
        id,
        status: x.status,
        runs: x.runs,
        ...(x.nextAt !== undefined ? { nextAt: Math.round(x.nextAt) } : {}),
        ...(x.actionId ? { actionId: x.actionId } : {}),
        ...(x.orderId ? { orderId: x.orderId } : {}),
        ...(x.error ? { error: x.error } : {}),
      })),
      ...(r.error ? { error: r.error } : {}),
    };
  }

  return {
    params,
    submit,
    list,
    tick,
    inspect: (id) => runs.get(id),
  };
}

const live = (r: Pick<Run, "status">) => r.status === "active" || r.status === "waiting_start";

function isSealed(b: ScenarioBlock): boolean {
  return b.type === "withdraw_zec" || b.type === "withdraw_token" || b.type === "chat" || b.type === "create";
}

/**
 * Echo of a block for Portfolio (v0.19, review-scenarios.md 2): no part of a withdrawal address is kept in the
 * echo — "sealed" per destination — and text / launch meta are empty. The signing device shows its own copy.
 */
export function mask(b: ScenarioBlock): ScenarioBlock {
  switch (b.type) {
    case "withdraw_zec":
      return { ...b, to: "sealed" };
    case "withdraw_token":
      return { ...b, to: Array.isArray(b.to) ? b.to.map(() => "sealed") : "sealed" };
    case "chat":
      return { ...b, text: "" };
    case "create":
      return { ...b, create: { ...b.create, meta: { name: "", symbol: "" } } };
    default:
      return b;
  }
}
