"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Coins } from "@phosphor-icons/react";
import { ApiError, errorText } from "@/lib/api/client";
import type { PoolInfo, Portfolio, Token } from "@/lib/api/types";
import { lastRate, submitAction } from "@/lib/activity";
import { formatSol, formatZec, lamportsToSol, shortAddr } from "@/lib/format";
import { useNetwork } from "@/lib/network";
import { lamportsToZat } from "@/lib/trade";
import { Button } from "@/components/ui/button";
import { Veiled } from "./peek";

const N0 = BigInt(0);

/**
 * Creator fees owed to this key (Portfolio.claimable, owner-only). Claim is a ledger operation: the
 * lamports are credited as ZEC at the pool's sell rate, with no on-chain transaction, so claiming
 * never ties your launches together. Shown only here; no creator numbers anywhere public.
 */
export function CreatorFees({ claimable, tokens, pool }: { claimable: Portfolio["claimable"] | null; tokens: Token[] | null; pool: PoolInfo | null }) {
  const network = useNetwork();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = (claimable ?? []).filter((c) => /^\d+$/.test(c.solAmount) && BigInt(c.solAmount) > N0);
  if (rows.length === 0) return null;

  const sellRate = pool?.rate ? BigInt(pool.rate.lamportsPerZecSell) : lastRate(network, "sell") ? BigInt(lastRate(network, "sell")!.lamportsPerZec) : null;
  const minAction = pool ? BigInt(pool.minActionZat) : null;
  const zatOf = (lamports: bigint) => (sellRate ? lamportsToZat(lamports, sellRate) : null);
  const total = rows.reduce((s, r) => s + BigInt(r.solAmount), N0);
  const symbolOf = (mint: string) => {
    const t = tokens?.find((x) => x.mint === mint);
    return t ? `$${t.symbol}` : shortAddr(mint, 4, 4);
  };
  const tooSmall = (lamports: bigint) => {
    const z = zatOf(lamports);
    return z !== null && minAction !== null && z < minAction;
  };

  const claim = async (mint?: string) => {
    const id = mint ?? "all";
    setBusy(id);
    setError(null);
    const lamports = mint ? BigInt(rows.find((r) => r.mint === mint)?.solAmount ?? "0") : total;
    try {
      const it = await submitAction(network, mint ? { op: "claim", mint } : { op: "claim" }, { op: "claim", mint, amount: (zatOf(lamports) ?? N0).toString() });
      const rate = it.status.rate ? BigInt(it.status.rate.lamportsPerZec) : sellRate;
      toast.success("Creator fees claimed", {
        description: rate ? `≈ ${formatZec(lamportsToZat(lamports, rate).toString())} ZEC added to your balance. No on-chain transaction.` : "Added to your ZEC balance. No on-chain transaction.",
      });
    } catch (e) {
      setError(e instanceof ApiError && e.code === "below_minimum" ? "Below the pool minimum for now. Let it build up and claim later." : errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="fees-title" className="relative overflow-hidden rounded-2xl border border-border bg-card/60 p-5 sm:p-6">
      <div aria-hidden className="pointer-events-none absolute -bottom-20 -left-16 size-52 rounded-full bg-zec/[0.04] blur-3xl" />
      <div className="relative flex items-baseline justify-between gap-3">
        <h2 id="fees-title" className="flex items-center gap-2 font-medium">
          <Coins size={16} weight="light" className="text-zec" aria-hidden />
          Creator fees
        </h2>
        <p className="text-xs text-faint-foreground">Only you see this</p>
      </div>

      <ul className="relative mt-3 divide-y divide-border/60">
        {rows.map((r) => {
          const lamports = BigInt(r.solAmount);
          const z = zatOf(lamports);
          const small = tooSmall(lamports);
          return (
            <li key={r.mint} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{symbolOf(r.mint)}</p>
                <p className="tabular text-xs text-faint-foreground">
                  <Veiled>{formatSol(lamportsToSol(r.solAmount))}</Veiled> SOL
                  {z !== null && (
                    <>
                      {" "}
                      · ≈ <Veiled>{formatZec(z.toString())}</Veiled> ZEC
                    </>
                  )}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => claim(r.mint)}
                disabled={busy !== null || small}
                title={small ? "Below the pool minimum for now" : undefined}
                className="h-8 rounded-full px-3.5 text-xs"
              >
                {busy === r.mint ? "Claiming…" : "Claim"}
              </Button>
            </li>
          );
        })}
      </ul>

      {rows.length > 1 && (
        <Button onClick={() => claim()} disabled={busy !== null || tooSmall(total)} className="relative mt-3 h-10 w-full rounded-full">
          {busy === "all" ? "Claiming…" : "Claim all"}
        </Button>
      )}
      {error && (
        <p role="alert" className="relative mt-2 text-xs text-sell">
          {error}
        </p>
      )}
      <p className="relative mt-3 text-[11px] text-pretty text-faint-foreground">
        Fees from tokens you launched. The pool collects them on its own schedule, every 6–12 hours, for every creator at once. Claiming credits ZEC at the pool’s sell
        rate inside the ledger: no on-chain transaction, nothing that ties your launches together.
      </p>
    </section>
  );
}
