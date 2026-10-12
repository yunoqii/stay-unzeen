"use client";

import { CheckCircle, CircleNotch, Info, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { VerifySnapshot } from "@/lib/api/types";
import { NETWORK_CONFIG, type Network } from "@/lib/network";
import { fmtUtc } from "@/lib/verify/display";
import type { SnapshotCheck } from "@/lib/verify/merkle-sum";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";

type Tone = "ok" | "wait" | "warn" | "bad";

const ICON: Record<Tone, React.ReactNode> = {
  ok: <CheckCircle size={14} weight="fill" className="text-zec" aria-hidden />,
  wait: <CircleNotch size={14} className="animate-spin text-faint-foreground motion-reduce:animate-none" aria-hidden />,
  warn: <Info size={14} weight="fill" className="text-muted-foreground" aria-hidden />,
  bad: <XCircle size={14} weight="fill" className="text-sell" aria-hidden />,
};

/**
 * Snapshot facts and every check this browser ran on them: digest recomputed from the fields,
 * operator signature over THAT digest, operator key vs the one pinned in this build, vault
 * signatures, Solana anchor. The memo-tx is copy-only: a link would tell an explorer who looked.
 */
export function SnapshotHeader({ snap, check, isLatest, pinned, network }: { snap: VerifySnapshot; check: SnapshotCheck; isLatest: boolean; pinned: string | null; network: Network }) {
  const vaultsOk = Object.values(check.vaults).filter(Boolean).length;
  const op = check.operator;
  const rows: { tone: Tone; label: string; detail: React.ReactNode }[] = [
    {
      tone: check.digestOk ? "ok" : "bad",
      label: check.digestOk ? "Digest recomputed" : "Digest does not match",
      detail: check.digestOk ? "From the roots, the reserve, the slot and the height below." : "The fields of this snapshot do not hash to the digest the server sent.",
    },
    {
      tone: op === "verified" ? "ok" : op === "pending" ? "wait" : op === "unpinned" ? "warn" : "bad",
      label:
        op === "verified"
          ? "Operator signature valid"
          : op === "pending"
            ? "Not signed yet"
            : op === "unpinned"
              ? "Signature valid, key not pinned"
              : op === "wrong_key"
                ? "Signed by an unknown key"
                : "Operator signature invalid",
      detail:
        op === "verified"
          ? "Ed25519 over the recomputed digest, by the attestation key pinned in this app."
          : op === "pending"
            ? "The operator signs once the root is anchored on Solana."
            : op === "unpinned"
              ? "This build has no pinned attestation key to compare with. Compare the key with the one in the README."
              : op === "wrong_key"
                ? "The signature checks out, but not with the key this app trusts. Treat this snapshot as untrusted."
                : "The signature does not verify over the recomputed digest.",
    },
    {
      tone: check.allVaultsOk ? "ok" : "bad",
      label: `Vault signatures ${vaultsOk}/${snap.vaults.length}`,
      detail: check.allVaultsOk ? "Every vault signed this snapshot with its own key." : "A vault did not sign this snapshot. Its balance does not count.",
    },
  ];

  return (
    <section aria-labelledby="snap-t" className="ledger lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs tracking-wider text-faint-foreground uppercase">{isLatest ? "Latest snapshot" : "Past snapshot"}</span>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-faint-foreground">{NETWORK_CONFIG[network].label}</span>
        </div>
        <h2 id="snap-t" className="mt-3 text-3xl font-medium tracking-tight tabular">
          #{snap.id}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{fmtUtc(snap.takenAt)}</p>
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-3">
          <Fact k="Solana slot" v={snap.solanaSlot.toLocaleString("en-US")} />
          <Fact k="Zcash height" v={snap.zcashHeight.toLocaleString("en-US")} />
          <Fact k="Leaves per tree" v={snap.leaves.toLocaleString("en-US")} />
        </dl>
        <div className="mt-5">
          <p className="text-xs text-faint-foreground">Roots digest</p>
          <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-surface-1 px-3 py-2">
            <code className="min-w-0 flex-1 font-mono text-[11px] break-all text-foreground/90">{snap.rootsDigest}</code>
            <CopyButton value={snap.rootsDigest} label="Copy roots digest" size={13} />
          </div>
        </div>
      </div>

      <div className="flex flex-col">
        <p className="px-5 pt-5 font-mono text-[10px] tracking-wider text-faint-foreground uppercase sm:px-6">Checked in your browser</p>
        <ul className="divide-y divide-border/60 px-5 sm:px-6">
          {rows.map((r) => (
            <li key={r.label} className="flex gap-3 py-3">
              <span className="mt-0.5">{ICON[r.tone]}</span>
              <div className="min-w-0">
                <p className={cn("text-sm", r.tone === "bad" && "text-sell")}>{r.label}</p>
                <p className="mt-0.5 text-xs text-pretty text-faint-foreground">{r.detail}</p>
              </div>
            </li>
          ))}
          <li className="flex gap-3 py-3">
            <span className="mt-0.5">{ICON[check.anchor === "anchored" ? "ok" : check.anchor === "pending" ? "wait" : "bad"]}</span>
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm", check.anchor === "mismatch" && "text-sell")}>
                {check.anchor === "anchored" ? "Anchored on Solana" : check.anchor === "pending" ? "Not anchored yet" : "Anchor memo does not match"}
              </p>
              {snap.anchor ? (
                <dl className="mt-1 space-y-1 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-faint-foreground">Memo tx</dt>
                    <dd>
                      <CopyButton
                        value={snap.anchor.solanaTx}
                        label="Copy memo transaction signature"
                        toastText="Signature copied"
                        toastDescription="Look it up later, ideally over Tor. Its memo is exactly the roots digest."
                        className="gap-1.5 font-mono"
                      >
                        {shortAddr(snap.anchor.solanaTx, 6, 6)}
                      </CopyButton>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-faint-foreground">Slot</dt>
                    <dd className="font-mono text-muted-foreground tabular">{snap.anchor.slot.toLocaleString("en-US")}</dd>
                  </div>
                  {snap.operator && (
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-faint-foreground">Signer</dt>
                      <dd>
                        <CopyButton value={snap.operator.pubkey} label="Copy attestation key" toastText="Key copied" className="gap-1.5 font-mono">
                          {shortAddr(snap.operator.pubkey, 4, 4)}
                        </CopyButton>
                      </dd>
                    </div>
                  )}
                </dl>
              ) : (
                <p className="mt-0.5 text-xs text-pretty text-faint-foreground">
                  The root goes on Solana as a memo, so it cannot be shown differently to different people. Usually within a minute.
                </p>
              )}
              {check.anchor === "mismatch" && (
                <p role="alert" className="mt-2 flex items-start gap-1.5 rounded-lg bg-sell/10 p-2.5 text-xs text-sell">
                  <WarningCircle size={13} weight="fill" className="mt-px shrink-0" aria-hidden />
                  The memo read back from Solana differs from this digest. Do not trust this snapshot until it is explained.
                </p>
              )}
            </div>
          </li>
        </ul>
        {pinned && op !== "pending" && (
          <p className="mt-auto border-t border-border/60 px-5 py-3 text-[11px] text-faint-foreground sm:px-6">
            Pinned attestation key <span className="font-mono text-muted-foreground">{shortAddr(pinned, 6, 6)}</span>, also published in the README.
          </p>
        )}
      </div>
    </section>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-faint-foreground">{k}</dt>
      <dd className="mt-0.5 font-mono text-sm text-foreground tabular">{v}</dd>
    </div>
  );
}
