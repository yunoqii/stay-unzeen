import type { Metadata } from "next";
import { PageShell } from "@/components/layout/page-shell";
import { LaunchApp } from "@/components/launch/launch-app";

export const metadata: Metadata = { title: "Launch" };

export default function LaunchPage() {
  return (
    <PageShell
      eyebrow="Launch"
      title="Launch a token. Stay unzeen."
      lead="Name, ticker, image, venue. The fee comes from your shielded balance and a pool vault deploys it for you."
    >
      <LaunchApp />
    </PageShell>
  );
}
