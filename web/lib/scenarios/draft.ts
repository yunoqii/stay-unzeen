// Editor model of a scenario. Steps carry a stable `uid`; every reference inside a block ({ step }, goto,
// repeat.from) points at a uid while editing, so steps can be dragged around freely. toPlan() turns uids
// into the plan's ids (= positions), fromPlan() goes back. A reference to a deleted step becomes -1, which
// the validator reports as a broken link instead of silently pointing somewhere else.

import type { OnFail, ScenarioBlock, ScenarioPlan, ScenarioStep } from "@/lib/api/types";

export interface DraftStep {
  uid: number;
  block: ScenarioBlock;
  onFail?: OnFail;
}

export interface Draft {
  /** Local id of the draft (random, never sent). */
  id: string;
  /** Local name, never sent: the server must not learn what you call it (§4.2). */
  name: string;
  /** Template it started from, local only. */
  template?: string;
  ttlSecs: number;
  steps: DraftStep[];
  nextUid: number;
  updatedAt: number;
}

type Mapper = (id: number) => number;

/** Rewrites every step reference inside a block / onFail. Structural: keys `step`, `goto`, and repeat.from. */
function remapValue(v: unknown, map: Mapper): unknown {
  if (Array.isArray(v)) return v.map((x) => remapValue(x, map));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = (k === "step" || k === "goto") && typeof x === "number" ? map(x) : remapValue(x, map);
  }
  return out;
}

export function remapBlock(block: ScenarioBlock, map: Mapper): ScenarioBlock {
  const b = remapValue(block, map) as ScenarioBlock;
  if (b.type === "repeat") return { ...b, from: map(b.from) };
  return b;
}

export function remapOnFail(f: OnFail | undefined, map: Mapper): OnFail | undefined {
  return f === undefined ? undefined : (remapValue(f, map) as OnFail);
}

export function toPlan(d: Pick<Draft, "steps" | "ttlSecs">): ScenarioPlan {
  const index = new Map(d.steps.map((s, i) => [s.uid, i]));
  const map: Mapper = (uid) => index.get(uid) ?? -1;
  return {
    v: 1,
    ttlSecs: d.ttlSecs,
    steps: d.steps.map((s, i): ScenarioStep => {
      const onFail = remapOnFail(s.onFail, map);
      return { id: i, block: remapBlock(s.block, map), ...(onFail !== undefined && onFail !== "stop" ? { onFail } : {}) };
    }),
  };
}

export function fromPlan(plan: ScenarioPlan, base: Omit<Draft, "steps" | "nextUid" | "ttlSecs"> & { ttlSecs?: number }): Draft {
  // Plan ids become uids one to one; ids must already be positions (the validator checks that).
  return {
    ...base,
    ttlSecs: plan.ttlSecs ?? base.ttlSecs ?? 86_400,
    steps: plan.steps.map((s) => ({ uid: s.id, block: s.block, ...(s.onFail !== undefined ? { onFail: s.onFail } : {}) })),
    nextUid: plan.steps.length,
  };
}

export function newDraftId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function emptyDraft(ttlSecs: number, now = Date.now()): Draft {
  return { id: newDraftId(), name: "Untitled scenario", ttlSecs, steps: [], nextUid: 0, updatedAt: now };
}

/** Inserts a block at `at` (default: the end). */
export function insertStep(d: Draft, block: ScenarioBlock, at = d.steps.length): { draft: Draft; uid: number } {
  const uid = d.nextUid;
  const steps = [...d.steps];
  steps.splice(Math.max(0, Math.min(at, steps.length)), 0, { uid, block });
  return { draft: { ...d, steps, nextUid: uid + 1 }, uid };
}

export function moveStep(d: Draft, uid: number, to: number): Draft {
  const from = d.steps.findIndex((s) => s.uid === uid);
  if (from < 0) return d;
  const steps = [...d.steps];
  const [s] = steps.splice(from, 1);
  steps.splice(Math.max(0, Math.min(to, steps.length)), 0, s);
  return { ...d, steps };
}

export function removeStep(d: Draft, uid: number): Draft {
  return { ...d, steps: d.steps.filter((s) => s.uid !== uid) };
}

export function updateStep(d: Draft, uid: number, f: (s: DraftStep) => DraftStep): Draft {
  return { ...d, steps: d.steps.map((s) => (s.uid === uid ? f(s) : s)) };
}

/** Steps a reference from `uid` may point at: earlier ones (refs) or later ones (goto). */
export function earlier(d: Draft, uid: number): DraftStep[] {
  const i = d.steps.findIndex((s) => s.uid === uid);
  return i < 0 ? [] : d.steps.slice(0, i);
}

export function later(d: Draft, uid: number): DraftStep[] {
  const i = d.steps.findIndex((s) => s.uid === uid);
  return i < 0 ? [] : d.steps.slice(i + 1);
}

/** 1-based position of a uid for display ("step 3"), or null. */
export function positionOf(d: Pick<Draft, "steps">, uid: number): number | null {
  const i = d.steps.findIndex((s) => s.uid === uid);
  return i < 0 ? null : i + 1;
}
