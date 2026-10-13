"use client";

import { createContext, useContext, useState } from "react";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { DecryptText } from "@/components/motion/decrypt-text";
import { PeelTape } from "@/components/motion/tape-peel";
import { TapeStripFull } from "@/components/brand/tape-strip";

/** Privacy mode: amounts sit under tape by default, shown only while the user peeks. Never persisted. */
const PeekContext = createContext<{ shown: boolean; toggle: () => void; set: (on: boolean) => void }>({ shown: false, toggle: () => {}, set: () => {} });

export function PeekProvider({ children, initialShown = false }: { children: React.ReactNode; /** Tests only. */ initialShown?: boolean }) {
  const [shown, setShown] = useState(initialShown);
  return <PeekContext.Provider value={{ shown, toggle: () => setShown((s) => !s), set: setShown }}>{children}</PeekContext.Provider>;
}

export function usePeek() {
  return useContext(PeekContext);
}

/**
 * What holds the place under the tape: a fixed stand-in, never the real digits, so the tape's width does not
 * leak the size of the amount. Invisible; the tape covers it.
 */
const VEIL = "00.000";

/**
 * An amount under tape (brand v4, docs/design/tape-peel.md). The real value is in the DOM ONLY while the tape
 * is off: covered, the node holds a fixed stand-in and screen readers hear "hidden". Peeking lifts the tape
 * from its torn end and the value decrypts in; letting go removes the value at once and the tape sticks back.
 */
export function Veiled({ children, className }: { children: React.ReactNode; className?: string }) {
  const { shown } = usePeek();
  const text = typeof children === "string" || typeof children === "number" ? String(children) : null;
  return (
    <span className={cn("relative inline-grid", className)} data-veiled={shown ? "open" : "covered"}>
      {/* The stand-in always holds the cell, so the tape keeps its size while it peels (one grid cell, stacked). */}
      <span aria-hidden className="invisible col-start-1 row-start-1 select-none">
        {VEIL}
      </span>
      {shown ? (
        <span className="col-start-1 row-start-1">{text !== null ? <DecryptText text={text} /> : children}</span>
      ) : (
        <span className="sr-only">hidden</span>
      )}
      <PeelTape peeled={shown} rest={-3} className="-inset-x-[4%] -inset-y-[2%]">
        <TapeStripFull />
      </PeelTape>
    </span>
  );
}

/**
 * Peek: press and hold to lift the tape, release to stick it back. Keyboard: Space / Enter toggle it
 * (aria-pressed), so it stays readable without holding a key.
 */
export function PeekToggle({ className }: { className?: string }) {
  const { shown, set, toggle } = usePeek();
  const Icon = shown ? EyeSlash : Eye;
  const release = () => set(false);
  return (
    <button
      type="button"
      aria-pressed={shown}
      aria-label={shown ? "Hide amounts" : "Peek at amounts (hold)"}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        set(true);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          if (!e.repeat) toggle();
        }
      }}
      onBlur={release}
      className={cn(
        "inline-flex h-8 touch-none items-center gap-1.5 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors duration-150 select-none hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-zec focus-visible:outline-none",
        shown && "border-border-strong text-foreground",
        className,
      )}
    >
      <Icon size={14} weight="light" aria-hidden />
      {shown ? "Hide" : "Peek"}
    </button>
  );
}
