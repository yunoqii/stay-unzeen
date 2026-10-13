"use client";

import { CheckCircle, XCircle } from "@phosphor-icons/react";
import type { VerifySnapshot } from "@/lib/api/types";
import { shortAddr } from "@/lib/format";
import { assetLabel, fmtAmount } from "@/lib/verify/display";
import { parseUint, type SnapshotCheck } from "@/lib/verify/merkle-sum";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";

/**
 * Pool vaults at the snapshot slot, each with its ed25519 signature checked here. Addresses are
 * copy-only (no explorer links from this page: a click would tell a third party who is checking).
 */
export function VaultList({ snap, check, symbols }: { snap: VerifySnapshot; check: SnapshotCheck; symbols: Map<string, string> }) {
  const decimals = new Map(snap.trees.map((t) => [t.asset, t.decimals]));
  // v0.13: the pool's quote assets sit on the vaults too (no liability tree): name them, use their decimals.
  const quotes = new Map((snap.quoteAssets ?? []).map((q) => [q.mint, q]));
  return (
    <ul className="ledger sm:grid-cols-2 lg:grid-cols-4">
      {snap.vaults.map((v) => {
        const ok = check.vaults[v.address];
        return (
          <li key={v.address} className="flex flex-col p-4">
            <div className="flex items-center justify-between gap-2">
              <CopyButton value={v.address} label="Copy vault address" toastText="Address copied" className="gap-1.5 font-mono text-xs text-muted-foreground">
                {shortAddr(v.address, 5, 5)}
              </CopyButton>
              <span className={cn("inline-flex items-center gap-1 text-[11px]", ok ? "text-zec" : "text-sell")}>
                {ok ? <CheckCircle size={11} weight="fill" aria-hidden /> : <XCircle size={11} weight="fill" aria-hidden />}
                {ok ? "signed" : "bad signature"}
              </span>
            </div>
            <p className="mt-4 font-mono text-xl tabular">
              {fmtAmount(parseUint(v.lamports) ?? BigInt(0), 9, 3)} <span className="text-sm text-faint-foreground">SOL</span>
            </p>
            {v.tokens.length > 0 ? (
              <ul className="mt-3 space-y-1 border-t border-border/60 pt-3 text-xs">
                {v.tokens.map((t) => (
                  <li key={t.mint} className="flex justify-between gap-3">
                    <span className="truncate text-muted-foreground">
                      {quotes.has(t.mint) ? (
                        <>
                          {quotes.get(t.mint)!.quote === "ZEC" ? "ZEC SPL" : quotes.get(t.mint)!.quote}
                          <span className="text-faint-foreground"> · {quotes.get(t.mint)!.bridged ? "bridged" : "quote"}</span>
                        </>
                      ) : (
                        assetLabel(t.mint, symbols)
                      )}
                    </span>
                    <span className="font-mono text-foreground/90 tabular">
                      {quotes.has(t.mint)
                        ? fmtAmount(parseUint(t.amount) ?? BigInt(0), quotes.get(t.mint)!.decimals, 2)
                        : fmtAmount(parseUint(t.amount) ?? BigInt(0), decimals.get(t.mint) ?? 6, 0)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 border-t border-border/60 pt-3 text-xs text-faint-foreground">SOL only</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
