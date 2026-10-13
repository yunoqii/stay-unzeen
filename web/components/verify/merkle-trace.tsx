"use client";

import { useEffect, useId, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowCounterClockwise, CheckCircle, XCircle } from "@phosphor-icons/react";
import type { PieceResult } from "@/lib/verify/merkle-sum";
import { fmtAmount } from "@/lib/verify/display";
import { cn } from "@/lib/utils";
import { DecryptText } from "@/components/motion/decrypt-text";

// The real climb of one piece of your balance, leaf -> root, as recomputed in this browser.
// One row per level, root on top. On each row: the node you computed (hash + Σ) on one side, the
// sibling from the proof on the other, where the leafIndex bit puts it. Siblings are hatched: they
// are other people's subtrees, you only ever see their totals.
// Tracing lights the path bottom-up, one level at a time (state feedback, no decoration).
// Motion v2 M5 "Your leaf, nobody else's": siblings are redaction tape (a leaf is there, whose is unknown),
// the hairline path climbs in ~900 ms, each node lights with scale 1.6 → 1 as the line reaches it, and the
// root's hash decrypts last. Reduced motion: final state at once.

const EASE = [0.65, 0, 0.35, 1] as const;
/** The whole climb takes about this long, whatever the depth. */
const PATH_S = 0.9;

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;

export function MerkleTrace({ result, decimals, unit, rootHash, snapshotId }: { result: PieceResult; decimals: number; unit: string; rootHash: string; snapshotId?: number }) {
  const reduce = useReducedMotion();
  const [run, setRun] = useState(0);
  const id = useId();
  const steps = result.steps;
  const depth = steps.length;
  const step = reduce ? 0 : PATH_S / Math.max(1, depth);
  const amt = (v: bigint) => `${fmtAmount(v, decimals, 4)} ${unit}`;
  const ok = result.ok;
  // Rows top -> bottom: root (t = depth), ..., first parent (t = 1), leaf (t = 0).
  const rows = [...steps].reverse();

  return (
    <figure aria-labelledby={`${id}-c`} className="relative">
      <figcaption id={`${id}-c`} className="sr-only">
        Path of piece {result.piece + 1} from your leaf at index {result.leafIndex} up {depth} levels to the root.{" "}
        {ok ? "Every level recomputes and the root matches." : "The recomputed root does not match."}
      </figcaption>
      <div className="flex items-center justify-between gap-3 pb-3">
        <p className="font-mono text-[10px] tracking-wider text-faint-foreground uppercase">
          leaf #{result.leafIndex} · {depth} levels
        </p>
        <button
          type="button"
          onClick={() => setRun((r) => r + 1)}
          className="inline-flex items-center gap-1 rounded text-[11px] text-faint-foreground transition-colors duration-150 hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ArrowCounterClockwise size={11} aria-hidden /> Trace again
        </button>
      </div>

      <ol key={run} className="relative" aria-hidden>
        {/* root */}
        <Row
          t={depth}
          step={step}
          lit={ok}
          center={<Dot t={depth} step={step} big ok={ok} />}
          leftSide={null}
          rightSide={
            <Label t={depth} step={step} strong>
              <span className={cn("flex items-center gap-1", ok ? "text-zec" : "text-sell")}>
                {ok ? <CheckCircle size={11} weight="fill" /> : <XCircle size={11} weight="fill" />}
                root {ok ? "matches" : "differs"}
              </span>
              <span className="text-muted-foreground">Σ {rows[0] ? amt(rows[0].node.sum) : amt(result.value)}</span>
              {reduce ? (
                <span className="text-faint-foreground">{short(rows[0]?.node.hash ?? rootHash)}</span>
              ) : (
                <RootHash text={short(rows[0]?.node.hash ?? rootHash)} delayS={depth * step} />
              )}
              {snapshotId !== undefined && <span className="text-faint-foreground">root #{snapshotId}</span>}
            </Label>
          }
          connector={false}
        />
        {rows.map((s, i) => {
          // Row of level k = depth-1-i: your node P_k (the leaf when k = 0) and its sibling from the proof.
          const below = depth - 1 - i;
          const childHash = i + 1 < rows.length ? rows[i + 1].node.hash : result.leaf;
          const childSum = i + 1 < rows.length ? rows[i + 1].node.sum : result.value;
          const isLeaf = i === rows.length - 1;
          const own = (
            <Label t={below} step={step} strong={isLeaf}>
              <span className={isLeaf ? "text-zec" : "text-muted-foreground"}>{isLeaf ? `your piece ${result.piece + 1}` : `level ${below}`}</span>
              <span className={isLeaf ? "text-foreground" : "text-muted-foreground"}>{amt(childSum)}</span>
              <span className="text-faint-foreground">{short(childHash)}</span>
            </Label>
          );
          const sib = <Sibling t={below} step={step} sum={amt(s.sibling.sum)} hash={short(s.sibling.hash)} />;
          return (
            <Row
              key={s.level}
              t={below}
              step={step}
              lit={ok || below < depth - 1}
              center={<Dot t={below} step={step} leaf={isLeaf} ok />}
              leftSide={s.siblingSide === "left" ? sib : own}
              rightSide={s.siblingSide === "left" ? own : sib}
              last={below === depth - 1}
              connector
            />
          );
        })}
      </ol>
    </figure>
  );
}

function Row({
  t,
  step,
  center,
  leftSide,
  rightSide,
  connector,
  lit,
  last = false,
}: {
  t: number;
  step: number;
  center: React.ReactNode;
  leftSide: React.ReactNode;
  rightSide: React.ReactNode;
  connector: boolean;
  lit: boolean;
  /** The segment that reaches the root. */
  last?: boolean;
}) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_1.75rem_minmax(0,1fr)] items-center">
      <div className="flex justify-end pr-2">{leftSide}</div>
      <div className="relative flex h-11 items-center justify-center">
        {connector && (
          <>
            <span className="absolute bottom-1/2 h-11 w-px bg-[var(--uz-white-a5)]" />
            <motion.span
              className={cn("absolute bottom-1/2 h-11 w-px origin-bottom", lit ? "bg-zec" : "bg-sell")}
              initial={{ scaleY: 0 }}
              animate={{ scaleY: 1 }}
              // Segments chain into one line climbing from the leaf: linear inside, the curve sits on the whole climb.
              transition={{ duration: step || 0.01, delay: t * step, ease: t === 0 ? [EASE[0], EASE[1], 1, 1] : last ? [0, 0, EASE[2], EASE[3]] : "linear" }}
            />
          </>
        )}
        {center}
      </div>
      <div className="flex justify-start pl-2">{rightSide}</div>
    </li>
  );
}

