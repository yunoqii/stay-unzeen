"use client";

import { Flask } from "@phosphor-icons/react";
import { NETWORK_CONFIG, useNetwork } from "@/lib/network";

/** Devnet only: a reminder that the funds are test funds. Mainnet shows no banner. */
export function NetworkBanner() {
  const cfg = NETWORK_CONFIG[useNetwork()];
  if (cfg.realFunds) return null;
  return (
    <div role="status" data-network-banner className="border-b border-border/60 bg-surface-1 text-xs text-muted-foreground">
      <p className="mx-auto flex h-(--banner-h) max-w-6xl items-center justify-center gap-1.5 px-4 sm:px-6">
        <Flask size={13} weight="light" aria-hidden />
        <span>
          <span className="text-foreground">Devnet</span> — test funds only
        </span>
      </p>
    </div>
  );
}
