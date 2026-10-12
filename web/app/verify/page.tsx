import type { Metadata } from "next";
import { ListChecks, Scales, TreeStructure } from "@phosphor-icons/react/ssr";
import { EmptyState, PageShell } from "@/components/layout/page-shell";
import { MerkleTrace } from "@/components/verify/merkle-trace";

export const metadata: Metadata = { title: "Verify" };

const STEPS = [
  {
    icon: TreeStructure,
    title: "Find your leaf",
    body: "The pool commits to every balance in a Merkle-sum tree. Your anon key proves your leaf is in it, and nobody else learns your balance.",
  },
  {
    icon: Scales,
    title: "Check the reserves",
    body: "Public vault addresses on Solana and the pool's ZEC reserve must cover the tree's total, token by token.",
  },
  {
    icon: ListChecks,
    title: "Match the trades",
    body: "Every feed event links to a public Solana transaction from a pool vault.",
  },
];

export default function VerifyPage() {
  return (
    <PageShell
      eyebrow="Verify"
      title="Don't trust. Verify."
      lead="Unzeen hides who trades, not what the pool does. Here is how to check it is honest."
    >
      <ol className="ledger sm:grid-cols-3">
        {STEPS.map(({ icon: Icon, title, body }, i) => (
          <li key={title} className="p-5">
            <div className="flex items-center justify-between">
              <Icon size={22} weight="thin" className="text-muted-foreground" />
              <span className="font-mono text-xs text-faint-foreground">0{i + 1}</span>
            </div>
            <p className="mt-4 font-medium">{title}</p>
            <p className="mt-1.5 text-sm text-pretty text-muted-foreground">{body}</p>
          </li>
        ))}
      </ol>
      <h2 className="mt-12 mb-3 text-sm font-medium">What a proof looks like</h2>
      <div className="border border-border">
        <MerkleTrace />
      </div>
      <div aria-hidden className="hatch h-3" />
      <EmptyState title="Verification tools are on their way" className="mt-6">
        Your Merkle-sum proof, the public vault list and the reserve check will appear here.
      </EmptyState>
    </PageShell>
  );
}
