"use client";

// The linear chain. Native drag and drop (from the palette, or a step onto another place) plus the keyboard:
// arrows walk the steps, Alt+↑/↓ moves the focused step, Delete removes it. Privacy floors are taped onto
// the steps they change; errors sit under the step they belong to.

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { DotsSixVertical, WarningCircle } from "@phosphor-icons/react";
import type { ScenarioBlockType, ScenarioPlan } from "@/lib/api/types";
import { BLOCKS } from "@/lib/scenarios/catalog";
import { describeBlock, onFailText, type TokenLookup } from "@/lib/scenarios/describe";
import type { DraftStep } from "@/lib/scenarios/draft";
import type { PlanCheck } from "@/lib/scenarios/validate";
import { cn } from "@/lib/utils";
import { BLOCK_ICON } from "./block-icon";
import { FloorTape } from "./floor-tape";
import { DND_MOVE, DND_NEW } from "./palette";

const EASE = [0.16, 1, 0.3, 1] as const;

export type DragItem = { kind: "new"; type: ScenarioBlockType } | { kind: "move"; uid: number };

export function Chain({
  steps,
  plan,
  check,
  tok,
  selected,
  onSelect,
  onDropNew,
  onMove,
  onRemove,
  drag,
  setDrag,
}: {
  steps: DraftStep[];
  plan: ScenarioPlan;
  check: PlanCheck;
  tok: TokenLookup;
  selected: number | null;
  onSelect: (uid: number) => void;
  onDropNew: (t: ScenarioBlockType, at: number) => void;
  onMove: (uid: number, to: number) => void;
  onRemove: (uid: number) => void;
  drag: DragItem | null;
  setDrag: (d: DragItem | null) => void;
}) {
  const [over, setOver] = useState<number | null>(null);
  const [said, setSaid] = useState("");
  const rows = useRef(new Map<number, HTMLButtonElement>());

  const drop = (at: number, e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    const t = e.dataTransfer.getData(DND_NEW) as ScenarioBlockType;
    const moved = e.dataTransfer.getData(DND_MOVE);
    if (t && t in BLOCKS) onDropNew(t, at);
    else if (moved !== "") {
      const uid = Number(moved);
      const from = steps.findIndex((s) => s.uid === uid);
      onMove(uid, from < at ? at - 1 : at);
    }
    setDrag(null);
  };
  const allow = (at: number) => (e: React.DragEvent) => {
    if (![...e.dataTransfer.types].some((x) => x === DND_NEW || x === DND_MOVE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DND_NEW) ? "copy" : "move";
    if (over !== at) setOver(at);
  };

  const focusRow = (uid: number) => requestAnimationFrame(() => rows.current.get(uid)?.focus());

  const onKey = (e: React.KeyboardEvent, s: DraftStep, i: number) => {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const to = e.key === "ArrowUp" ? i - 1 : i + 1;
      if (to < 0 || to >= steps.length) return;
      onMove(s.uid, to);
      setSaid(`${BLOCKS[s.block.type].label} moved to step ${to + 1}.`);
      focusRow(s.uid);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = steps[e.key === "ArrowUp" ? i - 1 : i + 1];
      if (next) {
        onSelect(next.uid);
        focusRow(next.uid);
      }
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const next = steps[i + 1] ?? steps[i - 1];
      onRemove(s.uid);
      setSaid(`${BLOCKS[s.block.type].label} removed.`);
      if (next) focusRow(next.uid);
    }
  };

  const slot = (at: number, last = false) => (
    <li
      key={`slot-${at}`}
      aria-hidden
      onDragOver={allow(at)}
      onDragLeave={() => setOver((o) => (o === at ? null : o))}
      onDrop={(e) => drop(at, e)}
      className={cn("relative transition-[height] duration-150", drag ? (last ? "h-14" : "h-5") : "h-2", over === at && "h-12")}
    >
      <AnimatePresence>
        {drag && (
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: over === at ? 1 : 0.35 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={cn("absolute inset-x-0 top-1/2 ml-12 -translate-y-1/2 rounded-md border border-dashed", over === at ? "h-9 border-zec/60 bg-zec/5" : "h-px border-border-strong")}
          />
        )}
      </AnimatePresence>
    </li>
  );

  if (steps.length === 0)
    return (
      <div
        onDragOver={allow(0)}
        onDragLeave={() => setOver(null)}
        onDrop={(e) => drop(0, e)}
        className={cn(
          "grid min-h-72 place-items-center rounded-xl border border-dashed px-6 text-center transition-colors",
          over === 0 ? "border-zec/60 bg-zec/5" : "border-border",
        )}
      >
        <div>
          <p className="text-sm font-medium">Start with a template, or drop a block here</p>
          <p className="mx-auto mt-1 max-w-xs text-xs text-pretty text-muted-foreground">Blocks run top to bottom. Anything that waits for an event goes first; withdrawals usually go last.</p>
        </div>
      </div>
    );

  return (
    <>
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
      <ol aria-label="Scenario steps" className="relative">
        {/* the rail */}
        <span aria-hidden className="absolute top-4 bottom-4 left-[19px] w-px bg-border" />
        {steps.map((s, i) => {
          const p = plan.steps[i];
          const Icon = BLOCK_ICON[s.block.type];
          const issues = check.issues.filter((x) => x.step === i);
          const floors = check.floors.filter((x) => x.step === i);
          const warns = check.warnings.filter((x) => x.step === i);
          const on = selected === s.uid;
          return [
            slot(i),
            <motion.li key={s.uid} layout="position" transition={{ duration: 0.25, ease: EASE }} className="relative">
              <button
                ref={(el) => {
                  if (el) rows.current.set(s.uid, el);
                  else rows.current.delete(s.uid);
                }}
                type="button"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DND_MOVE, String(s.uid));
                  e.dataTransfer.effectAllowed = "move";
                  setDrag({ kind: "move", uid: s.uid });
                }}
                onDragEnd={() => {
                  setDrag(null);
                  setOver(null);
                }}
                onClick={() => onSelect(s.uid)}
                onKeyDown={(e) => onKey(e, s, i)}
                aria-current={on ? "step" : undefined}
                aria-describedby={issues.length ? `issue-${s.uid}` : undefined}
                aria-label={`Step ${i + 1}: ${BLOCKS[s.block.type].label}. ${issues.length ? `${issues.length} problem${issues.length > 1 ? "s" : ""}.` : ""} Alt+arrows to move, Delete to remove.`}
                className={cn(
                  "group flex w-full items-start gap-3 rounded-xl py-2 pr-3 text-left transition-colors duration-150 focus-visible:outline-none",
                  drag?.kind === "move" && drag.uid === s.uid && "opacity-40",
                )}
              >
                <span
                  className={cn(
                    "tabular relative z-10 grid size-10 shrink-0 place-items-center rounded-full border bg-background font-mono text-xs transition-colors duration-150",
                    on ? "border-zec text-zec" : issues.length ? "border-destructive/60 text-destructive" : "border-border text-muted-foreground group-hover:border-border-strong",
                    "group-focus-visible:ring-2 group-focus-visible:ring-ring",
                  )}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 rounded-xl border px-4 py-3 transition-colors duration-150",
                    on ? "border-zec/40 bg-surface-1" : "border-border group-hover:border-border-strong",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <Icon size={15} weight={on ? "duotone" : "light"} className={on ? "text-zec" : "text-muted-foreground"} aria-hidden />
                    <span className="text-sm font-medium">{BLOCKS[s.block.type].label}</span>
                    {issues.length > 0 && <WarningCircle size={14} weight="fill" className="text-destructive" aria-hidden />}
                    <DotsSixVertical size={14} weight="bold" className="ml-auto cursor-grab text-faint-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                  </span>
                  <span className="mt-1 block text-[13px] leading-snug text-pretty text-muted-foreground">{p ? describeBlock(plan, p.block, tok) : ""}</span>
                  {s.onFail !== undefined && s.onFail !== "stop" && <span className="mt-1 block font-mono text-[11px] text-faint-foreground">{onFailText(p?.onFail)}</span>}
                  {(floors.length > 0 || warns.length > 0 || issues.length > 0) && (
                    <span className="mt-2 flex flex-col gap-1">
                      {floors.map((f) => (
                        <FloorTape key={f.code} text={f.text} />
                      ))}
                      {issues.slice(0, 2).map((x) => (
                        <span key={x.code + x.message} id={`issue-${s.uid}`} className="text-[11px] leading-snug text-pretty text-destructive">
                          {x.message}
                        </span>
                      ))}
                      {issues.length === 0 &&
                        warns.slice(0, 1).map((w) => (
                          <span key={w.code} className="text-[11px] leading-snug text-pretty text-muted-foreground">
                            {w.text}
                          </span>
                        ))}
                    </span>
                  )}
                </span>
              </button>
            </motion.li>,
          ];
        })}
        {slot(steps.length, true)}
      </ol>
    </>
  );
}
