import type { Metadata } from "next";
import { Lightning, RocketLaunch, Timer } from "@phosphor-icons/react/ssr";
import { EmptyState, PageShell } from "@/components/layout/page-shell";
import { FairReveal } from "@/components/launch/fair-reveal";
import { LaunchRulesCard } from "@/components/launch/launch-rules-card";

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
      <ul className="ledger sm:grid-cols-3">
        {OPTIONS.map(({ icon: Icon, title, body }) => (
          <li key={title} className="group relative p-5 transition-colors duration-200 hover:bg-surface-1">
            <span aria-hidden className="absolute inset-x-0 top-0 h-px origin-left scale-x-0 bg-zec/70 transition-transform duration-300 ease-shadow group-hover:scale-x-100 motion-reduce:transition-none" />
            <Icon size={22} weight="thin" className="text-muted-foreground transition-colors duration-200 group-hover:text-zec" />
            <p className="mt-4 font-medium">{title}</p>
            <p className="mt-1.5 text-sm text-pretty text-muted-foreground">{body}</p>
          </li>
        ))}
      </ul>
      <div className="mt-6 border border-border">
        <LaunchRulesCard />
      </div>
      <h2 className="mt-12 mb-3 text-sm font-medium">How a fair launch reveals</h2>
      <div className="border border-border">
        <FairReveal />
      </div>
      <div aria-hidden className="hatch h-3" />
      <EmptyState title="Launch form is on its way" className="mt-6">
        The form and the payment from your balance land in the next build.
      </EmptyState>
    </PageShell>
  );
}
