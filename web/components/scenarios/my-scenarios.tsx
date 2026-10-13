"use client";

// Your plans, straight from Portfolio.scenarios: the regular fixed-rhythm portfolio poll carries them, so
// there is no per-plan request whose timing could say when a step ran (N-2). Start, cancel, stop all.

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { CaretDown, CheckCircle, Circle, CircleDashed, CircleNotch, HandTap, MinusCircle, Stop, X, XCircle, type Icon as PhIcon } from "@phosphor-icons/react";
import { api, ApiError, errorText } from "@/lib/api/client";
import type { Scenario, ScenarioStepError, ScenarioStepState } from "@/lib/api/types";
import { notifyAccepted } from "@/lib/activity";
import { getSigner } from "@/lib/crypto/session";
import type { Network } from "@/lib/network";
import { describeBlock, stepTitle, type TokenLookup } from "@/lib/scenarios/describe";
import type { SignedName } from "@/lib/scenarios/store";
import { useNow } from "@/hooks/use-now";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/layout/page-shell";
import { cn } from "@/lib/utils";
import { BLOCK_ICON } from "./block-icon";
import { FloorTape } from "./floor-tape";
import { DEFAULT_SCENARIO_PARAMS } from "@/lib/scenarios/catalog";
import { validatePlan } from "@/lib/scenarios/validate";

const EASE = [0.16, 1, 0.3, 1] as const;

export const STATUS_LABEL: Record<Scenario["status"], string> = {
  waiting_start: "Waiting for Start",
  active: "Running",
  done: "Finished",
  failed: "Stopped on an error",
  cancelled: "Cancelled",
  expired: "Expired",
};

const STEP_ICON: Record<ScenarioStepState["status"], PhIcon> = {
  pending: Circle,
  waiting: CircleDashed,
  running: CircleNotch,
  done: CheckCircle,
  skipped: MinusCircle,
  failed: XCircle,
};

/** The floors of an echoed plan (they depend on its shape only, not on sealed values). */
function floorsOf(plan: Scenario["plan"]) {
  return validatePlan(plan, { params: DEFAULT_SCENARIO_PARAMS, now: 0, minDepositZat: "0", features: { chat: true, fullTrades: true }, priced: () => true }).floors;
}

const STEP_LABEL: Record<ScenarioStepState["status"], string> = {
  pending: "Pending",
  waiting: "Waiting",
  running: "Running",
  done: "Done",
  skipped: "Skipped",
  failed: "Failed",
};

export const isLiveScenario = (s: Pick<Scenario, "status">) => s.status === "active" || s.status === "waiting_start";

export function stepErrorText(e: ScenarioStepError): string {
  if (e === "timeout") return "Timed out waiting.";
  if (e === "check_failed") return "The safety check didn't pass.";
  return errorText(new ApiError(e, ""));
}

function relative(ts: number, now: number): string {
  const d = Math.round((ts - now) / 1000);
  if (d <= 5) return "any moment";
  if (d < 60) return `in ${d} s`;
  if (d < 3600) return `in ~${Math.round(d / 60)} min`;
  if (d < 86_400) return `in ~${Math.round(d / 3600)} h`;
  return `in ~${Math.round(d / 86_400)} d`;
}

async function send(network: Network, action: Parameters<typeof api.postAction>[1]) {
  const signer = getSigner(network);
  if (!signer) throw new ApiError("locked", "key locked");
  const r = await api.postAction(signer, action);
  notifyAccepted();
  return r;
}

export function MyScenarios({ scenarios, names, tok, network, onBuild }: { scenarios: Scenario[] | null; names: Record<string, SignedName>; tok: TokenLookup; network: Network; onBuild: () => void }) {
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const now = useNow(1000) ?? 0;
  const live = (scenarios ?? []).filter(isLiveScenario);

  const run = async (key: string, action: Parameters<typeof api.postAction>[1], done: string) => {
    setBusy(key);
    try {
      await send(network, action);
      toast.success(done);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
      setConfirmAll(false);
    }
  };

  if (scenarios === null)
    return (
      <div className="space-y-px" aria-busy>
        {[0, 1].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl bg-surface-1" />
        ))}
      </div>
    );

  if (scenarios.length === 0)
    return (
      <EmptyState art title="No scenarios yet">
        <p>Sign a plan once and the pool runs it in the background — your device sends nothing while it does.</p>
        <div className="mt-5 flex justify-center">
          <Button onClick={onBuild} className="h-10 rounded-full px-5">
            Build a scenario
          </Button>
        </div>
      </EmptyState>
    );

  return (
    <section aria-labelledby="mine-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="mine-title" className="text-sm font-medium">
            My scenarios
          </h2>
          <p className="text-xs text-faint-foreground">Updated with your regular portfolio refresh · visible only to your key</p>
        </div>
        {live.length > 0 &&
          (confirmAll ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Cancel all {live.length} running?</span>
              <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => void run("all", { op: "scenario_cancel", all: true }, "Every running scenario stopped.")}>
                Stop all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmAll(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setConfirmAll(true)} className="rounded-full">
              <Stop weight="fill" className="text-destructive" />
              Stop everything
            </Button>
          ))}
      </div>

      <ul className="ledger">
        <AnimatePresence initial={false}>
          {scenarios.map((s) => (
            <motion.li key={s.id} layout="position" initial={{ opacity: 0, filter: "blur(6px)" }} animate={{ opacity: 1, filter: "blur(0px)" }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease: EASE }}>
              <Card s={s} name={names[s.id]?.name} tok={tok} now={now} busy={busy === s.id} onStart={() => void run(s.id, { op: "scenario_start", id: s.id }, "Started. The pool runs it from here.")} onCancel={() => void run(s.id, { op: "scenario_cancel", id: s.id }, "Scenario cancelled.")} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <p className="mt-3 text-[11px] text-pretty text-faint-foreground">
        Cancel stops what hasn&apos;t started and closes the orders a plan placed. A step already in a batch finishes, like a fired order. Closed plans disappear from here 24 h after they end.
      </p>
    </section>
  );
}

