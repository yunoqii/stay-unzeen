import type { Metadata } from "next";
import { PageShell } from "@/components/layout/page-shell";
import { TopUpApp } from "@/components/pay/top-up";

export const metadata: Metadata = { title: "Top up" };

export default function PayPage() {
  return (
    <PageShell
      eyebrow="Top up"
      title="Fund your balance with shielded ZEC."
      lead="One scan from ZODL. After that, every trade comes from your balance, no QR per trade."
    >
      <TopUpApp />
    </PageShell>
  );
}
