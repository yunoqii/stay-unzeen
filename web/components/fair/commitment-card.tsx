"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle, CircleNotch, SealCheck, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { FairBid, FairLaunch } from "@/lib/api/types";
import type { LocalBid } from "@/lib/fair/bid-store";
import { verifyInclusion, type InclusionCheck } from "@/lib/fair/merkle";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Commitment root of all sealed bids, fixed at window close and anchored in a Solana memo-tx. "Before
 * the drand round" is claimed only when attestation.beforeRound === true (review F2). The memo signature is copy-only: a link to an
 * explorer would tell the explorer "this IP looked at this launch".
 */
export function CommitmentCard({ launch, bid, local }: { launch: FairLaunch; bid: FairBid | undefined; local: LocalBid | undefined }) {
  const c = launch.commitment;
  if (!c)
    return (
      <div className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">
        The commitment root is published the moment the window closes.
      </div>
    );
  const a = c.attestation;
  return (
    <section aria-labelledby="commit-t" className="rounded-2xl border border-border">
      <div className="p-4">
        <h3 id="commit-t" className="flex items-center gap-2 text-sm font-medium">
          <SealCheck size={15} weight="duotone" className="text-zec" aria-hidden />
          Commitment root
        </h3>
        <p className="mt-1 text-xs text-pretty text-muted-foreground">
          A Merkle root over every sealed bid, fixed when the window closed. The set of bids cannot change after it.
          {a?.beforeRound === true && " Its anchor landed before the round, while no bid could be read."}
        </p>
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-surface-1 px-3 py-2">
          <code className="min-w-0 flex-1 font-mono text-[11px] break-all text-foreground/90">{c.root}</code>
          <CopyButton value={c.root} label="Copy commitment root" toastText="Root copied" size={13} />
        </div>
      </div>

      <div className="border-t border-border/60 p-4">
        {a ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                {/* Timing is claimed only when the backend proved it (review F2); otherwise stay neutral. */}
                {a.beforeRound === true ? "Anchored on Solana before the round" : `Anchored on Solana at slot ${a.slot.toLocaleString("en-US")}`}
              </span>
              {a.matches ? (
                <span className="flex items-center gap-1 text-[11px] text-zec">
                  <CheckCircle size={12} weight="fill" aria-hidden /> memo = root
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[11px] text-sell">
                  <WarningCircle size={12} weight="fill" aria-hidden /> mismatch
                </span>
              )}
            </div>
            <dl className="mt-2 space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-faint-foreground">Memo tx</dt>
                <dd>
                  <CopyButton
                    value={a.solanaTx}
                    label="Copy memo transaction signature"
                    toastText="Signature copied"
                    toastDescription="Look it up in an explorer later, ideally over Tor. Its memo is exactly the root."
                    className="gap-1.5 font-mono"
                  >
                    {shortAddr(a.solanaTx, 6, 6)}
                  </CopyButton>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-faint-foreground">Slot</dt>
                <dd className="tabular font-mono text-muted-foreground">{a.slot.toLocaleString("en-US")}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-faint-foreground">Signer</dt>
                <dd>
                  <CopyButton value={a.signer} label="Copy attestation signer" toastText="Signer copied" className="gap-1.5 font-mono">
                    {shortAddr(a.signer, 4, 4)}
                  </CopyButton>
                </dd>
              </div>
            </dl>
            {a.beforeRound === false && (
              <p className="mt-3 text-xs text-pretty text-faint-foreground">Anchored after the round: inclusion is still checkable, the timing is not proven.</p>
            )}
            {!a.matches && (
              <p role="alert" className="mt-3 rounded-xl bg-sell/10 p-3 text-xs text-sell">
                The memo read back from Solana does not match this root. Treat this launch with caution and verify the memo yourself.
              </p>
            )}
          </>
        ) : (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <CircleNotch size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />
            Anchoring the root on Solana…
          </p>
        )}
      </div>

      {bid && <VerifyMine root={c.root} bid={bid} local={local} />}
    </section>
  );
}

/** Proof from the portfolio + ciphertext from this browser -> recompute the root here. */
function VerifyMine({ root, bid, local }: { root: string; bid: FairBid; local: LocalBid | undefined }) {
  const [res, setRes] = useState<InclusionCheck | null>(null);
  const proof = bid.proof;
  const run = () => {
    if (!proof || !local) return;
    setRes(verifyInclusion(local.ciphertext, proof, root));
  };
  return (
    <div className="border-t border-border/60 p-4">
      <button
        type="button"
        onClick={run}
        disabled={!proof || !local}
        className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm transition-colors hover:border-zec/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 disabled:hover:border-border"
      >
        <SealCheck size={14} weight="light" aria-hidden />
        Verify my bid is included
      </button>
      {!local ? (
        <p className="mt-2 text-xs text-faint-foreground">Your ciphertext lives only on the device you sealed it on. Verify there.</p>
      ) : !proof ? (
        <p className="mt-2 text-xs text-faint-foreground">Your proof arrives with the next balance refresh.</p>
      ) : null}
      <AnimatePresence>
        {res && (
          <motion.div
            key={res.ok ? "ok" : "no"}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            style={{ overflow: "hidden" }}
            aria-live="polite"
          >
            <p className={cn("mt-3 flex items-center gap-1.5 text-sm", res.ok ? "text-zec" : "text-sell")}>
              {res.ok ? <CheckCircle size={15} weight="fill" aria-hidden /> : <XCircle size={15} weight="fill" aria-hidden />}
              {res.ok ? "Included. Your sealed bid is in the committed set." : res.leafMatches ? "Not included: the path does not climb to this root." : "Not included: the proof is for another ciphertext."}
            </p>
            <ol className="mt-2 space-y-1 font-mono text-[10px] text-faint-foreground">
              <li className="truncate">
                <span className="text-muted-foreground">leaf</span> {res.leaf} <span className="text-faint-foreground">= sha256(0x00 ‖ your ciphertext)</span>
              </li>
              {res.trace.map((h, i) => (
                <motion.li key={i} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.05 * (i + 1) }} className={cn("truncate", i === res.trace.length - 1 && (res.ok ? "text-zec" : "text-sell"))}>
                  <span className="text-muted-foreground">{i === res.trace.length - 1 ? "root" : `node ${i + 1}`}</span> {h}
                </motion.li>
              ))}
            </ol>
            <p className="mt-2 text-[11px] text-faint-foreground">Computed in this browser. Nothing was sent anywhere.</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
