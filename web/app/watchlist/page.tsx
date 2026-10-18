import type { Metadata } from "next";
import { PageShell } from "@/components/layout/page-shell";
import { WatchlistApp } from "@/components/trading/watchlist-app";

export const metadata: Metadata = { title: "Watchlist" };

export default function WatchlistPage() {
  return (
    <PageShell eyebrow="Watchlist" title="Your tokens. Only you know which." lead="Kept encrypted with your anon key on this device. Prices come from the same public lists everyone sees.">
      <WatchlistApp />
    </PageShell>
  );
}
