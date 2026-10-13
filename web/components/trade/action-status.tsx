"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, CircleNotch, X } from "@phosphor-icons/react";
import { CopyButton } from "@/components/ui/copy-button";
import { ApiError, errorText } from "@/lib/api/client";
import type { TrackedAction } from "@/lib/activity";
import { queuedLabel } from "@/lib/exec";
import { formatCompact, formatZec, shortAddr, unitsToNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

type Step = { key: string; label: string; detail?: React.ReactNode };

/**
 * Signed -> Queued for next batch (or "Sending…" for exec "now") -> Confirmed (or Failed). The signature is shown with a copy button
 * only: a link to an explorer would hand the explorer "this IP looked at this tx" (review D13).
 */
export function ActionStatusCard({ action, className }: { action: TrackedAction; className?: string }) {
  const st = action.status;
  const failed = st.status === "failed";
  const done = st.status === "executed";
  const current = done || failed ? 2 : 1;

  const steps: Step[] = [
    { key: "signed", label: "Signed with your anon key", detail: "Accepted by the pool. Nothing left this browser but the signed order." },
    {
      key: "queued",
      label: action.op === "claim" ? "No batch: ledger only" : queuedLabel(action.exec),
      detail: action.op === "claim"
        ? "Creator fees move inside the pool's private ledger. Nothing is sent on Solana."
        : action.stale
        ? "Still waiting. Payouts can take a while; your balance updates when it goes out."
        : action.exec === "now"
          ? "Skips the batch with a priority fee. Lands in seconds."
          : action.exec === "max"
            ? action.op.startsWith("withdraw")
              ? "Max privacy: a long random delay, up to an hour. Harder to match by timing."
              : "Max privacy: waits for a later, bigger batch, up to 15 minutes. Harder to match by timing."
            : action.op === "withdraw_token" || action.op === "withdraw_zec"
          ? "Goes out after a random delay, from a different vault than your buys."
          : "Orders leave in batches after a random delay, so the timing doesn't point at you.",
    },
    failed
      ? { key: "failed", label: "Failed", detail: errorText(new ApiError(st.error ?? "internal", "")) + " Your balance was returned." }
      : action.op === "claim"
        ? { key: "done", label: "Credited to your balance", detail: "A ledger entry at the pool’s sell rate. No on-chain transaction." }
        : { key: "done", label: action.op.startsWith("withdraw") ? "Sent" : "Confirmed on Solana", detail: done ? <FillLine action={action} /> : undefined },
  ];

  return (
    <div className={cn("rounded-2xl border border-border bg-surface-1 p-4", className)} aria-live="polite">
      <ol className="space-y-3">
        {steps.map((s, i) => {
          const state = i < current ? "done" : i === current ? (failed ? "failed" : done ? "done" : "active") : "todo";
          return (
            <li key={s.key} className="flex gap-3">
              <span
                aria-hidden
                className={cn(
                  "relative mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border transition-colors duration-200",
                  state === "done" && "border-zec/60 bg-zec/15 text-zec",
                  state === "active" && "border-border-strong text-muted-foreground",
                  state === "failed" && "border-sell/60 bg-sell/10 text-sell",
                  state === "todo" && "border-border text-faint-foreground",
                )}
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={state}
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.6 }}
                    transition={{ duration: 0.15 }}
                    className="grid place-items-center"
                  >
                    {state === "done" ? (
                      <Check size={11} weight="bold" />
                    ) : state === "failed" ? (
                      <X size={11} weight="bold" />
                    ) : state === "active" ? (
                      <CircleNotch size={12} weight="bold" className="animate-spin motion-reduce:animate-none" />
                    ) : (
                      <span className="size-1 rounded-full bg-current" />
                    )}
                  </motion.span>
                </AnimatePresence>
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm", state === "todo" ? "text-faint-foreground" : "text-foreground")}>{s.label}</p>
                {s.detail && state !== "todo" && <div className="mt-0.5 text-xs text-pretty text-muted-foreground">{s.detail}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      {st.solanaTx && (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-xs">
          <span className="text-faint-foreground">Signature</span>
          <CopyButton
            value={st.solanaTx}
            label="Copy transaction signature"
            toastText="Signature copied"
            toastDescription="Paste it into an explorer later, ideally over Tor."
            className="gap-1.5 font-mono"
          >
            {shortAddr(st.solanaTx, 6, 6)}
          </CopyButton>
        </div>
      )}
    </div>
  );
}

function FillLine({ action }: { action: TrackedAction }) {
  const f = action.status.fill;
  const sym = action.symbol ? `$${action.symbol}` : "tokens";
  const tokens = f && action.decimals !== undefined ? formatCompact(unitsToNumber(f.tokenAmount, action.decimals)) : null;
  if (action.op === "buy" && f) return <>Got {tokens} {sym} for {formatZec(f.zecSpent ?? action.amount)} ZEC.</>;
  if (action.op === "sell" && f) return <>Sold {tokens} {sym} for {formatZec(f.zecCredited ?? "0")} ZEC, credited to your balance.</>;
  if (action.op === "withdraw_token") return <>{tokens ?? "Tokens"} {sym} on the way to your fresh address{action.parts && action.parts > 1 ? "es" : ""}.</>;
  if (action.op === "withdraw_zec") return <>{formatZec(action.amount)} ZEC paid out to your shielded address.</>;
  return null;
}
