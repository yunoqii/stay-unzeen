import type { Metadata } from "next";
import { PageShell } from "@/components/layout/page-shell";
import { CreatorApp } from "@/components/creator/creator-app";

export const metadata: Metadata = { title: "Creator" };

export default function CreatorPage() {
  return (
    <PageShell
      eyebrow="Creator"
      title="Your launches. Only you can see this."
      lead="Fees, volume and holders of the tokens your anon key launched. Nothing here is published anywhere else."
    >
      <CreatorApp />
    </PageShell>
  );
}
