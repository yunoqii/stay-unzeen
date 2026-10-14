"use client";

// The static halves of /verify ("why the reserve is attested", "verify it yourself"), per chain: Solana by
// default; Robinhood Chain (EVM, Verify v3) only in builds with NEXT_PUBLIC_HOOD=1. Every hood string sits behind
// the literal env check so a default build carries none of it.

import type { ReactNode } from "react";
import { NETWORK_CONFIG, useNetwork } from "@/lib/network";
import { CoinZec } from "@/components/icons/coin-zec";

interface Step {
  title: string;
  body: string;
  code?: string;
}

interface Copy {
  proven: string;
  bridged: ReactNode;
  attested: string;
  steps: Step[];
}

const DOWNLOAD: Step = {
  title: "Download your proof",
  body: "Unlock your key above, run “Check my balance”, then “Download proof”. The file holds this snapshot and your pieces.",
};

const SOLANA: Copy = {
  proven: "every token and the SOL part of the ZEC cover, held by vaults that signed the snapshot.",
  bridged: (
    <>
      ZEC SPL on the vaults (what ZEC-paired tokens trade against), counted one to one. It is on Solana and signed, but its value rests on the bridge issuer. USDC and USD1 on the vaults
      are listed, never counted.
    </>
  ),
  attested: "the ZEC reserve, signed by the operator and anchored on Solana, so it cannot be changed or shown differently later.",
  steps: [
    DOWNLOAD,
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
  ],
};

const HOOD: Copy | null =
  process.env.NEXT_PUBLIC_HOOD === "1"
    ? {
        proven: "every token and the ETH part of the ZEC cover, held by vaults that signed the snapshot (EIP-712, each vault with its own key).",
        bridged: <>Bridged ZEC, where a vault holds it, counted one to one: on chain and signed, but its value rests on the bridge issuer. Stablecoins on the vaults are listed, never counted.</>,
        attested: "the ZEC reserve, signed by the operator (EIP-191) and anchored on Robinhood Chain, so it cannot be changed or shown differently later.",
        steps: [
          DOWNLOAD,
          {
            title: "Run the checker",
            body: "A single file, no dependencies, Node.js 18 or newer. It recomputes the digest, every EIP-712 and EIP-191 signature, every path and the solvency sums.",
            code: "node verify-proof.mjs unzeen-proof-<chain>-<id>.json --operator <attestation address>",
          },
          {
            title: "Check the vaults on chain",
            body: "Compare the vault balances with any Robinhood Chain RPC you trust, at the snapshot block or later. Native balances are in wei.",
            code: [
              "cast balance <vault> --block <block> --rpc-url <rpc>",
              'cast call <token> "balanceOf(address)(uint256)" <vault> --block <block> --rpc-url <rpc>',
              "curl -s <rpc> -H 'content-type: application/json' \\",
              `  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["<vault>","<block in hex>"]}'`,
            ].join("\n"),
          },
          {
            title: "Check the anchor",
            body: "Look up the attest tx (copy it from the snapshot card) with any RPC or explorer you trust, ideally over Tor. Its input data must be exactly the 32 bytes of the roots digest.",
            code: "cast tx <attest tx> input --rpc-url <rpc>",
          },
        ],
      }
    : null;

export function VerifyExplainers() {
  const network = useNetwork();
  const copy = (NETWORK_CONFIG[network].chain === "hood" && HOOD) || SOLANA;

  return (
    <>
      <section id="why-attested" aria-labelledby="why-t" className="mt-16 scroll-mt-24">
        <div className="ledger md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="p-5 sm:p-6">
            <p className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-faint-foreground uppercase">
              <CoinZec size={12} />
              ZEC reserve
            </p>
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
                  <span className="text-foreground">Proven:</span> <span className="text-muted-foreground">{copy.proven}</span>
                </span>
              </li>
              <li className="flex gap-3">
                <span className="mt-1.5 size-2 shrink-0 rounded-sm bg-zec/55" aria-hidden />
                <span>
                  <span className="text-foreground">Bridged:</span> <span className="text-muted-foreground">{copy.bridged}</span>
                </span>
              </li>
              <li className="flex gap-3">
                <span className="hatch-zec mt-1.5 size-2 shrink-0 rounded-sm border border-zec/40" aria-hidden />
                <span>
                  <span className="text-foreground">Attested:</span> <span className="text-muted-foreground">{copy.attested}</span>
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
          {copy.steps.map((s, i) => (
            <li key={s.title} className="flex min-w-0 flex-col p-5">
              <span className="font-mono text-xs text-faint-foreground">0{i + 1}</span>
              <p className="mt-3 font-medium">{s.title}</p>
              <p className="mt-1.5 text-sm text-pretty text-muted-foreground">{s.body}</p>
              {s.code && <pre className="mt-4 overflow-x-auto rounded-md bg-surface-1 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre text-foreground/85">{s.code}</pre>}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
