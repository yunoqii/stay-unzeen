"use client";

import { useEffect, useId, useRef } from "react";
import { motion } from "motion/react";
import { GearSix, Lightning, ShieldCheck, Timer } from "@phosphor-icons/react";
import { EXEC_COPY, EXEC_MODES, NOW_WARNING, setDefaultExec, useDefaultExec, type ExecMode } from "@/lib/exec";
import { NETWORK_CONFIG, useNetwork } from "@/lib/network";
import { cn } from "@/lib/utils";

const ICON: Record<ExecMode, typeof Lightning> = { now: Lightning, delayed: Timer, max: ShieldCheck };

/** Profile settings. Stored in this browser per network; nothing here is sent to the server. */
export function SettingsCard() {
  const network = useNetwork();
  const mode = useDefaultExec(network);
  const id = useId();
  const ref = useRef<HTMLElement>(null);

  // Arrived from the header chip or "Change" next to a trade button: bring the card into view.
  useEffect(() => {
    if (window.location.hash !== "#settings") return;
    const t = setTimeout(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    return () => clearTimeout(t);
  }, []);

  return (
    <section ref={ref} id="settings" aria-labelledby={`${id}-t`} className="scroll-mt-24 rounded-2xl border border-border bg-card/60 p-5">
      <h2 id={`${id}-t`} className="flex items-center gap-2 font-medium">
        <GearSix size={16} weight="light" className="text-muted-foreground" aria-hidden />
        Settings
      </h2>

      <div className="mt-4">
        <p id={`${id}-exec`} className="text-sm">Default execution</p>
        <p className="mt-0.5 text-xs text-pretty text-faint-foreground">
          Used for every buy and sell. The switch next to the button changes one order only. Withdrawals always wait for a
          random delay and are never instant.
        </p>
        <div role="radiogroup" aria-labelledby={`${id}-exec`} className="mt-3 space-y-1.5">
          {EXEC_MODES.map((m) => {
            const on = m === mode;
            const Icon = ICON[m];
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setDefaultExec(network, m)}
                className={cn(
                  "relative flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  on ? "border-zec/40" : "border-border hover:border-border-strong",
                )}
              >
                {on && <motion.span layoutId={`${id}-on`} className="absolute inset-0 rounded-xl bg-zec/[0.06]" transition={{ type: "spring", bounce: 0, duration: 0.3 }} />}
                <Icon size={16} weight={on ? "duotone" : "light"} className={cn("relative mt-0.5 shrink-0", on ? "text-zec" : "text-muted-foreground")} aria-hidden />
                <span className="relative min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm">
                    {EXEC_COPY[m].label}
                    {m === "delayed" && <span className="rounded-full border border-border px-1.5 py-px text-[10px] text-faint-foreground">Recommended</span>}
                  </span>
                  <span className="mt-0.5 block text-xs text-faint-foreground">{m === "now" ? `1–3 s. ${NOW_WARNING}` : EXEC_COPY[m].hint}</span>
                </span>
                <span
                  aria-hidden
                  className={cn("relative mt-1 grid size-4 shrink-0 place-items-center rounded-full border", on ? "border-zec" : "border-border-strong")}
                >
                  {on && <span className="size-2 rounded-full bg-zec" />}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-pretty text-faint-foreground">
          Saved in this browser for {NETWORK_CONFIG[network].label} only. Never sent to the server — the pool only sees the mode of each order you sign.
        </p>
      </div>
    </section>
  );
}
