"use client";

import dynamic from "next/dynamic";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorText } from "@/lib/api/client";
import { getSigner } from "@/lib/crypto/session";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { ArrowRight, WarningCircle } from "@phosphor-icons/react";
import { useActions } from "@/lib/activity";
import { useKeyState } from "@/lib/crypto/session";
import { useNetwork } from "@/lib/network";
import { sealedOn } from "@/lib/features";
import { StaleNote } from "@/components/ui/states";
import type { FairBid, OwnFairLaunch, Portfolio } from "@/lib/api/types";
import { usePool } from "@/hooks/use-pool";
import { usePortfolio } from "@/hooks/use-portfolio";
import { useTokens } from "@/hooks/use-tokens";
import { KeyGate } from "@/components/key/key-gate";
import { BalanceCard } from "./balance-card";
import { CreatorFees } from "./creator-fees";
import { OrdersCard } from "./orders-card";
import { ScenariosCard } from "./scenarios-card";
import { DepositsList } from "./deposits-list";
import { HoldingsList } from "./holdings-list";
import { PeekProvider } from "./peek";
import { SessionActivity } from "./session-activity";
import { SettingsCard } from "./settings-card";
import { PnlCard } from "./pnl-card";
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
  const { portfolio: page0, error, updatedAt, keyId } = usePortfolio();
  const { pool } = usePool();
  const { tokens } = useTokens();
  const [withdraw, setWithdraw] = useState<{ tab: WithdrawTab; mint: string | null } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const key = useKeyState();
  const network = useNetwork();
  const actions = useActions(network, key.status === "unlocked" ? key.pubkey : null);

  // v0.21: the poll only ever carries holdings page 0. Further pages are fetched on the user's tap ("Show
  // more"), never automatically, and are kept in this view only.
  const [extra, setExtra] = useState<{ keyId: string; pages: number; holdings: Portfolio["holdings"]; more: number } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const mine = extra && extra.keyId === keyId ? extra : null;
  const portfolio = useMemo(() => {
    if (!page0 || !mine) return page0;
    const seen = new Set(page0.holdings.map((h) => h.mint));
    return { ...page0, holdings: [...page0.holdings, ...mine.holdings.filter((h) => !seen.has(h.mint))] };
  }, [page0, mine]);
  const holdingsMore = mine ? mine.more : (page0?.more?.holdings ?? 0);
  const showMore = async () => {
    const signer = getSigner(network);
    if (!signer || !keyId) return;
    setLoadingMore(true);
    try {
      const next = (mine?.pages ?? 0) + 1;
      const r = await api.getPortfolio(signer, next);
      setExtra({ keyId, pages: next, holdings: [...(mine?.holdings ?? []), ...r.holdings], more: r.more?.holdings ?? 0 });
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const open = (tab: WithdrawTab, mint: string | null = null) => {
    setWithdraw({ tab, mint });
    requestAnimationFrame(() => panel.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <div className="ledger lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-start">
      <div className="ledger-col self-stretch max-lg:contents!">
        {error && (
          <p role="alert" className="flex items-center gap-2 rounded-xl border border-border bg-surface-1 px-4 py-3 text-sm text-muted-foreground">
            <WarningCircle size={16} weight="light" className="shrink-0 text-zec" aria-hidden />
            <span className="flex-1">{error}</span>
            <StaleNote at={updatedAt} after={0} />
          </p>
        )}
        <BalanceCard portfolio={portfolio} onWithdraw={() => open("zec")} />
        <HoldingsList holdings={portfolio?.holdings ?? null} tokens={tokens} onWithdraw={(m) => open("token", m)} more={holdingsMore} onShowMore={() => void showMore()} loadingMore={loadingMore} />
        <PnlCard />
        <CreatorFees claimable={portfolio?.claimable ?? null} tokens={tokens} pool={pool} />
        <Link
          href="/creator"
          className="flex items-center justify-between rounded-2xl border border-border px-5 py-3.5 text-sm text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span>
            Creator cabinet <span className="text-faint-foreground">· fees, volume and holders of your launches</span>
          </span>
          <ArrowRight size={14} weight="light" aria-hidden />
        </Link>
        {/* Settings sit under the holdings: the right column grows with withdraw, orders and activity, the left one did not. */}
        {/* On a phone the columns dissolve into one list and Settings goes last, after orders and deposits. */}
        <div className="max-lg:order-last">
          <SettingsCard />
        </div>
        <div aria-hidden className="min-h-0 flex-1 max-lg:hidden" />
      </div>
      <div className="ledger-col self-stretch max-lg:contents!">
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
        {pool?.features?.scenarios && <ScenariosCard scenarios={portfolio?.scenarios} more={portfolio?.more?.scenarios ?? 0} />}
        <OrdersCard orders={portfolio?.orders ?? null} tokens={tokens} more={portfolio?.more?.orders ?? 0} />
        <SessionActivity actions={actions} />
        <DepositsList deposits={portfolio?.deposits ?? null} confirmations={pool?.confirmations} more={portfolio?.more?.deposits ?? 0} />
        <div aria-hidden className="min-h-0 flex-1 max-lg:hidden" />
      </div>
    </div>
  );
}
