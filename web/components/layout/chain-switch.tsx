"use client";

import { useId } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { CHAIN_LABEL, chainOf, lastSolanaNetwork, setNetwork, useNetwork, type Chain } from "@/lib/network";
import { cn } from "@/lib/utils";
import { CoinEth } from "@/components/icons/coin-eth";
import { CoinSol } from "@/components/icons/coin-sol";

const CHAINS: readonly Chain[] = ["solana", "hood"];

/**
 * Solana <-> Robinhood Chain (API v0.18: one origin per chain and network). Only in builds with
 * NEXT_PUBLIC_HOOD=1. Robinhood Chain has Mainnet only. Each origin has its own anon key and pool.
 */
export function ChainSwitch() {
  const network = useNetwork();
  const pillId = useId();
  if (process.env.NEXT_PUBLIC_HOOD !== "1") return null;
  const chain = chainOf(network);

  const choose = (c: Chain) => {
    if (c === chain) return;
    const back = lastSolanaNetwork();
    setNetwork(c === "hood" ? "hood" : back);
    if (c === "hood") toast("Robinhood Chain · Mainnet, real funds", { description: "Its anon key is separate from your Solana ones. Trades settle in ETH; you still pay in shielded ZEC." });
    else toast(`Solana · ${back === "devnet" ? "Devnet" : "Mainnet"}`);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Chain"
      className="relative flex h-8 items-center rounded-full border border-border p-0.5 text-xs"
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const next = CHAINS[(CHAINS.indexOf(chain) + 1) % CHAINS.length];
        choose(next);
        (e.currentTarget.querySelector(`[data-chain="${next}"]`) as HTMLElement | null)?.focus();
      }}
    >
      {CHAINS.map((c) => {
        const on = c === chain;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={c === "solana" ? "Solana" : "Robinhood Chain"}
            tabIndex={on ? 0 : -1}
            data-chain={c}
            onClick={() => choose(c)}
            className={cn(
              "hit relative h-full rounded-full px-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:px-3",
              on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {on && <motion.span layoutId={pillId} className="absolute inset-0 rounded-full bg-surface-3" transition={{ type: "spring", bounce: 0, duration: 0.3 }} />}
            <span className="relative inline-flex items-center gap-1 font-mono text-[11px] tracking-wide" title={CHAIN_LABEL[c] === "Robinhood" ? "Robinhood Chain" : CHAIN_LABEL[c]}>
              {c === "solana" ? <CoinSol size={10} className="text-current" /> : <CoinEth size={12} className="text-current" />}
              {c === "solana" ? "SOL" : "HOOD"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
