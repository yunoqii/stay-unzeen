"use client";

import { motion, useReducedMotion } from "motion/react";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { coverageBps, type SolvencyRow } from "@/lib/verify/merkle-sum";
import { assetLabel, fmtAmount, fmtPct } from "@/lib/verify/display";
import { cn } from "@/lib/utils";

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * One row per tree. Mints: liabilities ≤ Σ signed vault balances, fully checkable. SOL (creator fees
 * owed): ≤ spare vault SOL, which it takes first. ZEC: the cover is
 * spare SOL on the vaults (proven) plus the operator's reserve statement (attested), drawn as two
 * segments of one bar, so the attested part is never mistaken for a proof.
 */
export function SolvencyTable({ rows, symbols }: { rows: SolvencyRow[]; symbols: Map<string, string> }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No liabilities in this snapshot.</p>;
  return (
    <div className="border border-border">
      <div className="hidden grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] gap-4 border-b border-border px-4 py-2.5 font-mono text-[10px] tracking-wider text-faint-foreground uppercase md:grid">
        <span>Asset</span>
        <span className="text-right">Liabilities</span>
        <span className="text-right">Assets</span>
        <span>Coverage</span>
        <span>Status</span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r, i) => (
          <Row key={r.asset} r={r} label={assetLabel(r.asset, symbols)} i={i} />
        ))}
      </ul>
    </div>
  );
}

function Row({ r, label, i }: { r: SolvencyRow; label: string; i: number }) {
  const bps = coverageBps(r.assets, r.liabilities);
  const sol = r.asset === "SOL";
  const unit = r.asset === "ZEC" ? "ZEC" : sol ? "SOL" : "";
  const zec = r.kind === "proven_attested";
  const ok = r.covered && r.vaultsSigned;
  // Mint trees are in whole tokens (granule = 1 token): no fractions next to them.
  // Fraction digits follow the tree's granule (review E1: a mint granule may be 1 base unit), at most 3.
  const frac = zec || sol ? 3 : Math.min(3, Math.max(0, r.decimals - granuleExp(r.granule)));
  const unknown = r.kind === "unknown";
  return (
    <li className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3.5 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] md:items-center">
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        {sol && <span className="block text-[11px] text-faint-foreground">Creator fees owed</span>}
      </span>
      <Num label="Liabilities" v={`${fmtAmount(r.liabilities, r.decimals, frac)} ${unit}`} />
      <Num label="Assets" v={`${fmtAmount(r.assets, r.decimals, frac)} ${unit}`} className="col-start-2 md:col-start-auto" />
      <div className="col-span-2 md:col-span-1">
        <Bar r={r} i={i} />
        <p className="mt-1 font-mono text-[10px] text-faint-foreground tabular">
          {fmtPct(bps)}
          {zec && r.provenZat !== undefined && r.attestedZat !== undefined && (
            <>
              {" · "}
              <span className="text-muted-foreground">{fmtAmount(r.provenZat, 8)} proven</span> + {fmtAmount(r.attestedZat, 8)} attested
            </>
          )}
        </p>
      </div>
      <div className="col-span-2 md:col-span-1">
        <span className={cn("inline-flex items-center gap-1.5 text-xs", ok ? "text-foreground" : "text-sell")}>
          {ok ? <CheckCircle size={13} weight="fill" className="text-zec" aria-hidden /> : <WarningCircle size={13} weight="fill" aria-hidden />}
          {unknown ? "Unknown asset" : !r.vaultsSigned ? "Unsigned vault" : !r.covered ? "Not covered" : zec ? "Proven SOL + attested ZEC" : "Proven"}
        </span>
        {unknown && <p className="mt-1 text-[11px] text-pretty text-faint-foreground">Not ZEC, SOL or a Solana mint: this page can&apos;t check it.</p>}
        {sol && <p className="mt-1 text-[11px] text-pretty text-faint-foreground">Paid from vault SOL, counted before the ZEC cover.</p>}
        {zec && (
          <p className="mt-1 text-[11px] text-pretty text-faint-foreground">
            Attested by the operator, not cryptographically proven.{" "}
            <a href="#why-attested" className="text-muted-foreground underline decoration-border-strong underline-offset-2 hover:text-foreground">
              See why
            </a>
          </p>
        )}
      </div>
    </li>
  );
}

/** k for a granule of 10^k base units (0 when absent or not a power of ten). */
function granuleExp(g?: string): number {
  return g && /^10*$/.test(g) ? g.length - 1 : 0;
}

function Num({ label, v, className }: { label: string; v: string; className?: string }) {
  return (
    <span className={cn("text-right font-mono text-sm tabular", className)}>
      <span className="mr-2 font-sans text-[11px] text-faint-foreground md:hidden">{label}</span>
      {v}
    </span>
  );
}

/** Coverage bar, the liability line at 100 % (scale: 0 .. max(cover, liabilities)). */
function Bar({ r, i }: { r: SolvencyRow; i: number }) {
  const reduce = useReducedMotion();
  const max = r.assets > r.liabilities ? r.assets : r.liabilities;
  const pct = (v: bigint) => (max === BigInt(0) ? 0 : Number((v * BigInt(10_000)) / max) / 100);
  const line = pct(r.liabilities);
  const segs =
    r.kind === "proven_attested"
      ? [
          { w: pct(r.provenZat ?? BigInt(0)), cls: "bg-zec" },
          { w: pct(r.attestedZat ?? BigInt(0)), cls: "hatch-zec border border-zec/40" },
        ]
      : [{ w: pct(r.assets), cls: "bg-zec" }];
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-sm bg-surface-2" aria-hidden>
      <motion.div
        className="flex h-full origin-left"
        initial={reduce ? false : { scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 0.5, delay: 0.05 * i, ease: EASE }}
      >
        {segs.map((s, k) => (
          <span key={k} className={cn("h-full", s.cls)} style={{ width: `${s.w}%` }} />
        ))}
      </motion.div>
      <span className="absolute inset-y-0 w-px bg-foreground/80" style={{ left: `calc(${line}% - 1px)` }} />
    </div>
  );
}
