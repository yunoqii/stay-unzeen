"use client";

import Link from "next/link";
import { Lightning, Star } from "@phosphor-icons/react";
import type { PulseToken } from "@/lib/api/types";
import { useNow } from "@/hooks/use-now";
import { usePulse } from "@/hooks/use-pulse";
import { useKeyState } from "@/lib/crypto/session";
import { useTradeSettings } from "@/lib/trade-settings";
import { useNetwork } from "@/lib/network";
import { EmptyState } from "@/components/layout/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { PulseCard } from "./pulse-card";

const COLUMNS = [
  { id: "new", title: "New", hint: "Just launched, on the curve" },
  { id: "graduating", title: "About to graduate", hint: "" },
  { id: "graduated", title: "Graduated", hint: "Left the curve, trading on the AMM" },
] as const;

export function PulseApp() {
  const { board, error } = usePulse();
  const now = useNow(10_000);
  const key = useKeyState();
  const network = useNetwork();
  const settings = useTradeSettings(network);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5">
          <Lightning size={13} aria-hidden className="text-zec" />
          {key.status === "unlocked"
            ? settings.oneTap
              ? `Instant trade is on: “Buy ${settings.buyPresets[0]}” signs right away.`
              : `“Buy ${settings.buyPresets[0]}” asks once to confirm. Instant trade is off.`
            : "Unlock your key to buy from a card."}{" "}
          <Link href="/portfolio#settings" className="underline-offset-4 hover:text-foreground hover:underline">
            Settings
          </Link>
        </p>
        <Link href="/watchlist" className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 hover:border-zec/50 hover:text-foreground">
          <Star size={12} aria-hidden /> Watchlist
        </Link>
      </div>

      {error && !board ? (
        <EmptyState title="Pulse is not available right now">The token list did not load. It retries on its own.</EmptyState>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          {COLUMNS.map((c) => {
            const list = (board?.[c.id] ?? null) as PulseToken[] | null;
            return (
              <section key={c.id} aria-labelledby={`pulse-${c.id}`} className="min-w-0">
                <header className="mb-3 flex items-baseline justify-between gap-2">
                  <h2 id={`pulse-${c.id}`} className="text-sm font-medium">
                    {c.title}
                    {list && <span className="tabular ml-2 text-faint-foreground">{list.length}</span>}
                  </h2>
                  <span className="text-[11px] text-faint-foreground">{c.id === "graduating" ? `Curve ${board?.graduatingPct ?? 70} % and up` : c.hint}</span>
                </header>
                {!list || now === null ? (
                  <div className="space-y-3" aria-hidden>
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="h-40 rounded-2xl bg-skeleton" />
                    ))}
                  </div>
                ) : list.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-border p-6 text-center text-xs text-faint-foreground">Nothing here right now.</p>
                ) : (
                  <ul className="space-y-3 lg:max-h-[calc(100dvh-14rem)] lg:overflow-y-auto lg:overscroll-contain lg:pr-1 lg:[scrollbar-width:thin]">
                    {list.map((t) => (
                      <li key={t.mint}>
                        <PulseCard token={t} now={now} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
      <p className="mt-8 text-[11px] text-pretty text-faint-foreground">
        Everyone gets the same board on the same 15-second rhythm. Stars and quick buys never change what this page asks the server.
      </p>
    </div>
  );
}
