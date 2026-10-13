"use client";

import { useId, useState } from "react";
import { motion } from "motion/react";
import { onTabListKeyDown } from "@/lib/tabs";
import { cn } from "@/lib/utils";
import type { LiveFeed } from "@/hooks/use-live-feed";
import { useChat } from "@/hooks/use-chat";
import { usePool } from "@/hooks/use-pool";
import { ChatPanel } from "@/components/chat/chat-panel";
import { TokenTrades } from "./token-trades";

type Tab = "trades" | "chat";

/**
 * Trades and, when the server has it (PoolInfo.features.chat), the token's anonymous chat. The chat is
 * polled on its fixed rhythm whichever tab is shown, so switching tabs changes nothing on the wire.
 */
export function TokenActivity({ mint, feed }: { mint: string; feed: LiveFeed }) {
  const id = useId();
  const { pool } = usePool();
  const chatOn = pool?.features?.chat === true;
  const chat = useChat(mint, chatOn);
  const [tab, setTabState] = useState<Tab>("trades");
  const [seen, setSeen] = useState<string | null>(null);
  const setTab = (t: Tab) => {
    if (tab === "chat" && t !== "chat") setSeen(chat.state.cursor);
    setTabState(t);
  };

  // Unread = messages that arrived after you last looked (the backlog of the first load does not count).
  const since = seen ?? chat.initialCursor;
  const unread = since === null || tab === "chat" ? 0 : chat.items.filter((m) => !m.removed && BigInt(m.seq) > BigInt(since)).length;

  if (!chatOn) return <TokenTrades mint={mint} feed={feed} />;

  const tabs = (
    <div role="tablist" aria-label="Token activity" onKeyDown={(e) => onTabListKeyDown(e)} className="flex gap-0.5 rounded-full border border-border p-0.5">
      {(["trades", "chat"] as const).map((t) => {
        const on = tab === t;
        return (
          <button
            key={t}
            id={`${id}-${t}`}
            role="tab"
            type="button"
            aria-selected={on}
            aria-controls={`${id}-${t}-panel`}
            tabIndex={on ? 0 : -1}
            onClick={() => setTab(t)}
            className={cn(
              "hit relative rounded-full px-3 py-1 text-sm font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {on && <motion.span layoutId={`${id}-tab`} className="absolute inset-0 rounded-full bg-surface-3" transition={{ type: "spring", bounce: 0, duration: 0.25 }} />}
            <span className="relative inline-flex items-center gap-1.5">
              {t === "trades" ? "Trades" : "Chat"}
              {t === "chat" && unread > 0 && (
                <span className="tabular rounded-full bg-zec px-1.5 text-[10px] leading-4 text-background">
                  {unread > 99 ? "99+" : unread}
                  <span className="sr-only"> new</span>
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );

  return tab === "trades" ? (
    <div id={`${id}-trades-panel`} role="tabpanel" aria-labelledby={`${id}-trades`} className="min-w-0">
      <TokenTrades mint={mint} feed={feed} heading={tabs} />
    </div>
  ) : (
    <section id={`${id}-chat-panel`} role="tabpanel" aria-labelledby={`${id}-chat`} className="flex min-w-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">{tabs}</header>
      <ChatPanel mint={mint} feed={chat} params={pool?.chat} />
    </section>
  );
}
