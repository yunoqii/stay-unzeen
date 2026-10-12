"use client";

import { createContext, useContext, useState } from "react";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { DecryptText } from "@/components/motion/decrypt-text";

/** Privacy mode: amounts are veiled by default, shown only while the user peeks. Never persisted. */
const PeekContext = createContext<{ shown: boolean; toggle: () => void }>({ shown: false, toggle: () => {} });

export function PeekProvider({ children }: { children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  return <PeekContext.Provider value={{ shown, toggle: () => setShown((s) => !s) }}>{children}</PeekContext.Provider>;
}

export function usePeek() {
  return useContext(PeekContext);
}

/**
 * An amount behind the veil. Screen readers hear "hidden" instead of the number until peeked. On Peek a
 * plain text amount "decrypts" from shade glyphs (feedback that it was hidden, now shown).
 */
export function Veiled({ children, className }: { children: React.ReactNode; className?: string }) {
  const { shown } = usePeek();
  const text = typeof children === "string" || typeof children === "number" ? String(children) : null;
  return (
    <span className={cn("relative inline-block", className)}>
      <span
        aria-hidden={!shown}
        className={cn(
          "inline-block transition-[filter,opacity] duration-(--motion-base) ease-shadow select-none",
          shown ? "opacity-100 blur-none select-auto" : "opacity-70 blur-veil",
        )}
      >
        {shown && text !== null ? <DecryptText text={text} /> : children}
      </span>
      {!shown && <span className="sr-only">hidden</span>}
    </span>
  );
}

export function PeekToggle({ className }: { className?: string }) {
  const { shown, toggle } = usePeek();
  const Icon = shown ? EyeSlash : Eye;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={shown}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors duration-150 hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        shown && "border-border-strong text-foreground",
        className,
      )}
    >
      <Icon size={14} weight="light" aria-hidden />
      {shown ? "Hide" : "Peek"}
    </button>
  );
}