function Dot({ t, step, big, leaf, ok }: { t: number; step: number; big?: boolean; leaf?: boolean; ok: boolean }) {
  return (
    <motion.span
      className={cn(
        "relative z-10 block rounded-full border",
        big ? "size-3.5" : leaf ? "size-3 rounded-[3px]" : "size-2.5",
        ok ? "border-zec bg-zec" : "border-sell bg-sell",
      )}
      initial={step ? { opacity: 0.25, scale: 1 } : false}
      animate={step ? { opacity: [0.25, 1, 1], scale: [1, 1.6, 1] } : { opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, delay: t * step, times: [0, 0.01, 1], ease: [0.16, 1, 0.3, 1] }}
    />
  );
}

function Label({ t, step, strong, children }: { t: number; step: number; strong?: boolean; children: React.ReactNode }) {
  return (
    <motion.span
      className={cn("flex min-w-0 flex-col font-mono text-[10px] leading-tight tabular", strong && "text-[11px]")}
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)" }}
      transition={{ duration: 0.25, delay: t * step }}
    >
      {children}
    </motion.span>
  );
}

/** Someone else's subtree: a strip of redaction tape (a leaf is there, whose is unknown) and only its total. */
function Sibling({ t, step, sum, hash }: { t: number; step: number; sum: string; hash: string }) {
  return (
    <motion.span
      className="flex min-w-0 max-w-full items-center gap-2 font-mono text-[10px] leading-tight text-faint-foreground tabular"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25, delay: t * step }}
      title={`Someone else's subtree: Σ ${sum} · ${hash}`}
    >
      <span aria-hidden className="redaction-tape relative block h-3.5 w-[3.25rem] shrink-0 rounded-[2px] opacity-55" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-muted-foreground">Σ {sum}</span>
        <span className="truncate">{hash}</span>
      </span>
    </motion.span>
  );
}

/** The root's hash decrypts once the line reaches it (420 ms). */
function RootHash({ text, delayS }: { text: string; delayS: number }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOn(true), delayS * 1000);
    return () => clearTimeout(t);
  }, [delayS]);
  return <span className="text-faint-foreground">{on ? <DecryptText text={text} durationMs={420} /> : "░▒▓░▒▓░▒…▓░▒▓"}</span>;
}
