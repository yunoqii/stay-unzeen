"use client";

import { useId } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { NETWORKS, NETWORK_CONFIG, setNetwork, useNetwork, type Network } from "@/lib/network";
import { cn } from "@/lib/utils";

const SHORT: Record<Network, string> = { devnet: "Dev", mainnet: "Main" };

/** Devnet <-> Mainnet. Each side has its own API, explorer, pool and anon key. */
export function NetworkSwitch() {
  const network = useNetwork();
  const pillId = useId();

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
          const next = NETWORKS[(NETWORKS.indexOf(network) + 1) % NETWORKS.length];
          choose(next);
          (e.currentTarget.querySelector(`[data-network="${next}"]`) as HTMLElement | null)?.focus();
        }
      }}
    >
      {NETWORKS.map((n) => {
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
              <span className="sm:hidden">{SHORT[n]}</span>
              <span className="hidden sm:inline">{NETWORK_CONFIG[n].label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
