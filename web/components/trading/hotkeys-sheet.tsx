"use client";

import { useEffect, useRef } from "react";
import { Keyboard, X } from "@phosphor-icons/react";
import { HOTKEYS } from "@/lib/trade-intent";

/** "?" on a token page: the keyboard map. Esc or the backdrop closes it; focus returns where it was. */
export function HotkeysSheet({ open, onClose, instant }: { open: boolean; onClose: () => void; instant: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("keydown", esc);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hotkeys-t"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-border bg-popover p-5 shadow-2xl focus:outline-none"
      >
        <div className="flex items-center justify-between">
          <h2 id="hotkeys-t" className="flex items-center gap-2 text-sm font-medium">
            <Keyboard size={16} aria-hidden /> Keyboard
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <X size={14} aria-hidden />
          </button>
        </div>
        <dl className="mt-4 space-y-2 text-sm">
          {HOTKEYS.map((h) => (
            <div key={h.keys} className="flex items-baseline justify-between gap-4">
              <dt>
                <kbd className="rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-[11px]">{h.keys}</kbd>
              </dt>
              <dd className="text-right text-muted-foreground">{h.does}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-[11px] text-pretty text-faint-foreground">
          {instant ? "Instant trade is on: a preset key signs right away (4 / max only fills the amount)." : "Instant trade is off: a preset key fills the amount; Enter signs."} Keys never fire while you type in a field.
        </p>
      </div>
    </div>
  );
}
