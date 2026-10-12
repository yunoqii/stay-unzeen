import type { Metadata } from "next";
import Link from "next/link";
import { Key } from "@phosphor-icons/react/ssr";
import { Button } from "@/components/ui/button";
import { EmptyState, PageShell } from "@/components/layout/page-shell";

export const metadata: Metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return (
    <PageShell
      eyebrow="Portfolio"
      title="Your holdings, visible only to you."
      lead="Balances are tied to an anon key that lives in this browser. Not to a wallet, not to an account."
    >
      <EmptyState icon={<Key size={28} weight="thin" />} title="No anon key on this device">
        <p>Create a 12-word key or restore one you already have. It is encrypted here and never sent to the server.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button asChild className="rounded-full px-4">
            <Link href="/key">Set up anon key</Link>
          </Button>
        </div>
      </EmptyState>
    </PageShell>
  );
}
