"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { WarningCircle } from "@phosphor-icons/react";
import { useActions } from "@/lib/activity";
import { useKeyState } from "@/lib/crypto/session";
import { useNetwork } from "@/lib/network";
import { sealedOn } from "@/lib/features";
import type { FairBid, OwnFairLaunch } from "@/lib/api/types";
import { usePool } from "@/hooks/use-pool";
import { usePortfolio } from "@/hooks/use-portfolio";
import { useTokens } from "@/hooks/use-tokens";
import { KeyGate } from "@/components/key/key-gate";
import { BalanceCard } from "./balance-card";
import { DepositsList } from "./deposits-list";
import { HoldingsList } from "./holdings-list";
import { PeekProvider } from "./peek";
import { SessionActivity } from "./session-activity";
import { SettingsCard } from "./settings-card";
import { WithdrawPanel, type WithdrawTab } from "./withdraw-panel";

// On-demand block, only when the server reports the feature (and the build carries it).
const Sealed =
  process.env.NEXT_PUBLIC_FAIR_LAUNCH_BUILD === "1"
    ? dynamic<{ bids: FairBid[]; launches: OwnFairLaunch[] }>(() => import("@/components/fair/fair-portfolio"), { ssr: false })
    : null;

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
  const { portfolio, error } = usePortfolio();
  const { pool } = usePool();
  const { tokens } = useTokens();
  const [withdraw, setWithdraw] = useState<{ tab: WithdrawTab; mint: string | null } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const key = useKeyState();
  const network = useNetwork();
  const actions = useActions(network, key.status === "unlocked" ? key.pubkey : null);

  const open = (tab: WithdrawTab, mint: string | null = null) => {
    setWithdraw({ tab, mint });
    requestAnimationFrame(() => panel.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <div className="ledger lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-start">
      <div className="ledger-col self-stretch">
        {error && (
          <p role="alert" className="flex items-center gap-2 rounded-xl border border-border bg-surface-1 px-4 py-3 text-sm text-muted-foreground">
            <WarningCircle size={16} weight="light" className="shrink-0 text-zec" aria-hidden />
            {error}
          </p>
        )}
        <BalanceCard portfolio={portfolio} onWithdraw={() => open("zec")} />
        <HoldingsList holdings={portfolio?.holdings ?? null} tokens={tokens} onWithdraw={(m) => open("token", m)} />
        <div aria-hidden className="min-h-0 flex-1" />
      </div>
      <div className="ledger-col self-stretch">
        <AnimatePresence initial={false}>
          {withdraw && portfolio && (
            <motion.div
              key="withdraw"
              initial={{ opacity: 0, y: 12, filter: "blur(8px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: 8, filter: "blur(8px)", transition: { duration: 0.2 } }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <WithdrawPanel
                ref={panel}
                tab={withdraw.tab}
                onTab={(tab) => setWithdraw((w) => (w ? { ...w, tab } : w))}
                mint={withdraw.mint}
                onMint={(mint) => setWithdraw((w) => (w ? { ...w, mint } : w))}
                portfolio={portfolio}
                tokens={tokens}
                pool={pool}
                onClose={() => setWithdraw(null)}
              />
            </motion.div>
          )}
        </AnimatePresence>
        {Sealed && sealedOn(pool) && portfolio && (portfolio.fairBids?.length || portfolio.fairLaunches?.length) ? (
          <Sealed bids={portfolio.fairBids ?? []} launches={portfolio.fairLaunches ?? []} />
        ) : null}
        <SessionActivity actions={actions} />
        <DepositsList deposits={portfolio?.deposits ?? null} confirmations={pool?.confirmations} />
        <SettingsCard />
        <div aria-hidden className="min-h-0 flex-1" />
      </div>
    </div>
  );
}
