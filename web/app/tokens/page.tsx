import type { Metadata } from "next";
import { PageShell } from "@/components/layout/page-shell";
import { TokensApp } from "@/components/tokens/tokens-app";

export const metadata: Metadata = { title: "Tokens" };

export default function TokensPage() {
  return (
    <PageShell
      eyebrow="Tokens"
      title="Everything the pool trades."
      lead="One public list, the same for everyone. Filters and search run in your browser and never leave it."
    >
      <TokensApp />
    </PageShell>
  );
}
