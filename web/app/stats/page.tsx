import type { Metadata } from "next";
import { PageShell } from "@/components/layout/page-shell";
import { StatsApp } from "@/components/stats/stats-app";

export const metadata: Metadata = { title: "Stats" };

export default function StatsPage() {
  return (
    <PageShell
      eyebrow="Stats"
      title="Everything unzeen did, nobody in particular."
      lead="Volume, trades and ZEC through the shielded pool. One snapshot a day, rounded, and nothing under five events."
    >
      <StatsApp />
    </PageShell>
  );
}
