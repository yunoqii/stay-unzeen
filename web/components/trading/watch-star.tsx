"use client";

import Link from "next/link";
import { Star } from "@phosphor-icons/react";
import { useKeyState } from "@/lib/crypto/session";
import { useWorkspace, watch } from "@/lib/workspace/store";
import { cn } from "@/lib/utils";

/**
 * Watchlist star. The list lives encrypted on this device with your key (lib/workspace), so it needs the key
 * unlocked; the server never learns what you watch.
 */
export function WatchStar({ mint, symbol, className, size = 16 }: { mint: string; symbol: string; className?: string; size?: number }) {
  const key = useKeyState();
  const ws = useWorkspace();
  const on = ws.file.watchlist.some((w) => w.mint === mint);
  const base = cn(
    "inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
    on ? "text-zec" : "text-faint-foreground hover:text-foreground",
    className,
  );
  if (key.status !== "unlocked")
    return (
      <Link href={`/key?next=${encodeURIComponent(`/token/${mint}`)}`} aria-label={`Unlock your key to watch $${symbol}`} title="Unlock your key: the watchlist is kept encrypted on this device" className={base}>
        <Star size={size} weight="regular" aria-hidden />
      </Link>
    );
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `Remove $${symbol} from your watchlist` : `Add $${symbol} to your watchlist`}
      title={on ? "On your watchlist (this device only)" : "Watch (kept on this device only)"}
      disabled={!ws.ready}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void watch(key.network, key.pubkey, { mint, symbol });
      }}
      className={base}
    >
      <Star size={size} weight={on ? "fill" : "regular"} aria-hidden />
    </button>
  );
}
