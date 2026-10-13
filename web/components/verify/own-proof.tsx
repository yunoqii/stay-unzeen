"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle, CircleNotch, DownloadSimple, Key, LockKey, ShieldCheck, WarningCircle, XCircle } from "@phosphor-icons/react";
import { errorText } from "@/lib/api/client";
import type { VerifySnapshot } from "@/lib/api/types";
import { getSigner, useKeyState } from "@/lib/crypto/session";
import { shortAddr } from "@/lib/format";
import type { Network } from "@/lib/network";
import { assetLabel, fmtAmount, fmtUtc } from "@/lib/verify/display";
import { checkOwnBalance, compareWithPortfolio, downloadJson, proofJson, type CompareStatus, type OwnCheck } from "@/lib/verify/own";
import { usePortfolio } from "@/hooks/use-portfolio";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MerkleTrace } from "./merkle-trace";

const EASE = [0.16, 1, 0.3, 1] as const;

type State = { s: "idle" } | { s: "loading" } | { s: "none" } | { s: "error"; message: string } | { s: "done"; own: OwnCheck };

/**
 * "Check my balance": one signed GET on click (never polled), then every piece is recomputed here,
 * from the key's own pubkey up to the public roots. The proof stays in this component's memory only;
 * it disappears on reload, on lock and when the snapshot changes. "Download proof" is the only way to keep it.
 */
