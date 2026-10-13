"use client";

import { motion, useReducedMotion } from "motion/react";
import { WarningCircle } from "@phosphor-icons/react";
import { coverageBps, type QuoteHolding, type SolvencyRow } from "@/lib/verify/merkle-sum";
import { assetLabel, fmtAmount, fmtPct } from "@/lib/verify/display";
import { cn } from "@/lib/utils";
import { shortAddr } from "@/lib/format";

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * One row per tree. Mints: liabilities ≤ Σ signed vault balances, fully checkable (granule 1). ZEC
 * (creator fees owed included, API v0.10): the cover is spare SOL on the vaults (proven) plus the
 * operator's reserve statement (attested), drawn as two segments of one bar, so the attested part is
 * never mistaken for a proof.
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
  const unit = r.asset === "ZEC" ? "ZEC" : "";
  const zec = r.kind === "proven_attested";
  const ok = r.covered && r.vaultsSigned;
  // Fraction digits follow the tree's granule (v0.10: a mint granule is 1 base unit), at most 3.
  const frac = zec ? 3 : Math.min(3, Math.max(0, r.decimals - granuleExp(r.granule)));
  const unknown = r.kind === "unknown";
  return (
    <li className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3.5 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] md:items-center">
      <span className="col-span-2 min-w-0 md:col-span-1">
        <span className="font-medium">{label}</span>
        {zec && <span className="block text-[11px] text-faint-foreground">Incl. creator fees owed</span>}
      </span>
      <Num label="Liabilities" v={`${fmtAmount(r.liabilities, r.decimals, frac)} ${unit}`} />
      <Num label="Assets" v={`${fmtAmount(r.assets, r.decimals, frac)} ${unit}`} className="max-md:items-end max-md:text-right" />
      <div className="col-span-2 md:col-span-1">
        <Bar r={r} i={i} />
        <p className="mt-1 font-mono text-[10px] text-faint-foreground tabular">
          {fmtPct(bps)}
          {zec && r.provenZat !== undefined && r.attestedZat !== undefined && (
            <>
              {" · "}
              <span className="text-muted-foreground">{fmtAmount(r.provenZat, 8)} proven</span>
              {r.bridgedZat !== undefined && r.bridgedZat > BigInt(0) && <> + {fmtAmount(r.bridgedZat, 8)} bridged</>} + {fmtAmount(r.attestedZat, 8)} attested
            </>
          )}
        </p>
      </div>
      <div className="col-span-2 md:col-span-1">
        <span className={cn("inline-flex items-center gap-1.5 text-xs", ok ? "text-foreground" : "text-sell")}>
          {ok ? <span aria-hidden className="size-1.5 rounded-full bg-zec" /> : <WarningCircle size={13} weight="fill" aria-hidden />}
          {unknown
            ? "Unknown asset"
            : !r.vaultsSigned
              ? "Unsigned vault"
              : !r.covered
                ? "Not covered"
                : zec
                  ? r.bridgedZat !== undefined && r.bridgedZat > BigInt(0)
                    ? "Proven SOL + bridged ZEC + attested ZEC"
                    : "Proven SOL + attested ZEC"
                  : "Proven"}
        </span>
        {unknown && <p className="mt-1 text-[11px] text-pretty text-faint-foreground">Not ZEC or a Solana mint: this page can&apos;t check it.</p>}
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
    // Phone: label above the number, Liabilities left and Assets right, so 15-digit amounts fit in half a row.
    <span className={cn("flex min-w-0 flex-col font-mono text-sm break-all tabular md:block md:text-right", className)}>
      <span className="font-sans text-[11px] text-faint-foreground md:hidden">{label}</span>
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
          { w: pct(r.bridgedZat ?? BigInt(0)), cls: "bg-zec/55" },
          { w: pct(r.attestedZat ?? BigInt(0)), cls: "bg-[repeating-linear-gradient(to_right,var(--uz-zec)_0_3px,transparent_3px_5px)]" },
        ]
      : [{ w: pct(r.assets), cls: "bg-zec" }];
  return (
    // M9 "Thin proof" (motion-v2): yellow is light, not paint. A 2 px line fills to its value once, staggered by row.
    <div className="relative flex h-2.5 w-full items-center" aria-hidden>
      <span className="absolute inset-x-0 h-px bg-surface-3" />
      <motion.div
        className="relative flex h-[2px] w-full origin-left"
        initial={reduce ? false : { scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 0.6, delay: 0.06 * i, ease: EASE }}
      >
        {segs.map((s, k) => (
          <span key={k} className={cn("h-full", s.cls)} style={{ width: `${s.w}%` }} />
        ))}
      </motion.div>
      <span className="absolute inset-y-0 w-px bg-foreground/80" style={{ left: `calc(${line}% - 1px)` }} />
    </div>
  );
}

/**
 * v0.13 quote assets of non-SOL pairs on the vaults. Only ZEC SPL counts towards the ZEC cover, one to one,
 * and it is a bridged asset: the bridge issuer could fail it. USDC / USD1 are listed so nothing is hidden,
 * but never counted (conservative: their value in ZEC would need a rate this page can't prove).
 */
export function QuoteAssetsTable({ rows }: { rows: QuoteHolding[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-4 border border-border">
      <div className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-2.5">
        <h3 className="font-mono text-[10px] tracking-wider text-faint-foreground uppercase">Quote assets on the vaults</h3>
        <span className="text-[11px] text-faint-foreground">pairs not to SOL</span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((q) => (
          <li key={q.mint} className="grid grid-cols-2 gap-x-4 gap-y-1 px-4 py-3 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,2.4fr)] md:items-center">
            <span className="min-w-0">
              <span className="font-medium">{q.quote === "ZEC" ? "ZEC SPL" : q.quote}</span>
              {q.bridged && <span className="ml-2 rounded-sm border border-zec/40 px-1 py-px font-mono text-[10px] text-zec uppercase">bridged</span>}
              <span className="block font-mono text-[10px] text-faint-foreground">{shortAddr(q.mint, 4, 4)}</span>
            </span>
            <span className="text-right font-mono text-sm tabular md:text-right">{fmtAmount(q.total, q.decimals, 2)}</span>
            <p className="col-span-2 text-[11px] text-pretty text-faint-foreground md:col-span-1">
              {q.counted ? (
                <>
                  <span className="text-muted-foreground">Counted 1:1 towards ZEC</span> ({fmtAmount(q.countedZat, 8, 3)} ZEC after dust). Bridged: its value depends on the bridge issuer, so it is
                  shown apart from proven SOL.
                </>
              ) : (
                <>
                  <span className="text-muted-foreground">Shown, not counted.</span> Conservative: no liability is backed by it here.
                </>
              )}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
