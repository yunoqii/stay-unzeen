"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, Info } from "@phosphor-icons/react";
import type { FairBid, FairLaunch } from "@/lib/api/types";
import { formatCompact, formatPrice, formatSol, formatZec, lamportsToSol, shortAddr, unitsToNumber } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { DecryptText } from "@/components/motion/decrypt-text";

const EASE = [0.16, 1, 0.3, 1] as const;

function Stat({ label, value, delay, accent }: { label: string; value: string; delay: number; accent?: boolean }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={{ opacity: 0, filter: "blur(10px)" }}
      animate={{ opacity: 1, filter: "blur(0px)" }}
      transition={{ duration: 0.45, delay: reduce ? 0 : delay, ease: EASE }}
      className="bg-background p-4"
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={accent ? "tabular mt-1.5 text-2xl tracking-tight text-zec" : "tabular mt-1.5 text-2xl tracking-tight"}>
        <DecryptText text={value} durationMs={520 + delay * 600} />
      </p>
    </motion.div>
  );
}

/**
 * After the round: the shade glyphs decrypt into the numbers — first the total, then your allocation.
 * One price for every bidder.
 */
export function RevealResult({ launch, bid }: { launch: FairLaunch; bid: FairBid | undefined }) {
  const reduce = useReducedMotion();
  const r = launch.result!;
  const tokens = formatCompact(unitsToNumber(r.tokenAmount, r.decimals));
  const mine = bid?.status === "settled" ? bid : undefined;
  return (
    <div className="space-y-4">
      <div className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2">
        <Stat label="One price for everyone" value={`${formatPrice(r.priceSol)} SOL`} delay={0} accent />
        <Stat label="Bought in one transaction" value={`${formatSol(lamportsToSol(r.totalLamports))} SOL`} delay={0.12} />
        <Stat label={`$${launch.meta.symbol} bought`} value={tokens} delay={0.24} />
        <Stat label="Valid bids" value={typeof r.bids === "number" ? String(r.bids) : "<5"} delay={0.36} />
      </div>
      {r.oversubscribed && (
        <p className="flex gap-2 text-xs text-muted-foreground">
          <Info size={14} weight="light" className="mt-px shrink-0" aria-hidden />
          Oversubscribed: bids passed the total cap, so every bid was cut in the same proportion. The rest of each hold went back.
        </p>
      )}

      {bid && (
        <motion.section
          aria-label="Your allocation"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: reduce ? 0 : 0.7, ease: EASE }}
          className="rounded-2xl border border-zec/30 bg-zec/[0.04] p-4"
        >
          <p className="text-xs text-muted-foreground">Your allocation</p>
          {mine ? (
            <>
              <p className="tabular mt-1.5 text-3xl tracking-tight">
                <DecryptText text={`${formatCompact(unitsToNumber(mine.tokenAmount ?? "0", r.decimals))} $${launch.meta.symbol}`} durationMs={900} />
              </p>
              <dl className="mt-3 grid grid-cols-3 gap-3 text-xs">
                <div>
                  <dt className="text-faint-foreground">You sealed</dt>
                  <dd className="tabular mt-0.5 text-muted-foreground">{mine.amountZat ? `${formatZec(mine.amountZat)} ZEC` : "—"}</dd>
                </div>
                <div>
                  <dt className="text-faint-foreground">Charged</dt>
                  <dd className="tabular mt-0.5 text-muted-foreground">{formatZec(mine.chargedZat ?? "0")} ZEC</dd>
                </div>
                <div>
                  <dt className="text-faint-foreground">Refunded</dt>
                  <dd className="tabular mt-0.5 text-muted-foreground">{formatZec(mine.releasedZat ?? "0")} ZEC</dd>
                </div>
              </dl>
              <p className="mt-3 text-[11px] text-pretty text-faint-foreground">
                In your pool balance now. Withdrawing exactly this amount later can be matched to it: use Smart withdraw or wait.
              </p>
            </>
          ) : bid.status === "invalid" ? (
            <p className="mt-1.5 text-sm text-muted-foreground">Your bid could not be opened as valid, so it did not take part. The hold went back to your balance.</p>
          ) : (
            <p className="mt-1.5 text-sm text-muted-foreground">Settling…</p>
          )}
        </motion.section>
      )}

      <dl className="space-y-1.5 text-xs">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-faint-foreground">Mint</dt>
          <dd>
            <CopyButton value={r.mint} label="Copy mint address" toastText="Mint copied" className="gap-1.5 font-mono">
              {shortAddr(r.mint, 6, 6)}
            </CopyButton>
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-faint-foreground">Create + buy tx</dt>
          <dd>
            <CopyButton value={r.solanaTx} label="Copy launch transaction signature" toastText="Signature copied" toastDescription="Paste it into an explorer later, ideally over Tor." className="gap-1.5 font-mono">
              {shortAddr(r.solanaTx, 6, 6)}
            </CopyButton>
          </dd>
        </div>
        {launch.drand.signature && (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-faint-foreground">drand round signature</dt>
            <dd>
              <CopyButton value={launch.drand.signature} label="Copy drand round signature" toastText="Signature copied" toastDescription="Checkable offline against the quicknet public key." className="gap-1.5 font-mono">
                {shortAddr(launch.drand.signature, 6, 6)}
              </CopyButton>
            </dd>
          </div>
        )}
      </dl>

      <Button asChild className="h-11 w-full rounded-full">
        <Link href={`/token/${r.mint}`}>
          Open ${launch.meta.symbol} <ArrowRight size={14} weight="light" aria-hidden />
        </Link>
      </Button>
    </div>
  );
}
