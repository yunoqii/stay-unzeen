import type { Metadata } from "next";
import { EyeSlash, Fingerprint, Scales, TreeStructure, UsersThree } from "@phosphor-icons/react/ssr";
import { PageShell } from "@/components/layout/page-shell";
import { VerifyApp } from "@/components/verify/verify-app";
import { VerifyExplainers } from "@/components/verify/verify-explainers";

export const metadata: Metadata = {
  title: "Verify",
  description: "Check that the Unzeen pool owes no more than it holds, and that your own balance is in it, in your browser.",
};

const HIDDEN = [
  {
    icon: UsersThree,
    title: "How many people use the pool",
    body: "Every tree is padded with dummy leaves to the same size, at least 1,024, and the order is shuffled.",
  },
  {
    icon: Scales,
    title: "Anyone else's balance",
    body: "Each balance is rounded up and split into 2–4 pieces with a fresh random blind every snapshot. A sibling in your path is a subtree total, never a person.",
  },
  {
    icon: Fingerprint,
    title: "Which deposit is whose",
    body: "No notes, no nullifiers, no transaction ids of the pool. Publishing them would tie a deposit to its time and amount.",
  },
  {
    icon: EyeSlash,
    title: "The viewing key",
    body: "Never shown, never published, never given to an auditor: it would reveal every memo, and with it every anon key.",
  },
  {
    icon: TreeStructure,
    title: "Who checked their proof",
    body: "Proofs are not stored in your browser and not counted. The answer is padded to one fixed size, so it says nothing about what you hold.",
  },
];

export default function VerifyPage() {
  return (
    <PageShell
      eyebrow="Verify"
      title="Don't trust. Verify."
      lead="Unzeen hides who trades, not what the pool owes. Every check on this page runs in your browser, against signed and anchored data."
    >
      <VerifyApp />

      <VerifyExplainers />

      <section aria-labelledby="hidden-t" className="mt-16 mb-6">
        <div className="mb-4 max-w-2xl">
          <h2 id="hidden-t" className="text-lg font-medium tracking-tight">
            What we don&apos;t show, and why
          </h2>
          <p className="mt-1 text-sm text-pretty text-muted-foreground">Proving the pool is honest must not cost anyone their privacy. These stay unzeen.</p>
        </div>
        <ul className="ledger sm:grid-cols-2 lg:grid-cols-5">
          {HIDDEN.map(({ icon: Icon, title, body }) => (
            <li key={title} className="p-5">
              <Icon size={20} weight="thin" className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium">{title}</p>
              <p className="mt-1.5 text-xs text-pretty text-muted-foreground">{body}</p>
            </li>
          ))}
        </ul>
        <div aria-hidden className="hatch mt-px h-3" />
      </section>
    </PageShell>
  );
}