function Card({ s, name, tok, now, busy, onStart, onCancel }: { s: Scenario; name?: string; tok: TokenLookup; now: number; busy: boolean; onStart: () => void; onCancel: () => void }) {
  const [open, setOpen] = useState(isLiveScenario(s));
  const live = isLiveScenario(s);
  const done = s.steps.filter((x) => x.status === "done" || x.status === "skipped").length;
  const current = s.steps[s.cursor];
  const next = current?.nextAt;
  const floors = useMemo(() => floorsOf(s.plan), [s.plan]);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{name ?? `Scenario ${s.id.slice(0, 6)}`}</span>
            <StatusPill status={s.status} />
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {done}/{s.steps.length} steps
            {live && current ? ` · now: ${stepTitle(s.plan.steps[s.cursor])}` : ""}
            {live && next ? ` · next ${relative(next, now)}` : ""}
            {live ? ` · expires ${relative(s.expiresAt, now)}` : ""}
          </p>
          {s.error && <p className="mt-1 text-xs text-destructive">{stepErrorText(s.error)}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          {s.status === "waiting_start" && (
            <Button size="sm" onClick={onStart} disabled={busy} className="rounded-full">
              <HandTap weight="duotone" />
              Start
            </Button>
          )}
          {live &&
            (confirm ? (
              <span className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Cancel? A step already in a batch still finishes.</span>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    setConfirm(false);
                    onCancel();
                  }}
                  className="rounded-full"
                >
                  Cancel plan
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(false)} className="rounded-full">
                  Keep
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} disabled={busy} className="rounded-full">
                <X weight="light" />
                Cancel
              </Button>
            ))}
          <Button size="icon-sm" variant="ghost" aria-expanded={open} aria-label={open ? "Hide steps" : "Show steps"} onClick={() => setOpen((o) => !o)}>
            <CaretDown weight="light" className={cn("transition-transform duration-200", open && "rotate-180")} />
          </Button>
        </div>
      </div>

      {/* progress: one segment per step */}
      <div aria-hidden className="mt-3 flex gap-0.5">
        {s.steps.map((x, i) => (
          <span
            key={i}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors duration-300",
              x.status === "done" ? "bg-zec" : x.status === "skipped" ? "bg-zec/30" : x.status === "failed" ? "bg-destructive" : x.status === "running" || x.status === "waiting" ? "hatch-zec bg-zec/15" : "bg-surface-2",
            )}
          />
        ))}
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.ol key="steps" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: EASE }} style={{ overflow: "hidden" }} className="mt-1">
            {s.plan.steps.map((p, i) => {
              const st = s.steps[i];
              const Icon = BLOCK_ICON[p.block.type];
              const StIcon = st ? STEP_ICON[st.status] : Circle;
              const tapes = st && (st.status === "pending" || st.status === "waiting" || st.status === "running") ? floors.filter((f) => f.step === i) : [];
              return (
                <li key={i} className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-baseline gap-2 border-t border-border/60 py-2 first:border-t-0">
                  <span className="font-mono text-[11px] text-faint-foreground">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-xs">
                      <Icon size={12} weight="light" className="text-faint-foreground" aria-hidden />
                      {stepTitle(p)}
                      {st && st.runs > 1 && <span className="text-faint-foreground">· ran {st.runs}×</span>}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">{describeBlock(s.plan, p.block, tok, { sealed: true })}</span>
                    {st?.error && <span className="block text-[11px] text-destructive">{stepErrorText(st.error)}</span>}
                    {tapes.length > 0 && (
                      <span className="mt-1 flex flex-col gap-0.5">
                        {tapes.map((f) => (
                          <FloorTape key={f.code} text={f.text} compact />
                        ))}
                      </span>
                    )}
                  </span>
                  <span className={cn("flex flex-col items-end text-right text-xs", st?.status === "done" ? "text-muted-foreground" : st?.status === "failed" ? "text-destructive" : st?.status === "waiting" || st?.status === "running" ? "text-zec" : "text-faint-foreground")}>
                    <span className="inline-flex items-center gap-1">
                      <StIcon size={12} weight={st?.status === "done" ? "fill" : "light"} className={cn(st?.status === "running" && "motion-safe:animate-spin")} aria-hidden />
                      {st ? STEP_LABEL[st.status] : "—"}
                    </span>
                    {st?.nextAt && (st.status === "waiting" || st.status === "running") ? <span className="block text-faint-foreground">{relative(st.nextAt, now)}</span> : null}
                  </span>
                </li>
              );
            })}
          </motion.ol>
        )}
      </AnimatePresence>
    </div>
  );
}

export function StatusPill({ status }: { status: Scenario["status"] }) {
  const live = status === "active" || status === "waiting_start";
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px]",
        live ? "border-zec/40 text-foreground" : status === "done" ? "border-border text-muted-foreground" : status === "failed" ? "border-destructive/40 text-destructive" : "border-border text-faint-foreground",
      )}
    >
      {status === "active" && <span aria-hidden className="live-dot size-1.5 rounded-full bg-zec" />}
      {STATUS_LABEL[status]}
    </span>
  );
}
