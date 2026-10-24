"use client";

import { useId } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { chainOf, NETWORKS, NETWORK_CONFIG, setNetwork, useNetwork, type Network } from "@/lib/network";
import { cn } from "@/lib/utils";

const SHORT: Record<Network, string> = { devnet: "Dev", mainnet: "Main", hood: "Main" };

/** Devnet <-> Mainnet. Each side has its own API, explorer, pool and anon key. */
export function NetworkSwitch() {
  const network = useNetwork();
  const pillId = useId();
  // Networks of the selected chain only (v0.18): Solana has Devnet + Mainnet, Robinhood Chain Mainnet only.
  const chain = chainOf(network);
  const list = NETWORKS.filter((n) => NETWORK_CONFIG[n].chain === chain);
  // One network only (Robinhood Chain: Mainnet): nothing to switch; the banner says which money is at stake.
  if (list.length < 2) return null;

  const choose = (n: Network) => {
    if (n === network) return;
    setNetwork(n);
    if (NETWORK_CONFIG[n].realFunds) toast("Mainnet: real funds", { description: "Your Mainnet anon key is separate from Devnet." });
    else toast("Devnet: test funds only");
  };

  return (
    <div
      role="radiogroup"
      aria-label="Network"
      className="relative flex h-8 items-center rounded-full border border-border p-0.5 text-xs"
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const next = list[(list.indexOf(network) + 1) % list.length];
          choose(next);
          (e.currentTarget.querySelector(`[data-network="${next}"]`) as HTMLElement | null)?.focus();
        }
      }}
    >
      {list.map((n) => {
        const active = n === network;
        const real = NETWORK_CONFIG[n].realFunds;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={NETWORK_CONFIG[n].label}
            tabIndex={active ? 0 : -1}
            data-network={n}
            onClick={() => choose(n)}
            className={cn(
              "hit relative h-full rounded-full px-2.5 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:px-3",
              active ? (real ? "text-zec" : "text-foreground") : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId={pillId}
                className={cn("absolute inset-0 rounded-full", real ? "bg-zec/12" : "bg-surface-3")}
                transition={{ type: "spring", bounce: 0, duration: 0.3 }}
              />
            )}
            <span className="relative">
              {/* Short under sm and again md–lg, where the desktop nav shares the row. */}
              <span className="sm:max-md:hidden lg:hidden">{SHORT[n]}</span>
              <span className="hidden sm:max-md:inline lg:inline">{NETWORK_CONFIG[n].label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
