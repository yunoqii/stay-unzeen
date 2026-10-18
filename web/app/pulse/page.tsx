import type { Metadata } from "next";
import { PageShell } from "@/components/layout/page-shell";
import { PulseApp } from "@/components/pulse/pulse-app";

export const metadata: Metadata = { title: "Pulse" };

export default function PulsePage() {
  return (
    <PageShell eyebrow="Pulse" title="Fresh, almost there, graduated." lead="New launches, curves close to graduation and tokens that made it, live. Buy from a card with your first preset.">
      <PulseApp />
    </PageShell>
  );
}