export function OwnProof({ snap, network, available, symbols }: { snap: VerifySnapshot; network: Network; available: boolean; symbols: Map<string, string> }) {
  const key = useKeyState();
  const [state, setState] = useState<State>({ s: "idle" });
  const [asset, setAsset] = useState(0);
  const [piece, setPiece] = useState(0);
  const tabsId = useId();

  // Key locked or gone: forget the proof right away (allowed render-time update, no effect needed).
  if (key.status !== "unlocked" && state.s !== "idle") setState({ s: "idle" });

  if (key.status === "loading") return <div className="h-40 animate-pulse bg-surface-2 motion-reduce:animate-none" />;
  if (key.status !== "unlocked") {
    const locked = key.status === "locked";
    return (
      <div className="flex flex-col items-start gap-4 border border-dashed border-border p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-3">
          {locked ? <LockKey size={22} weight="thin" className="shrink-0 text-muted-foreground" aria-hidden /> : <Key size={22} weight="thin" className="shrink-0 text-muted-foreground" aria-hidden />}
          <p className="text-sm text-pretty text-muted-foreground">
            {locked ? "Unlock your anon key to ask for your proof. The request is signed in this tab; the proof is checked here and never stored." : "Load your anon key to check your own balance against the roots. Everyone else can still check the totals above."}
          </p>
        </div>
        <Button asChild className="h-10 shrink-0 rounded-full px-5">
          <Link href="/key?next=/verify">{locked ? "Unlock key" : "Load your key"}</Link>
        </Button>
      </div>
    );
  }
  // Another key unlocked meanwhile: never show its predecessor's proof.
  const own = state.s === "done" && state.own.pubkey === key.pubkey ? state.own : null;

  const run = async () => {
    const signer = getSigner(network);
    if (!signer) return;
    setState({ s: "loading" });
    try {
      const r = await checkOwnBalance(signer, snap);
      setAsset(0);
      setPiece(0);
      setState(r ? { s: "done", own: r } : { s: "none" });
    } catch (e) {
      setState({ s: "error", message: errorText(e) });
    }
  };

  const save = () => {
    if (!own) return;
    downloadJson(`unzeen-proof-${snap.chainId}-${snap.id}.json`, proofJson(snap, own));
  };

  return (
    <div className="border border-border">
      <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm">
            Key <span className="font-mono text-xs text-muted-foreground">{shortAddr(key.pubkey, 4, 4)}</span> at snapshot #{snap.id}
          </p>
          <p className="mt-0.5 text-xs text-faint-foreground">
            {available ? "One signed request. The answer is padded to a fixed size, so its length says nothing." : "Proofs are kept for 48 hours: the latest and the previous snapshot only."}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {own && own.result.assets.length > 0 && (
            <Button variant="outline" onClick={save} className="h-10 rounded-full px-4">
              <DownloadSimple size={14} aria-hidden /> Download proof
            </Button>
          )}
          <Button onClick={run} disabled={!available || state.s === "loading"} className="h-10 rounded-full px-5">
            {state.s === "loading" ? <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <ShieldCheck size={14} weight="bold" aria-hidden />}
            {own ? "Check again" : "Check my balance"}
          </Button>
        </div>
      </div>

      <div aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          {state.s === "none" && (
            <Reveal key="none">
              <p className="text-sm text-muted-foreground">No proof for this key at #{snap.id}. Either it held nothing at {fmtUtc(snap.takenAt)}, or the proof has expired (48 h).</p>
            </Reveal>
          )}
          {state.s === "error" && (
            <Reveal key="err">
              <p className="text-sm text-sell">{state.message}</p>
            </Reveal>
          )}
          {own && own.result.assets.length === 0 && !own.result.error && (
            <Reveal key="empty">
              <p className="text-sm text-muted-foreground">This key held nothing at {fmtUtc(snap.takenAt)}, so it is in no tree. The answer had the same size as anyone else&apos;s.</p>
            </Reveal>
          )}
          {own && own.result.error && (
            <Reveal key="perr">
              <p className="flex items-center gap-1.5 text-sm text-sell">
                <XCircle size={15} weight="fill" aria-hidden /> {own.result.error}
              </p>
            </Reveal>
          )}
          {own && own.result.assets.length > 0 && (
            <Reveal key={`ok-${own.snapshotId}`}>
              <Summary own={own} snap={snap} symbols={symbols} />
              {/* asset tabs */}
              <div role="tablist" aria-label="Assets in your proof" className="mt-5 flex flex-wrap gap-1.5">
                {own.result.assets.map((a, i) => (
                  <button
                    key={a.asset}
                    role="tab"
                    id={`${tabsId}-t${i}`}
                    aria-selected={i === asset}
                    aria-controls={`${tabsId}-p`}
                    onClick={() => {
                      setAsset(i);
                      setPiece(0);
                    }}
                    className={cn(
                      "relative h-8 rounded-full px-3 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      i === asset ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {i === asset && <motion.span layoutId={`${tabsId}-ind`} className="absolute inset-0 rounded-full bg-surface-3" transition={{ duration: 0.25, ease: EASE }} />}
                    <span className="relative flex items-center gap-1.5">
                      {a.ok ? <CheckCircle size={11} weight="fill" className="text-zec" aria-hidden /> : <XCircle size={11} weight="fill" className="text-sell" aria-hidden />}
                      {assetLabel(a.asset, symbols)}
                    </span>
                  </button>
                ))}
              </div>
              <AssetPanel id={`${tabsId}-p`} labelledBy={`${tabsId}-t${asset}`} own={own} index={asset} piece={piece} setPiece={setPiece} snap={snap} symbols={symbols} />
            </Reveal>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Reveal({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, filter: "blur(8px)" }}
      animate={{ opacity: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="border-t border-border p-5"
    >
      {children}
    </motion.div>
  );
}

function Summary({ own, snap, symbols }: { own: OwnCheck; snap: VerifySnapshot; symbols: Map<string, string> }) {
  const r = own.result;
  return (
    <div>
      <p className={cn("flex items-center gap-2 text-base", r.ok ? "text-foreground" : "text-sell")}>
        {r.ok ? <CheckCircle size={18} weight="fill" className="text-zec" aria-hidden /> : <XCircle size={18} weight="fill" aria-hidden />}
        {r.ok ? "Your balance is in every tree." : "Some pieces do not climb to the published roots."}
      </p>
      <ul className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {r.assets.map((a) => (
          <li key={a.asset} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-muted-foreground">{assetLabel(a.asset, symbols)}</span>
            <span className="font-mono tabular">
              <span className="text-faint-foreground">committed ≥ </span>
              {fmtAmount(a.committed, a.decimals, a.asset === "ZEC" || a.asset === "SOL" ? 3 : 0)}
              {a.asset === "ZEC" || a.asset === "SOL" ? ` ${a.asset}` : ""}
            </span>
          </li>
        ))}
      </ul>
      <BalanceCompare own={own} snap={snap} symbols={symbols} />
      <p className="mt-2 text-xs text-pretty text-faint-foreground">
        The pool committed at least this much to your key at {fmtUtc(snap.takenAt)}: your balance, rounded up, split into 2–4 pieces nobody else can link.
        {own.proof.truncated && " You hold more than 12 assets: this proof covers ZEC and 11 picked at random. Check again for others."}
      </p>
    </div>
  );
}

const COMPARE_TEXT: Record<CompareStatus, string> = {
  covered: "covered",
  short: "less than your balance",
  missing: "not in the proof",
  changed: "changed since the snapshot",
  truncated: "not in this sample",
};

/**
 * "committed ≥ your balance" against the portfolio this tab already polls (review E11). Computed only
 * here. A shortfall with no activity since the snapshot is called out plainly: that is exactly what
 * a proof of liabilities exists to catch.
 */
function BalanceCompare({ own, snap, symbols }: { own: OwnCheck; snap: VerifySnapshot; symbols: Map<string, string> }) {
  const { portfolio } = usePortfolio();
  if (!portfolio) return null;
  const { rows, changed } = compareWithPortfolio(own, snap, portfolio);
  if (rows.length === 0) return null;
  const bad = rows.filter((r) => r.status === "short" || r.status === "missing");
  return (
    <div className={cn("mt-4 border p-3", bad.length ? "border-sell/40 bg-sell/5" : "border-border")}>
      <p className={cn("flex items-center gap-2 text-sm", bad.length ? "text-sell" : "text-foreground")}>
        {bad.length ? <WarningCircle size={15} weight="fill" aria-hidden /> : <CheckCircle size={15} weight="fill" className="text-zec" aria-hidden />}
        {bad.length
          ? "The pool committed less than your balance, and nothing moved on this key since the snapshot."
          : changed
            ? "Against your balance now: your key moved since the snapshot, so small differences are expected."
            : "Against your balance now: every asset is covered."}
      </p>
      <ul className="mt-2 space-y-1">
        {rows.map((r) => {
          const frac = r.asset === "ZEC" || r.asset === "SOL" ? 3 : Math.min(3, r.decimals);
          const unit = r.asset === "ZEC" || r.asset === "SOL" ? ` ${r.asset}` : "";
          const tone = r.status === "covered" ? "text-zec" : r.status === "short" || r.status === "missing" ? "text-sell" : "text-muted-foreground";
          return (
            <li key={r.asset} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-xs sm:grid-cols-[minmax(0,0.6fr)_minmax(0,1fr)_auto]">
              <span className="text-muted-foreground">{assetLabel(r.asset, symbols)}</span>
              <span className="col-span-2 row-start-2 font-mono tabular text-faint-foreground sm:col-span-1 sm:row-start-auto">
                {r.committed === null ? "—" : fmtAmount(r.committed, r.decimals, frac)} committed · {fmtAmount(r.now, r.decimals, frac)}
                {unit} now
              </span>
              <span className={cn("text-right", tone)}>{COMPARE_TEXT[r.status]}</span>
            </li>
          );
        })}
      </ul>
      {bad.length > 0 && (
        <p className="mt-2 text-[11px] text-pretty text-muted-foreground">
          Download the proof and keep it: it is signed evidence of what the pool committed to your key at {fmtUtc(snap.takenAt)}. Your balance from this
          browser is not sent anywhere.
        </p>
      )}
    </div>
  );
}

function AssetPanel({
  id,
  labelledBy,
  own,
  index,
  piece,
  setPiece,
  snap,
  symbols,
}: {
  id: string;
  labelledBy: string;
  own: OwnCheck;
  index: number;
  piece: number;
  setPiece: (i: number) => void;
  snap: VerifySnapshot;
  symbols: Map<string, string>;
}) {
  const a = own.result.assets[index];
  if (!a) return null;
  const p = a.pieces[piece] ?? a.pieces[0];
  const tree = snap.trees.find((t) => t.asset === a.asset);
  const unit = a.asset === "ZEC" ? "ZEC" : assetLabel(a.asset, symbols);
  return (
    <div role="tabpanel" id={id} aria-labelledby={labelledBy} className="mt-4">
      {a.error && <p className="mb-3 text-xs text-sell">{a.error}</p>}
      {a.pieces.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-faint-foreground">Pieces</span>
          {a.pieces.map((x, i) => (
            <button
              key={x.piece}
              type="button"
              onClick={() => setPiece(i)}
              aria-pressed={i === piece}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-md border px-2.5 font-mono transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                i === piece ? "border-zec/50 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                !x.ok && "border-sell/50 text-sell",
              )}
            >
              {x.ok ? <CheckCircle size={10} weight="fill" className="text-zec" aria-hidden /> : <XCircle size={10} weight="fill" aria-hidden />}
              {fmtAmount(x.value, a.decimals, 4)}
            </button>
          ))}
        </div>
      )}
      {p && p.error && <p className="text-xs text-sell">Piece {p.piece + 1}: {p.error}</p>}
      {p && p.steps.length > 0 && (
        <div className="border border-border bg-[var(--uz-ink-1)] p-4 sm:p-5">
          <MerkleTrace key={`${a.asset}:${p.piece}`} result={p} decimals={a.decimals} unit={unit} rootHash={tree?.root ?? ""} />
        </div>
      )}
      <p className="mt-3 text-[11px] text-faint-foreground">Computed in this browser with SHA-256. Nothing was sent anywhere and nothing was stored.</p>
    </div>
  );
}
