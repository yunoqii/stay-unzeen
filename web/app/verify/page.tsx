import type { Metadata } from "next";
import { EyeSlash, Fingerprint, Scales, TreeStructure, UsersThree } from "@phosphor-icons/react/ssr";
import { PageShell } from "@/components/layout/page-shell";
import { VerifyApp } from "@/components/verify/verify-app";

export const metadata: Metadata = {
  title: "Verify",
  description: "Check that the Unzeen pool owes no more than it holds, and that your own balance is in it, in your browser.",
};

const STEPS = [
  {
    title: "Download your proof",
    body: "Unlock your key above, run “Check my balance”, then “Download proof”. The file holds this snapshot and your pieces.",
  },
  {
    title: "Run the checker",
    body: "A single file, no dependencies, Node.js 18 or newer. It recomputes the digest, every signature, every path and the solvency sums.",
    code: "node verify-proof.mjs unzeen-proof-<chain>-<id>.json --operator <attestation key>",
  },
  {
    title: "Check the vaults on chain",
    body: "Compare the vault balances with any Solana RPC you trust, at the snapshot slot or later.",
    code: "solana balance <vault>\nspl-token accounts --owner <vault>",
  },
  {
    title: "Check the anchor",
    body: "Look up the memo tx (copy it from the snapshot card) in any explorer, ideally over Tor. Its memo must be exactly the roots digest.",
  },
];

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

      <section id="why-attested" aria-labelledby="why-t" className="mt-16 scroll-mt-24">
        <div className="ledger md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="p-5 sm:p-6">
            <p className="font-mono text-[10px] tracking-wider text-faint-foreground uppercase">ZEC reserve</p>
            <h2 id="why-t" className="mt-3 text-lg font-medium tracking-tight">
              Why the ZEC reserve is attested, not proven
            </h2>
            <p className="mt-3 text-sm text-pretty text-muted-foreground">
              The pool&apos;s ZEC sits in the shielded pool, where balances are invisible by design. Today there is no way to prove a shielded balance
              without revealing the deposit notes, and revealing them would link deposits to their time and amount, which is the very thing Unzeen
              exists to hide. So the operator signs a statement of the reserve, rounded down, inside the same digest as the roots.
            </p>
          </div>
          <div className="flex flex-col justify-between gap-5 p-5 sm:p-6">
            <ul className="space-y-3 text-sm">
              <li className="flex gap-3">
                <span className="mt-1.5 size-2 shrink-0 rounded-sm bg-zec" aria-hidden />
                <span>
                  <span className="text-foreground">Proven:</span> <span className="text-muted-foreground">every token and the SOL part of the ZEC cover, held by vaults that signed the snapshot.</span>
                </span>
              </li>
              <li className="flex gap-3">
                <span className="hatch-zec mt-1.5 size-2 shrink-0 rounded-sm border border-zec/40" aria-hidden />
                <span>
                  <span className="text-foreground">Attested:</span> <span className="text-muted-foreground">the ZEC reserve, signed by the operator and anchored on Solana, so it cannot be changed or shown differently later.</span>
                </span>
              </li>
            </ul>
            <p className="border-t border-border/60 pt-4 text-xs text-pretty text-faint-foreground">
              Roadmap: a zero-knowledge proof of reserves over the pool&apos;s own shielded notes (the sum is at least X, nothing about the notes is revealed),
              and threshold custody of the pool keys.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="self-t" className="mt-16">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <h2 id="self-t" className="text-lg font-medium tracking-tight">
              Verify it yourself
            </h2>
            <p className="mt-1 text-sm text-pretty text-muted-foreground">Do not take this page&apos;s word for it either. Everything it checks, you can check offline.</p>
          </div>
          <a
            href="/verify/verify-proof.mjs"
            download
            className="inline-flex h-10 shrink-0 items-center justify-center rounded-full border border-border px-4 text-sm transition-colors duration-150 hover:border-zec/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Download verify-proof.mjs
          </a>
        </div>
        <ol className="ledger sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex flex-col p-5">
              <span className="font-mono text-xs text-faint-foreground">0{i + 1}</span>
              <p className="mt-3 font-medium">{s.title}</p>
              <p className="mt-1.5 text-sm text-pretty text-muted-foreground">{s.body}</p>
              {s.code && <pre className="mt-4 overflow-x-auto rounded-md bg-surface-1 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre text-foreground/85">{s.code}</pre>}
            </li>
          ))}
        </ol>
      </section>

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
