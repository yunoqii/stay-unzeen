import type { Metadata } from "next";
import { Lightning, RocketLaunch, Timer } from "@phosphor-icons/react/ssr";
import { EmptyState, PageShell } from "@/components/layout/page-shell";

export const metadata: Metadata = { title: "Launch" };

const OPTIONS = [
  {
    icon: RocketLaunch,
    title: "pump.fun",
    body: "Bonding curve, graduates to PumpSwap. The pool creates the token; your wallet never appears.",
  },
  {
    icon: Lightning,
    title: "Meteora DBC",
    body: "Dynamic bonding curve with configurable migration. Same privacy, different curve.",
  },
  {
    icon: Timer,
    title: "Fair launch",
    body: "Sealed bids during a short window, one price for everyone at reveal. No snipers.",
  },
];

export default function LaunchPage() {
  return (
    <PageShell
      eyebrow="Launch"
      title="Launch a token. Stay unzeen."
      lead="Name, ticker, image, venue. Pay the fee in shielded ZEC and the pool deploys it for you."
    >
      <ul className="grid gap-3 sm:grid-cols-3">
        {OPTIONS.map(({ icon: Icon, title, body }) => (
          <li key={title} className="rounded-2xl border border-border p-5">
            <Icon size={22} weight="thin" className="text-muted-foreground" />
            <p className="mt-4 font-medium">{title}</p>
            <p className="mt-1.5 text-sm text-pretty text-muted-foreground">{body}</p>
          </li>
        ))}
      </ul>
      <EmptyState title="Launch form is on its way" className="mt-6">
        The form and the ZIP-321 payment step land in the next build.
      </EmptyState>
    </PageShell>
  );
}
