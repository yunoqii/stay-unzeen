import { Key, QrCode, ArrowsLeftRight, ArrowSquareOut } from "@phosphor-icons/react/ssr";
import { Section, SectionHeading } from "./section";
import { FlowDiagram } from "./flow-diagram";

// A real sequence: you cannot top up without a key or trade without a balance, so the steps are numbered.
const STEPS = [
  {
    icon: Key,
    title: "Make a key",
    body: "Your browser writes 12 words and derives an anon key from them. The phrase is encrypted on your device and never sent anywhere. No email, no wallet.",
  },
  {
    icon: QrCode,
    title: "Top up once",
    body: "Scan a ZIP-321 QR code with ZODL or any shielded Zcash wallet. Address, amount and a signed memo are in the code. It is the only Zcash transaction you make.",
  },
  {
    icon: ArrowsLeftRight,
    title: "Trade and launch",
    body: "Buy, sell or launch from your ZEC balance with a signed request. A pool vault does it on pump.fun, Meteora DBC or Jupiter. The feed says “unzeen”.",
  },
  {
    icon: ArrowSquareOut,
    title: "Leave quietly",
    body: "Take ZEC out to any shielded address, or tokens to a fresh address with a gas drop. Both always leave after a random delay.",
  },
];

export function HowItWorks() {
  return (
    <Section id="how" labelledBy="how-title">
      <SectionHeading id="how-title" lead="Pay in shielded ZEC." turn="The pool trades for you.">
        <p>
          You never sign a launchpad transaction yourself. You fund one private balance, and the pool’s vaults act on it. The chain sees the vault. Only the pool’s ledger knows the vault
          acted for your key.
        </p>
      </SectionHeading>

      <ol className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map(({ icon: Icon, title, body }, i) => (
          <li key={title} className="flex flex-col bg-background p-6 sm:p-7">
            <div className="flex items-center justify-between">
              <Icon size={24} weight="light" aria-hidden className="text-zec" />
              <span className="font-mono text-xs text-faint-foreground tabular">{String(i + 1).padStart(2, "0")}</span>
            </div>
            <h3 className="mt-8 text-lg font-medium tracking-tight">{title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-pretty text-muted-foreground">{body}</p>
          </li>
        ))}
      </ol>

      <FlowDiagram />
    </Section>
  );
}
