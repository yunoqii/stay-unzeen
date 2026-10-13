"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Coins } from "@phosphor-icons/react";
import { ApiError, errorText } from "@/lib/api/client";
import type { PoolInfo, Portfolio, Token } from "@/lib/api/types";
import { lastRate, submitAction } from "@/lib/activity";
import { formatSol, formatZec, lamportsToSol, shortAddr } from "@/lib/format";
import { nativeOf, useNetwork } from "@/lib/network";
import { canClaim, claimAmount, minClaimZat } from "@/lib/claim";
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
  const owed = (v: string | undefined) => !!v && /^\d+$/.test(v) && BigInt(v) > N0;
  // v0.14: SOL / USDC / USD1 pairs owe lamports, ZEC pairs owe zatoshis (credited 1:1).
  const rows = (claimable ?? []).filter((c) => owed(c.solAmount) || owed(c.zecAmount));
  if (rows.length === 0) return null;

  const last = lastRate(network, "sell");
  const sellRate = pool?.rate ? BigInt(pool.rate.lamportsPerZecSell) : last ? BigInt(last.lamportsPerZec) : null;
  const min = minClaimZat(pool);
  const amountOf = (r: (typeof rows)[number]) => claimAmount(r.solAmount, r.zecAmount, sellRate);
  const totalAmount = claimAmount(
    rows.reduce((s, r) => s + (owed(r.solAmount) ? BigInt(r.solAmount) : N0), N0),
    rows.reduce((s, r) => s + (owed(r.zecAmount) ? BigInt(r.zecAmount!) : N0), N0),
    sellRate,
  );
  const symbolOf = (mint: string) => {
    const t = tokens?.find((x) => x.mint === mint);
    return t ? `$${t.symbol}` : shortAddr(mint, 4, 4);
  };

  const claim = async (mint?: string) => {
    const id = mint ?? "all";
    setBusy(id);
    setError(null);
    const row = mint ? rows.find((r) => r.mint === mint) : undefined;
    const a = row ? amountOf(row) : totalAmount;
    try {
      await submitAction(network, mint ? { op: "claim", mint } : { op: "claim" }, { op: "claim", mint, amount: (a.totalZat ?? a.zat).toString() });
      toast.success("Creator fees claimed", {
        description: a.totalZat !== null ? `≈ ${formatZec(a.totalZat.toString())} ZEC added to your balance. No on-chain transaction.` : "Added to your ZEC balance. No on-chain transaction.",
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
          const a = amountOf(r);
          const ok = canClaim(a, min);
          return (
            <li key={r.mint} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{symbolOf(r.mint)}</p>
                <p className="tabular text-xs text-faint-foreground">
                  {a.lamports > N0 && (
                    <>
                      <Veiled>{formatSol(lamportsToSol(a.lamports.toString()))}</Veiled> {nativeOf(network).symbol}
                    </>
                  )}
                  {a.lamports > N0 && a.zat > N0 && " + "}
                  {a.zat > N0 && (
                    <>
                      <Veiled>{formatZec(a.zat.toString())}</Veiled> ZEC
                    </>
                  )}
                  {a.lamports > N0 && a.totalZat !== null && (
                    <>
                      {" "}
                      · ≈ <Veiled>{formatZec(a.totalZat.toString())}</Veiled> ZEC
                    </>
                  )}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => claim(r.mint)}
                disabled={busy !== null || !ok}
                title={!ok ? "Below the pool minimum for now" : undefined}
                className="h-8 rounded-full px-3.5 text-xs"
              >
                {busy === r.mint ? "Claiming…" : "Claim"}
              </Button>
            </li>
          );
        })}
      </ul>

      {rows.length > 1 && (
        <Button onClick={() => claim()} disabled={busy !== null || !canClaim(totalAmount, min)} className="relative mt-3 h-10 w-full rounded-full">
          {busy === "all" ? "Claiming…" : "Claim all"}
        </Button>
      )}
      {error && (
        <p role="alert" className="relative mt-2 text-xs text-sell">
          {error}
        </p>
      )}
      <p className="relative mt-3 text-[11px] text-pretty text-faint-foreground">
        Fees from tokens you launched. The pool collects them on its own schedule, every 6–12 hours, for every creator at once. Claiming credits ZEC inside the ledger: SOL fees at the pool’s sell
        rate, fees of ZEC pairs one to one. No on-chain transaction, nothing that ties your launches together.
      </p>
    </section>
  );
}
