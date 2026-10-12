"use client";

import Link from "next/link";
import { ArrowDown, ArrowCounterClockwise, Tray } from "@phosphor-icons/react";
import type { DepositInfo } from "@/lib/api/types";
import { formatZec, minutesAgo } from "@/lib/format";
import { useNow } from "@/hooks/use-now";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Veiled } from "./peek";

const STATUS: Record<DepositInfo["status"], { label: string; className: string }> = {
  credited: { label: "Credited", className: "text-muted-foreground" },
  refund_pending: { label: "Refund pending", className: "text-zec" },
};

export function DepositsList({ deposits, confirmations }: { deposits: DepositInfo[] | null; confirmations?: number }) {
  const now = useNow(30_000);

  return (
    <section aria-labelledby="deposits-title" className="rounded-2xl border border-border bg-card/60 p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="deposits-title" className="font-medium">
          Deposits
        </h2>
        <p className="text-xs text-faint-foreground">
          Shown after {confirmations ?? 3} confirmations
        </p>
      </div>

      {deposits === null ? (
        <div className="mt-4 space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 rounded-xl bg-skeleton" />
          ))}
        </div>
      ) : deposits.length === 0 ? (
        <div className="mt-4 flex flex-col items-center rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <Tray size={24} weight="thin" className="text-muted-foreground" aria-hidden />
          <p className="mt-3 text-sm font-medium">No deposits yet</p>
          <p className="mt-1 max-w-xs text-sm text-pretty text-muted-foreground">
            Send shielded ZEC once, then trade from the balance.
          </p>
          <Link
            href="/pay"
            className="mt-4 rounded-full text-sm text-zec underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Top up
          </Link>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-border/60">
          {deposits.map((d, i) => {
            const s = STATUS[d.status];
            const Icon = d.status === "credited" ? ArrowDown : ArrowCounterClockwise;
            return (
              <li key={`${d.ts}:${d.amountZat}:${i}`} className="flex items-center gap-3 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-muted-foreground">
                  <Icon size={14} weight="light" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm tabular">
                    +<Veiled>{formatZec(d.amountZat)}</Veiled> ZEC
                  </p>
                  <p className={cn("text-xs", s.className)}>
                    {s.label}
                  </p>
                </div>
                <time dateTime={new Date(d.ts).toISOString()} className="text-xs text-faint-foreground tabular">
                  {now === null ? "" : minutesAgo(d.ts, now)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
