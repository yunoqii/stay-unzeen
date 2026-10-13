"use client";

// Review & sign: the plan in plain English, what it can take from the balance, who sees what, the sealed
// fields (masked, peek on demand), then one signature with the anon key.

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Eye, EyeSlash, LockKey, ShieldCheck, Signature, WarningCircle } from "@phosphor-icons/react";
import type { PoolInfo, ScenarioPlan } from "@/lib/api/types";
import { formatSecs } from "@/lib/scenarios/catalog";
import { describeBlock, maskAddr, onFailText, planTotals, sealedFields, stepTitle, zecText, type TokenLookup } from "@/lib/scenarios/describe";
import type { PlanCheck } from "@/lib/scenarios/validate";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BLOCK_ICON } from "./block-icon";
import { FloorTape } from "./floor-tape";

const EASE = [0.16, 1, 0.3, 1] as const;

export function Review({
  name,
  plan,
  check,
  pool,
  tok,
  busy,
  error,
  onBack,
  onSign,
}: {
  name: string;
  plan: ScenarioPlan;
  check: PlanCheck;
  pool: PoolInfo | null;
  tok: TokenLookup;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onSign: () => void;
}) {
  const [peek, setPeek] = useState(false);
  const totals = planTotals(plan, pool, tok);
  const sealed = sealedFields(plan);
  const manual = plan.steps[0]?.block.type === "manual_start";
  const ttl = check.ttlSecs;

  return (
    <div className="ledger lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      {/* the plan */}
      <section aria-labelledby="review-plan" className="p-5 sm:p-6">
        <button type="button" onClick={onBack} className="mb-5 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <ArrowLeft size={14} weight="light" aria-hidden />
          Back to the builder
        </button>
        <p className="font-mono text-[11px] tracking-wider text-faint-foreground uppercase">Review & sign</p>
        <h2 id="review-plan" className="mt-1 text-2xl font-medium tracking-tight text-balance">
          {name}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {plan.steps.length} blocks · up to {check.runs} {check.runs === 1 ? "action" : "actions"} · lives {formatSecs(ttl)} · {manual ? "starts when you press Start" : "starts as soon as you sign"}
        </p>

        <ol className="mt-6 space-y-0">
          {plan.steps.map((s, i) => {
            const Icon = BLOCK_ICON[s.block.type];
            const floors = check.floors.filter((f) => f.step === i);
            return (
              <motion.li
                key={i}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: EASE, delay: Math.min(i, 10) * 0.035 }}
                className="relative grid grid-cols-[32px_minmax(0,1fr)] gap-3 pb-5 last:pb-0"
              >
                {i < plan.steps.length - 1 && <span aria-hidden className="absolute top-8 bottom-0 left-[15px] w-px bg-border" />}
                <span className="tabular grid size-8 place-items-center rounded-full border border-border font-mono text-[11px] text-muted-foreground">{i + 1}</span>
                <div className="min-w-0 pt-1">
                  <p className="flex items-center gap-1.5 text-xs text-faint-foreground">
                    <Icon size={12} weight="light" aria-hidden />
                    {stepTitle(s)}
                  </p>
                  <p className="mt-0.5 text-sm text-pretty">{describeBlock(plan, s.block, tok, { sealed: !peek })}</p>
                  {s.onFail !== undefined && s.onFail !== "stop" && <p className="mt-0.5 font-mono text-[11px] text-faint-foreground">{onFailText(s.onFail)}</p>}
                  {floors.length > 0 && (
                    <div className="mt-1.5 flex flex-col gap-1">
                      {floors.map((f) => (
                        <FloorTape key={f.code} text={f.text} />
                      ))}
                    </div>
                  )}
                </div>
              </motion.li>
            );
          })}
        </ol>
      </section>

      {/* the facts and the signature */}
      <div className="ledger-col">
        <section aria-labelledby="review-money" className="p-5 sm:p-6">
          <h3 id="review-money" className="text-sm font-medium">
            What it can take from your balance
          </h3>
          <dl className="mt-3 space-y-1.5 text-sm">
            <Row label="Fixed amounts, all rounds" value={totals.fixedZat > BigInt(0) ? zecText(totals.fixedZat) : "None"} strong />
            {totals.shares.map((s) => (
              <Row key={s} label={s.split(": ")[0]} value={s.split(": ").slice(1).join(": ")} />
            ))}
            {totals.fees.map((f) => (
              <Row key={f.label} label={f.label} value={zecText(f.zat)} />
            ))}
          </dl>
          <p className="mt-3 text-[11px] text-pretty text-faint-foreground">Nothing is held now. Each step reserves its amount when it runs; if your balance is short then, that step fails and its “If it fails” rule applies.</p>
        </section>

        <section aria-labelledby="review-who" className="p-5 sm:p-6">
          <h3 id="review-who" className="text-sm font-medium">
            Who sees what
          </h3>
          <ul className="mt-3 space-y-3 text-sm">
            <Who who="Solana" text="Ordinary unzeen trades and withdrawals in shared batches. No scenario marker, nothing that ties steps together." />
            <Who who="Your network" text="One 16 KiB request when you sign. While steps run, your device sends nothing." />
            <Who
              who="The pool operator"
              text={`This plan while it is active (≤ ${formatSecs(ttl)}): blocks, tokens, amounts and triggers. Not your addresses or messages — those are sealed. Which action belongs to which step is erased 24 h after the plan ends.`}
              accent
            />
          </ul>
        </section>

        {sealed.length > 0 && (
          <section aria-labelledby="review-sealed" className="p-5 sm:p-6">
            <div className="flex items-center justify-between gap-2">
              <h3 id="review-sealed" className="flex items-center gap-1.5 text-sm font-medium">
                <LockKey size={14} weight="duotone" className="text-zec" aria-hidden />
                Sealed fields
              </h3>
              <button
                type="button"
                onClick={() => setPeek((p) => !p)}
                aria-pressed={peek}
                className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {peek ? <EyeSlash size={13} weight="light" aria-hidden /> : <Eye size={13} weight="light" aria-hidden />}
                {peek ? "Hide" : "Peek"}
              </button>
            </div>
            <ul className="mt-3 space-y-1.5">
              {sealed.map((f, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="shrink-0 text-muted-foreground">
                    Step {f.step + 1} · {f.what}
                  </span>
                  <span className="relative min-w-0 truncate font-mono text-foreground/90">
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span key={peek ? "open" : "shut"} initial={{ opacity: 0, filter: "blur(4px)" }} animate={{ opacity: 1, filter: "blur(0px)" }} exit={{ opacity: 0, filter: "blur(4px)" }} transition={{ duration: 0.18 }} className="block truncate">
                        {peek ? f.value : f.what.includes("address") ? maskAddr(f.value) : "▓▓▓▓▓▓"}
                      </motion.span>
                    </AnimatePresence>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-pretty text-faint-foreground">Encrypted on the server with a key kept outside its database, and deleted the moment the step queues its job — or when the plan ends, whichever comes first.</p>
          </section>
        )}

        {check.warnings.length > 0 && (
          <section aria-label="Before you sign" className="space-y-1.5 p-5 sm:p-6">
            {check.warnings.map((w, i) => (
              <p key={i} className="flex gap-2 text-xs text-pretty text-muted-foreground">
                <WarningCircle size={14} weight="light" className="mt-px shrink-0 text-zec" aria-hidden />
                <span>
                  {w.step >= 0 && <span className="text-faint-foreground">Step {w.step + 1} · </span>}
                  {w.text}
                </span>
              </p>
            ))}
          </section>
        )}

        <section aria-label="Sign" className="flex flex-1 flex-col justify-end gap-3 p-5 sm:p-6">
          <AnimatePresence>
            {error && (
              <motion.p role="alert" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-pretty">
                <WarningCircle size={14} weight="light" className="mt-px shrink-0 text-destructive" aria-hidden />
                {error}
              </motion.p>
            )}
          </AnimatePresence>
          <Button onClick={onSign} disabled={busy || !check.ok} className="h-12 w-full rounded-full text-base" aria-busy={busy}>
            <Signature weight="duotone" className="size-5!" />
            {busy ? "Signing…" : manual ? "Sign once — start it later" : "Sign once & start"}
          </Button>
          <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-faint-foreground">
            <ShieldCheck size={12} weight="light" aria-hidden />
            One signature with your anon key. You can cancel any time before a step runs.
          </p>
        </section>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("tabular text-right", strong && "font-medium")}>{value}</dd>
    </div>
  );
}

function Who({ who, text, accent }: { who: string; text: string; accent?: boolean }) {
  return (
    <li className="grid grid-cols-[104px_minmax(0,1fr)] gap-3">
      <span className={cn("text-xs", accent ? "text-zec" : "text-faint-foreground")}>{who}</span>
      <span className="text-xs leading-relaxed text-pretty text-muted-foreground">{text}</span>
    </li>
  );
}
