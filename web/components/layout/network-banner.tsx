"use client";

import { Flask, Warning } from "@phosphor-icons/react";
import { NETWORK_CONFIG, useNetwork } from "@/lib/network";
import { cn } from "@/lib/utils";

/** Always-on reminder of which money is at stake. */
export function NetworkBanner() {
  const cfg = NETWORK_CONFIG[useNetwork()];
  return (
    <div
      role="status"
      className={cn(
        "border-b text-xs",
        cfg.realFunds ? "border-zec/20 bg-zec-soft text-zec" : "border-border/60 bg-surface-1 text-muted-foreground",
      )}
    >
      <p className="mx-auto flex h-(--banner-h) max-w-6xl items-center justify-center gap-1.5 px-4 sm:px-6">
        {cfg.realFunds ? <Warning size={13} weight="duotone" aria-hidden /> : <Flask size={13} weight="light" aria-hidden />}
        {process.env.NEXT_PUBLIC_HOOD === "1" && cfg.chain === "hood" ? (
          <span>
            <span className="font-medium">Robinhood Chain Mainnet</span> · Real funds · trades settle in ETH
          </span>
        ) : cfg.realFunds ? (
          <span>
            <span className="font-medium">Mainnet</span> · Real funds
          </span>
        ) : (
          <span>
            <span className="text-foreground">Devnet</span> — test funds only
          </span>
        )}
      </p>
    </div>
  );
}
