"use client";

import { WarningCircle } from "@phosphor-icons/react";
import { usePool } from "@/hooks/use-pool";
import { usePortfolio } from "@/hooks/use-portfolio";
import { useTokens } from "@/hooks/use-tokens";
import { KeyGate } from "@/components/key/key-gate";
import { BalanceCard } from "./balance-card";
import { DepositsList } from "./deposits-list";
import { HoldingsList } from "./holdings-list";
import { PeekProvider } from "./peek";

export function PortfolioApp() {
  return (
    <KeyGate next="/portfolio">
      <PeekProvider>
        <PortfolioView />
      </PeekProvider>
    </KeyGate>
  );
}

function PortfolioView() {
  const { portfolio, error } = usePortfolio(10_000);
  const { pool } = usePool();
  const { tokens } = useTokens();

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-start">
      <div className="space-y-4">
        {error && (
          <p role="alert" className="flex items-center gap-2 rounded-xl border border-border bg-surface-1 px-4 py-3 text-sm text-muted-foreground">
            <WarningCircle size={16} weight="light" className="shrink-0 text-zec" aria-hidden />
            {error}
          </p>
        )}
        <BalanceCard portfolio={portfolio} />
        <HoldingsList holdings={portfolio?.holdings ?? null} tokens={tokens} />
      </div>
      <DepositsList deposits={portfolio?.deposits ?? null} confirmations={pool?.confirmations} />
    </div>
  );
}
