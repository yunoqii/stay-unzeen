"use client";

import { useId, useMemo, useRef, useState } from "react";
import { LayoutGroup, motion, useAnimate } from "motion/react";
import { Check } from "@phosphor-icons/react";
import { wordlist } from "@/lib/crypto/keys";
import { cn } from "@/lib/utils";

const ASK = 3;
const DECOYS = 3;

function pickChallenge(words: string[]) {
  const rnd = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const idx = new Set<number>();
  while (idx.size < ASK) idx.add(rnd(words.length));
  const positions = Array.from(idx).sort((a, b) => a - b);
  // Phrases may repeat a word, so tiles are identified by id, not by text.
  const words_ = positions.map((i) => words[i]);
  const inPhrase = new Set(words);
  while (words_.length < ASK + DECOYS) {
    const w = wordlist[rnd(wordlist.length)];
    if (!inPhrase.has(w) && !words_.includes(w)) words_.push(w);
  }
  const pool = words_.map((word, id) => ({ id, word }));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return { positions, pool };
}

interface Props {
  words: string[];
  onConfirmed: () => void;
}

/** Drag (or tap) the right words into the asked positions. */
export function ConfirmWords({ words, onConfirmed }: Props) {
  const uid = useId();
  const [{ positions, pool }] = useState(() => pickChallenge(words));
  const [placed, setPlaced] = useState<(number | null)[]>(() => positions.map(() => null)); // tile ids
  const [hover, setHover] = useState<number | null>(null);
  const [status, setStatus] = useState<"idle" | "wrong" | "right">("idle");
  const slotRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [slotsScope, animateSlots] = useAnimate();

  const used = useMemo(() => new Set(placed.filter((x): x is number => x !== null)), [placed]);
  const wordOf = (id: number) => pool.find((t) => t.id === id)!.word;

  const slotAt = (x: number, y: number) =>
    slotRefs.current.findIndex((el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8;
    });

  const place = (id: number, slot: number) => {
    if (status === "right") return;
    const next = placed.map((t) => (t === id ? null : t));
    next[slot] = id;
    setPlaced(next);
    setStatus("idle");
    if (next.every((t) => t !== null)) check(next as number[]);
  };

  const placeNext = (id: number) => {
    const slot = placed.findIndex((t) => t === null);
    if (slot >= 0) place(id, slot);
  };

  const unplace = (slot: number) => {
    if (status === "right") return;
    setPlaced((p) => p.map((w, i) => (i === slot ? null : w)));
    setStatus("idle");
  };

  const check = (attempt: number[]) => {
    const ok = attempt.every((t, i) => wordOf(t) === words[positions[i]]);
    if (ok) {
      setStatus("right");
      setTimeout(onConfirmed, 650);
      return;
    }
    setStatus("wrong");
    animateSlots(slotsScope.current, { x: [0, -6, 6, -4, 4, 0] }, { duration: 0.35, ease: "easeOut" });
    // Keep the correct ones, send the wrong ones back.
    setTimeout(() => setPlaced(attempt.map((t, i) => (wordOf(t) === words[positions[i]] ? t : null))), 450);
  };

  return (
    <LayoutGroup id={uid}>
      <div ref={slotsScope} className="grid grid-cols-3 gap-2 sm:gap-3">
        {positions.map((pos, i) => {
          const tile = placed[i];
          const word = tile === null ? null : wordOf(tile);
          return (
            <div key={pos} className="space-y-1.5">
              <p className="text-center font-mono text-[11px] text-faint-foreground">Word #{pos + 1}</p>
              <button
                ref={(el) => {
                  slotRefs.current[i] = el;
                }}
                type="button"
                onClick={() => word && unplace(i)}
                aria-label={word ? `Word #${pos + 1}: ${word}. Tap to remove.` : `Word #${pos + 1}: empty`}
                className={cn(
                  "relative grid h-12 w-full place-items-center rounded-lg border border-dashed transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  hover === i ? "border-zec/70 bg-zec-soft" : "border-border bg-surface-1",
                  status === "wrong" && word && word !== words[pos] && "border-sell/60",
                  status === "right" && "border-solid border-zec/50",
                )}
              >
                {tile !== null && word && <Tile layoutId={`${uid}-${tile}`} word={word} static />}
              </button>
            </div>
          );
        })}
      </div>

      <p aria-live="polite" className="mt-4 min-h-5 text-center text-sm">
        {status === "wrong" && <span className="text-sell">That does not match your phrase. Check your backup.</span>}
        {status === "right" && (
          <span className="inline-flex items-center gap-1.5 text-zec">
            <Check size={14} weight="bold" /> Backup confirmed
          </span>
        )}
        {status === "idle" && <span className="text-faint-foreground">Drag a word into its slot, or tap it.</span>}
      </p>

      <ul className="mt-4 flex flex-wrap justify-center gap-2" aria-label="Words to choose from">
        {pool.map(({ id, word: w }) => (
          <li key={id} className="h-11 min-w-24">
            {used.has(id) ? (
              <span aria-hidden className="block h-full w-full rounded-lg border border-dashed border-border" />
            ) : (
              <Tile
                layoutId={`${uid}-${id}`}
                word={w}
                onTap={() => placeNext(id)}
                onDragMove={(x, y) => {
                  const s = slotAt(x, y);
                  setHover((h) => (h === (s < 0 ? null : s) ? h : s < 0 ? null : s));
                }}
                onDrop={(x, y) => {
                  setHover(null);
                  const s = slotAt(x, y);
                  if (s >= 0) place(id, s);
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </LayoutGroup>
  );
}

interface TileProps {
  word: string;
  layoutId: string;
  static?: boolean;
  onTap?: () => void;
  onDragMove?: (x: number, y: number) => void;
  onDrop?: (x: number, y: number) => void;
}

function Tile({ word, layoutId, static: isStatic, onTap, onDragMove, onDrop }: TileProps) {
  const dragged = useRef(false);
  const transition = { type: "spring" as const, bounce: 0, duration: 0.35 };

  if (isStatic)
    return (
      <motion.span layoutId={layoutId} transition={transition} className="font-mono text-[15px]">
        {word}
      </motion.span>
    );

  return (
    <motion.button
      type="button"
      layoutId={layoutId}
      transition={transition}
      drag
      dragSnapToOrigin
      dragElastic={0.9}
      dragMomentum={false}
      whileDrag={{ scale: 1.06, zIndex: 20, boxShadow: "0 12px 32px -8px rgb(0 0 0 / 0.8)" }}
      onDragStart={() => {
        dragged.current = true;
      }}
      onDrag={(e) => {
        const p = e as PointerEvent;
        onDragMove?.(p.clientX, p.clientY);
      }}
      onDragEnd={(e) => {
        const p = e as PointerEvent;
        onDrop?.(p.clientX, p.clientY);
        // Let the click that follows a drag be ignored.
        setTimeout(() => (dragged.current = false), 0);
      }}
      onClick={() => {
        if (!dragged.current) onTap?.();
      }}
      className="relative h-full w-full touch-none rounded-lg border border-tile-border bg-tile px-3 font-mono text-[15px] text-foreground transition-colors duration-150 select-none hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
    >
      {word}
    </motion.button>
  );
}
