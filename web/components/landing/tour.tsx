"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useInView } from "motion/react";
import { cn } from "@/lib/utils";
import { Section, SectionHeading } from "./section";
import { useLandingMotion } from "./motion-pref";
import { LaunchScene, TopUpScene, TradeScene, VerifyScene, WithdrawScene } from "./tour-scenes";

const SCENE_MS = 7500;

const SCENES = [
  { id: "topup", tab: "Top up", title: "One scan from ZODL.", body: "The QR carries the pool’s address, the amount and a memo signed by your key. When it is credited, the deposit is shielded and no longer tied to anything you do next.", Scene: TopUpScene },
  { id: "trade", tab: "Trade", title: "Buy from your balance.", body: "Pick a preset and a mode. Delayed, the default, joins the next pool batch and runs in random order. A pool vault buys; the feed shows “unzeen”.", Scene: TradeScene },
  { id: "launch", tab: "Launch", title: "Launch as nobody.", body: "A fresh creator address of the pool launches your token, and the creator rights stay with your anon key. The pool enforces the rules buyers care about.", Scene: LaunchScene },
  { id: "withdraw", tab: "Withdraw", title: "Leave without a trail.", body: "Tokens go to a fresh address with gas to move them, a rounded amount and a random delay. ZEC goes out shielded, batched with other payouts.", Scene: WithdrawScene },
  { id: "verify", tab: "Verify", title: "Check the pool, not the people.", body: "A daily Merkle-sum tree of what the pool owes. Your browser checks your own leaf up to a signed root. It never sees anyone else’s balance.", Scene: VerifyScene },
] as const;

export function Tour() {
  const [index, setIndex] = useState(0);
  const [touched, setTouched] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box, { margin: "-20% 0px" });
  const { still } = useLandingMotion();
  const auto = inView && !touched && !still;

  useEffect(() => {
    if (!auto) return;
    const t = setTimeout(() => setIndex((i) => (i + 1) % SCENES.length), SCENE_MS);
    return () => clearTimeout(t);
  }, [auto, index]);

  const pick = (i: number) => {
    setTouched(true);
    setIndex(i);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (index + d + SCENES.length) % SCENES.length;
    pick(n);
    document.getElementById(`tour-tab-${SCENES[n].id}`)?.focus();
  };
  const scene = SCENES[index];
  const { Scene } = scene;

  return (
    <Section id="tour" labelledBy="tour-title">
      <SectionHeading id="tour-title" lead="See it work," turn="before you top up.">
        <p>Five moments from the app, acted out with example values. No funds move on this page.</p>
      </SectionHeading>

      <div ref={box} className="mt-12 grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-10">
        <div role="tablist" aria-label="Product tour" aria-orientation="vertical" onKeyDown={onKey} className="tour-tabs -mx-(--landing-gutter) flex gap-2 overflow-x-auto px-(--landing-gutter) lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0">
          {SCENES.map((s, i) => {
            const on = i === index;
            return (
              <button
                key={s.id}
                id={`tour-tab-${s.id}`}
                role="tab"
                type="button"
                aria-selected={on}
                aria-controls="tour-panel"
                tabIndex={on ? 0 : -1}
                onClick={() => pick(i)}
                className={cn(
                  "relative shrink-0 overflow-hidden rounded-full border px-4 py-2 text-left text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none lg:rounded-xl lg:border-0 lg:px-4 lg:py-3.5",
                  on ? "border-border-strong bg-surface-2 text-foreground" : "border-border text-muted-foreground hover:text-foreground lg:hover:bg-surface-1",
                )}
              >
                <span className="flex items-baseline gap-3">
                  <span className={cn("hidden font-mono text-xs lg:inline", on ? "text-zec" : "text-faint-foreground")}>{String(i + 1).padStart(2, "0")}</span>
                  <span className="font-medium">{s.tab}</span>
                </span>
                <span className={cn("mt-1 hidden pl-8 text-[13px] leading-snug text-muted-foreground", on && "lg:block")}>{s.title}</span>
                {on && auto && <span key={`p${index}`} aria-hidden className="tour-progress absolute inset-x-0 bottom-0 h-px bg-zec/70" style={{ animationDuration: `${SCENE_MS}ms` }} />}
              </button>
            );
          })}
        </div>

        <div id="tour-panel" role="tabpanel" aria-labelledby={`tour-tab-${scene.id}`} className="min-w-0">
          <div className="relative grid min-h-[440px] place-items-center overflow-hidden rounded-3xl border border-border bg-[radial-gradient(120%_80%_at_50%_0%,rgb(244_183_40/0.06),transparent_60%),var(--uz-ink-1)] p-4 sm:p-8">
            <div aria-hidden className="hatch absolute inset-x-0 top-0 h-2 opacity-60" />
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={scene.id}
                initial={{ opacity: 0, y: 10, filter: "blur(8px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -6, filter: "blur(6px)" }}
                transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                className="flex w-full justify-center"
                aria-hidden
              >
                <Scene active={inView} />
              </motion.div>
            </AnimatePresence>
          </div>
          <div className="mt-5 max-w-[60ch]">
            <h3 className="text-lg font-medium tracking-tight lg:sr-only">{scene.title}</h3>
            <p className="mt-1.5 text-[15px] lg:mt-0 leading-relaxed text-pretty text-muted-foreground">{scene.body}</p>
          </div>
        </div>
      </div>
    </Section>
  );
}
