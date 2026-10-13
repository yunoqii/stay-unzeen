"use client";

// uz-chaos panel (dev only, NEXT_PUBLIC_MOCK_CHAOS=1): simulate failures of the mock backend.

import { useState, useSyncExternalStore } from "react";
import { Lightning } from "@phosphor-icons/react";
import { CHAOS_MODES, getChaos, setChaos, subscribeChaos } from "@/lib/api/chaos";
import { cn } from "@/lib/utils";

export default function ChaosPanel() {
  const mode = useSyncExternalStore(subscribeChaos, getChaos, () => "off" as const);
  const [open, setOpen] = useState(false);
  return (
    <div data-uz-chaos className="fixed bottom-20 left-3 z-[70] text-xs md:bottom-4">
      {open && (
        <div role="radiogroup" aria-label="Simulate failure" className="mb-2 w-56 rounded-xl border border-border bg-popover p-1.5 shadow-xl">
          <p className="px-2 pt-1 pb-1.5 font-mono text-[10px] tracking-wider text-faint-foreground uppercase">Chaos · dev only</p>
          {CHAOS_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              onClick={() => setChaos(m.id)}
              className={cn("flex w-full flex-col items-start rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-3", mode === m.id && "bg-surface-3")}
            >
              <span className={cn(mode === m.id ? "text-zec" : "text-foreground/90")}>{m.label}</span>
              <span className="text-[10px] text-faint-foreground">{m.hint}</span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 shadow-lg backdrop-blur",
          mode === "off" ? "border-border bg-background/80 text-muted-foreground" : "border-sell/50 bg-sell/15 text-foreground",
        )}
      >
        <Lightning size={13} weight={mode === "off" ? "light" : "fill"} aria-hidden />
        Chaos{mode !== "off" ? `: ${CHAOS_MODES.find((m) => m.id === mode)?.label}` : ""}
      </button>
    </div>
  );
}
