"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, ArrowUpRight, Snowflake } from "@phosphor-icons/react";
import type { Portfolio } from "@/lib/api/types";
import { formatZec } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PeekToggle, Veiled } from "./peek";

/** Increase since the last poll, for the "+0.1" note. */
function useGain(zat: string | undefined) {
  const prev = useRef<string | undefined>(undefined);
  const [gain, setGain] = useState<{ id: number; zat: string } | null>(null);
  useEffect(() => {
    if (zat === undefined) return;
    const before = prev.current;
    prev.current = zat;
    if (before === undefined) return;
    const d = BigInt(zat) - BigInt(before);
    if (d <= BigInt(0)) return;
    const id = Date.now();
    setGain({ id, zat: d.toString() });
    const t = setTimeout(() => setGain((g) => (g?.id === id ? null : g)), 4_000);
    return () => clearTimeout(t);
  }, [zat]);
  return gain;
}

export function BalanceCard({ portfolio, onWithdraw }: { portfolio: Portfolio | null; onWithdraw?: () => void }) {
  const gain = useGain(portfolio?.zecBalance);
  const held = portfolio ? BigInt(portfolio.zecHeld) > BigInt(0) : false;

  return (
    <section
      aria-labelledby="balance-title"
      className="relative overflow-hidden rounded-2xl border border-border bg-card/60 p-5 sm:p-7"
    >
      <div aria-hidden className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full bg-zec/[0.05] blur-3xl" />
      <div className="relative flex items-center justify-between gap-3">
        <h2 id="balance-title" className="text-sm text-muted-foreground">
          ZEC balance
        </h2>
        <PeekToggle />
      </div>

      <div className="relative mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {portfolio ? (
          <p className="text-4xl font-medium tracking-tight tabular sm:text-5xl">
            <Veiled>{formatZec(portfolio.zecBalance)}</Veiled>
            <span className="ml-2 text-lg font-normal text-muted-foreground sm:text-xl">ZEC</span>
          </p>
        ) : (
          <Skeleton className="h-12 w-48 rounded-lg bg-skeleton" />
        )}
        <AnimatePresence>
          {gain && (
            <motion.span
              key={gain.id}
              initial={{ opacity: 0, y: 6, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, transition: { duration: 0.3 } }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="text-sm text-zec tabular"
            >
              +<Veiled>{formatZec(gain.zat)}</Veiled> credited
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <p className="relative mt-1 text-sm text-muted-foreground">Available to trade instantly, no QR per trade.</p>

      {portfolio && (held || portfolio.frozen) && (
        <dl className="relative mt-5 grid gap-2 border-t border-border/60 pt-4 text-sm">
          {held && (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Held by queued actions</dt>
              <dd className="tabular">
                <Veiled>{formatZec(portfolio.zecHeld)}</Veiled> ZEC
              </dd>
            </div>
          )}
          {portfolio.frozen && (
            <div className="flex items-start gap-2 rounded-xl bg-zec-soft p-3 text-zec">
              <Snowflake size={16} weight="duotone" className="mt-0.5 shrink-0" aria-hidden />
              <div>
                <dt className="font-medium">Balance on hold</dt>
                <dd className="mt-0.5 text-pretty text-zec/80">
                  A deposit disappeared in a chain reorganization and is being reviewed. Nothing is lost; new actions
                  are paused until the review ends.
                </dd>
              </div>
            </div>
          )}
        </dl>
      )}

      <div className="relative mt-6 flex flex-col gap-2 sm:flex-row">
        <Button asChild size="lg" className="h-11 shrink-0 sm:flex-1 rounded-full text-sm">
          <Link href="/pay">
            <ArrowDown weight="bold" />
            Top up
          </Link>
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="h-11 shrink-0 sm:flex-1 rounded-full border-border bg-surface-1 text-sm hover:border-border-strong hover:bg-surface-2"
          onClick={onWithdraw}
          disabled={!portfolio}
        >
          <ArrowUpRight weight="light" />
          Withdraw
        </Button>
      </div>
    </section>
  );
}
