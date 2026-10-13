"use client";

import { onTabListKeyDown } from "@/lib/tabs";
import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useLiveFeed } from "@/hooks/use-live-feed";
import { useNow } from "@/hooks/use-now";
import { useTokens } from "@/hooks/use-tokens";
import { cn } from "@/lib/utils";
import { HotTokens } from "@/components/tokens/hot-tokens";
import { CursorShadow } from "@/components/motion/cursor-shadow";
import { Hero } from "./hero";
import { FeedStatusDot, LiveFeed } from "./live-feed";

type Tab = "feed" | "hot";

export function HomeClient() {
  const feed = useLiveFeed({ limit: 50 });
  const createCount = feed.events.filter((e) => e.kind === "create").length;
  const { tokens } = useTokens(createCount);
  const now = useNow(5000);
  const [tab, setTab] = useState<Tab>("feed");
  const hotRef = useRef<HTMLElement>(null);

  const onBuy = () => {
    setTab("hot");
    requestAnimationFrame(() => hotRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <>
      <CursorShadow />
      <Hero onBuy={onBuy} />

      <div className="relative mx-auto max-w-6xl px-0 pt-6 sm:px-6 lg:pt-10">
        <div role="tablist" aria-label="Home sections" onKeyDown={onTabListKeyDown} className="mx-4 mb-4 flex gap-1 rounded-full border border-border p-1 sm:mx-0 lg:hidden">
          {(["feed", "hot"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              tabIndex={tab === t ? 0 : -1}
              aria-controls={`panel-${t}`}
              onClick={() => setTab(t)}
              className={cn(
                "relative flex-1 rounded-full py-2 text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                tab === t ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {tab === t && (
                <motion.span
                  layoutId="home-tab"
                  className="absolute inset-0 rounded-full bg-surface-3"
                  transition={{ type: "spring", bounce: 0, duration: 0.3 }}
                />
              )}
              <span className="relative">{t === "feed" ? "Live feed" : "Hot tokens"}</span>
            </button>
          ))}
        </div>

        {/* The ledger: feed and hot tokens are cells of one hairline frame, with redaction hatch above and below. */}
        <div aria-hidden className="hatch mx-4 h-3 sm:mx-0" />
        <div className="ledger mx-4 sm:mx-0 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section id="panel-feed" aria-labelledby="feed-title" className={cn("min-w-0", tab !== "feed" && "max-lg:hidden")}>
            <header className="flex items-center justify-between border-b border-border/60 px-4 py-3 sm:px-5">
              <h2 id="feed-title" className="flex items-baseline gap-2 text-sm font-medium">
                What unzeen is doing
                <span className="font-mono text-[10px] font-normal tracking-wider text-faint-foreground uppercase">public · on-chain</span>
              </h2>
              <FeedStatusDot status={feed.status} beat={feed.events[0]?.id} updatedAt={feed.updatedAt} />
            </header>
            <LiveFeed events={feed.events} fresh={feed.fresh} loading={feed.loading} error={feed.error} onRetry={feed.retry} />
          </section>

          <aside
            id="panel-hot"
            ref={hotRef}
            aria-labelledby="hot-title"
            className={cn("min-w-0 scroll-mt-20", tab !== "hot" && "max-lg:hidden")}
          >
            <div className="lg:sticky lg:top-[calc(var(--header-h)+var(--banner-h))]">
              <header className="flex items-center justify-between border-b border-border/60 px-4 py-3">
                <h2 id="hot-title" className="text-sm font-medium">
                  Hot tokens
                </h2>
                <span className="text-xs text-faint-foreground">last 10 min</span>
              </header>
              <HotTokens tokens={tokens} events={feed.events} now={now} />
              <Link
                href="/stats"
                className="flex items-center justify-between border-t border-border/60 px-4 py-3 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Platform stats · updated daily
                <ArrowRight size={12} weight="light" aria-hidden />
              </Link>
            </div>
          </aside>
        </div>
        <div aria-hidden className="hatch mx-4 h-3 sm:mx-0" />
      </div>
    </>
  );
}
