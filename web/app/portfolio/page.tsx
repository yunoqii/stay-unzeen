import type { Metadata } from "next";
import { PageShell } from "@/components/layout/page-shell";
import { PortfolioApp } from "@/components/portfolio/portfolio-app";

export const metadata: Metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return (
    <PageShell
      eyebrow="Portfolio"
      title="Your holdings, visible only to you."
      lead="Balances belong to an anon key that lives in this browser. Not to a wallet, not to an account."
    >
      <PortfolioApp />
    </PageShell>
  );
}
