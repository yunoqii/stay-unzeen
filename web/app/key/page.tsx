import type { Metadata } from "next";
import { PageShell } from "@/components/layout/page-shell";
import { KeyApp } from "@/components/key/key-app";

export const metadata: Metadata = { title: "Anon key" };

export default function KeyPage() {
  return (
    <PageShell
      eyebrow="Anon key"
      title="No email. No wallet. Twelve words."
      lead="Your account is a key made in this browser. It signs what you do; Unzeen only ever sees the signature."
    >
      <KeyApp />
    </PageShell>
  );
}
