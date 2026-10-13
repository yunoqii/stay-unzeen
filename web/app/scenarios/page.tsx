import type { Metadata } from "next";
import { PageShell } from "@/components/layout/page-shell";
import { ScenariosApp } from "@/components/scenarios/scenarios-app";

export const metadata: Metadata = { title: "Scenarios" };

export default function ScenariosPage() {
  return (
    <PageShell
      eyebrow="Scenarios"
      title="Sign once. The pool does the rest."
      lead="Chain up to 12 blocks: top up, wait, buy, take profit, leave in shielded ZEC. Each step runs in the same batches as a manual trade, and your device sends nothing while it runs."
    >
      <ScenariosApp />
    </PageShell>
  );
}
