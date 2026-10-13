import type { Metadata } from "next";
import { PageShell } from "@/components/layout/page-shell";
import { DocsApp } from "@/components/docs/docs-app";

export const metadata: Metadata = { title: "Docs", description: "How unzeen works: anon key, top up, execution modes, orders, withdrawals, Verify, trust and threat model." };

export default function DocsPage() {
  return (
    <PageShell eyebrow="Docs" title="How to stay unzeen." lead="Everything you need to use unzeen, and an honest list of what it does not hide.">
      <DocsApp />
    </PageShell>
  );
}
