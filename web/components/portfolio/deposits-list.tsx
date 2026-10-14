"use client";

import Link from "next/link";
import { ArrowDown, Tray } from "@phosphor-icons/react";
import type { DepositInfo } from "@/lib/api/types";
import { formatDay, formatZec } from "@/lib/format";
import { useNow } from "@/hooks/use-now";
import { Skeleton } from "@/components/ui/skeleton";
import { Veiled } from "./peek";

export function DepositsList({ deposits, confirmations, more = 0 }: { deposits: DepositInfo[] | null; confirmations?: number; more?: number }) {
  const now = useNow(60_000);

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
          {deposits.map((d) => {
            return (
              <li key={d.id} className="flex items-center gap-3 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-muted-foreground">
                  <ArrowDown size={14} weight="light" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm tabular">
                    +<Veiled>{formatZec(d.amountZat)}</Veiled> ZEC
                  </p>
                  <p className="text-xs text-muted-foreground">Credited</p>
                </div>
                <time
                  dateTime={new Date(d.ts).toISOString().slice(0, 10)}
                  title="Rounded to the day, on purpose"
                  className="text-xs text-faint-foreground tabular"
                >
                  {now === null ? "" : formatDay(d.ts, now)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
      {more > 0 && <p className="mt-2 text-[11px] text-faint-foreground">+{more} older {more === 1 ? "deposit" : "deposits"} · the pool lists only the last 5</p>}
    </section>
  );
}
