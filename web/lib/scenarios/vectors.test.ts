// The shared vectors of API.md v0.19 (core/testdata/scenario-vectors.json): the client validator must give
// the server's answer for every plan — ok + run count + effective TTL, or the one error with its kind, step and code.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ScenarioPlan, Venue } from "@/lib/api/types";
import { DEFAULT_SCENARIO_PARAMS } from "./catalog";
import { serverIssues, validatePlan, type ValidateCtx } from "./validate";

interface Ctx {
  nowMs: number;
  minDepositZat: string;
  minActionZat?: string;
  venues: Venue[];
  fairLaunch: boolean;
  chat: boolean;
  fullTrades: boolean;
  pricedMints: string[];
}
interface Case {
  name: string;
  plan: ScenarioPlan;
  ctx?: Partial<Ctx>;
  expect: { ok: true; runs: number; ttlSecs: number } | { ok: false; error: "scenario_invalid" | "scenario_rule" | "bad_request"; step: number | null; code: string };
}

const file = path.resolve(import.meta.dirname, "../../../core/testdata/scenario-vectors.json");
// The web app can be checked out alone (deploy); the vectors live with core.
const vectors = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { defaults: {}, cases: [] }) as { defaults: Ctx; cases: Case[] };
const KIND = { scenario_invalid: "invalid", scenario_rule: "rule", bad_request: "bad_request" } as const;

describe.skipIf(!existsSync(file))("scenario-vectors.json (API.md v0.19)", () => {
  it("has cases", () => expect(vectors.cases.length).toBeGreaterThanOrEqual(50));

  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const x = { ...vectors.defaults, ...c.ctx };
    const ctx: ValidateCtx = {
      params: DEFAULT_SCENARIO_PARAMS,
      now: x.nowMs,
      minDepositZat: x.minDepositZat,
      minActionZat: x.minActionZat,
      venues: x.venues,
      features: { fl: x.fairLaunch, chat: x.chat, fullTrades: x.fullTrades },
      priced: (m) => x.pricedMints.includes(m),
    };
    const r = validatePlan(c.plan, ctx);
    const got = serverIssues(r);
    if (c.expect.ok) {
      expect(got).toEqual([]);
      expect({ runs: r.runs, ttlSecs: r.ttlSecs }).toEqual({ runs: c.expect.runs, ttlSecs: c.expect.ttlSecs });
    } else {
      expect(got.map((i) => ({ kind: i.kind, step: i.step < 0 ? null : i.step, code: i.code }))).toEqual([{ kind: KIND[c.expect.error], step: c.expect.step, code: c.expect.code }]);
    }
  });
});
