import type { Metadata } from "next";
import { Eye, ListChecks, Scales } from "@phosphor-icons/react/ssr";
import { EmptyState, PageShell } from "@/components/layout/page-shell";

export const metadata: Metadata = { title: "Verify" };

const STEPS = [
  {
    icon: Eye,
    title: "Viewing key",
    body: "The pool publishes a viewing key. Anyone can see what came in, without seeing who sent it.",
  },
  {
    icon: ListChecks,
    title: "Match the trades",
    body: "Every feed event links to a public Solana transaction from a pool vault.",
  },
  {
    icon: Scales,
    title: "Check solvency",
    body: "Vault holdings on Solana should cover the private ledger, token by token.",
  },
];

export default function VerifyPage() {
  return (
    <PageShell
      eyebrow="Verify"
      title="Don't trust. Verify."
      lead="Unzeen hides who trades, not what the pool does. Here is how to check it is honest."
    >
      <ol className="grid gap-3 sm:grid-cols-3">
        {STEPS.map(({ icon: Icon, title, body }, i) => (
          <li key={title} className="rounded-2xl border border-border p-5">
            <div className="flex items-center justify-between">
              <Icon size={22} weight="thin" className="text-muted-foreground" />
              <span className="font-mono text-xs text-faint-foreground">0{i + 1}</span>
            </div>
            <p className="mt-4 font-medium">{title}</p>
            <p className="mt-1.5 text-sm text-pretty text-muted-foreground">{body}</p>
          </li>
        ))}
      </ol>
      <EmptyState title="Verification tools are on their way" className="mt-6">
        Viewing key, vault list and the reconciliation report will appear here.
      </EmptyState>
    </PageShell>
  );
}
