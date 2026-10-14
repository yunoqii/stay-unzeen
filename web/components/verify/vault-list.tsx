"use client";

import { CheckCircle, XCircle } from "@phosphor-icons/react";
import type { VerifySnapshot } from "@/lib/api/types";
import { shortAddr } from "@/lib/format";
import { assetLabel, fmtAmount } from "@/lib/verify/display";
import { parseUint, type SnapshotCheck } from "@/lib/verify/merkle-sum";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";

/**
 * Pool vaults at the snapshot slot / block, each with its signature checked here (ed25519 on Solana, EIP-712 on
 * Robinhood Chain). Addresses are copy-only: no explorer links from this page, a click would tell a third party
 * who is checking. The copy carries a ready explorer link to open later (ideally over Tor).
 */
export function VaultList({ snap, check, symbols }: { snap: VerifySnapshot; check: SnapshotCheck; symbols: Map<string, string> }) {
  const decimals = new Map(snap.trees.map((t) => [t.asset, t.decimals]));
  // v0.13: the pool's quote assets sit on the vaults too (no liability tree): name them, use their decimals.
  const quotes = new Map((snap.quoteAssets ?? []).map((q) => [q.mint, q]));
  const evm = snap.digestVersion === 3;
  const native = evm ? { symbol: "ETH", decimals: 18 } : { symbol: "SOL", decimals: 9 };
  const explorer = (a: string) =>
    evm ? `${process.env.NEXT_PUBLIC_HOOD !== "1" ? "" : snap.chainId === "0212" ? "https://explorer.testnet.chain.robinhood.com" : "https://robinhoodchain.blockscout.com"}/address/${a}` : a;
  return (
    <ul className="ledger sm:grid-cols-2 lg:grid-cols-4">
      {snap.vaults.map((v) => {
        const ok = check.vaults[v.address];
        return (
          <li key={v.address} className="flex flex-col p-4">
            <div className="flex items-center justify-between gap-2">
              <CopyButton
                value={explorer(v.address)}
                label={evm ? "Copy the vault's explorer link" : "Copy vault address"}
                toastText={evm ? "Explorer link copied" : "Address copied"}
                toastDescription={evm && process.env.NEXT_PUBLIC_HOOD === "1" ? "Chain 4663 (Robinhood Chain). Open it later, ideally over Tor." : undefined}
                className="gap-1.5 font-mono text-xs text-muted-foreground"
              >
                {shortAddr(v.address, 5, 5)}
              </CopyButton>
              <span className={cn("inline-flex items-center gap-1 text-[11px]", ok ? "text-zec" : "text-sell")}>
                {ok ? <CheckCircle size={11} weight="fill" aria-hidden /> : <XCircle size={11} weight="fill" aria-hidden />}
                {ok ? (evm ? "Signed ✓ · EIP-712" : "Signed ✓") : "bad signature"}
              </span>
            </div>
            <p className="mt-4 font-mono text-xl tabular">
              {fmtAmount(parseUint(v.lamports) ?? BigInt(0), native.decimals, evm ? 5 : 3)} <span className="text-sm text-faint-foreground">{native.symbol}</span>
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
              <p className="mt-3 border-t border-border/60 pt-3 text-xs text-faint-foreground">{native.symbol} only</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
