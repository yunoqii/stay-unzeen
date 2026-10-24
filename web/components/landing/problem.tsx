"use client";

import { useRef } from "react";
import { AnimatePresence, motion, useInView } from "motion/react";
import { Copy, Crosshair, Binoculars } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Section, SectionHeading } from "./section";
import { useSceneClock } from "./motion-pref";

const EASE = [0.16, 1, 0.3, 1] as const;

const HARMS = [
  { icon: Copy, title: "Copy-trade bots", body: "Your buy is public the moment it lands. Bots mirror it within the same second and sell into you." },
  { icon: Binoculars, title: "Wallet trackers", body: "Launch a token and your dev wallet is watched. Every later move, every sale, gets an alert." },
  { icon: Crosshair, title: "Snipers", body: "A known wallet buying early is a signal. Snipers wait for yours and trade around it." },
];

/** Illustration rows: invented addresses, not anyone’s wallet. */
const FOLLOWERS = [
  { who: "bot Hk3w…9aQe", when: "+0.4 s", amt: "1.9M" },
  { who: "bot 2LmP…Qp1x", when: "+0.6 s", amt: "2.4M" },
  { who: "bot Zx8c…r4Tn", when: "+0.9 s", amt: "880K" },
];
const STEP_MS = [1400, 900, 900, 900, 1400, 3200] as const;

function PublicTrail() {
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box, { margin: "-20% 0px" });
  const step = useSceneClock({ steps: STEP_MS.length, stepMs: STEP_MS, active: inView });
  const shown = Math.min(FOLLOWERS.length, step);

  return (
    <div ref={box} aria-hidden className="ledger overflow-hidden rounded-2xl">
      <div className="flex items-center justify-between px-5 py-3 text-xs text-faint-foreground">
        <span>Public trades · $PEPE · pump.fun</span>
        <span className="font-mono">block 284,190,377</span>
      </div>
      <div className="relative px-5 py-4">
        {/* The trader */}
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[15px] text-muted-foreground sm:text-base">
            <span className="rounded bg-zec/12 px-1.5 py-0.5 font-mono text-[0.9em] text-zec">7xKX…pQ2m</span> bought{" "}
            <span className="tabular text-foreground">2.1M $PEPE</span> for <span className="tabular text-buy">1.4 SOL</span>
          </p>
          <span className="shrink-0 font-mono text-xs text-faint-foreground">0.0 s</span>
        </div>
        <AnimatePresence>
          {step >= 4 && (
            <motion.p
              key="tracked"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: EASE }}
              className="mt-2 text-xs text-faint-foreground"
            >
              Labelled by 31 trackers: <span className="text-muted-foreground">“dev wallet · 9 launches”</span>
            </motion.p>
          )}
        </AnimatePresence>

        {/* The followers, wired to the address */}
        <ul className="mt-4 space-y-2 border-l border-dashed border-zec/40 pl-4">
          {FOLLOWERS.map((f, i) => (
            <motion.li
              key={f.who}
              initial={false}
              animate={i < shown ? { opacity: 1, x: 0, filter: "blur(0px)" } : { opacity: 0, x: -8, filter: "blur(6px)" }}
              transition={{ duration: 0.45, ease: EASE }}
              className="relative flex items-baseline justify-between gap-3 text-sm"
            >
              <span aria-hidden className="absolute top-1/2 -left-4 h-px w-3 bg-zec/40" />
              <span className="text-muted-foreground">
                <span className="font-mono text-[0.92em] text-foreground/80">{f.who}</span> copied, bought <span className="tabular">{f.amt}</span>
              </span>
              <span className="shrink-0 font-mono text-xs text-sell/90">{f.when}</span>
            </motion.li>
          ))}
        </ul>
      </div>
      <p className={cn("px-5 py-3 text-xs text-faint-foreground transition-opacity duration-500", step >= 4 ? "opacity-100" : "opacity-40")}>
        Illustration. The same address shows up on every explorer, forever.
      </p>
    </div>
  );
}

export function Problem() {
  return (
    <Section id="problem" labelledBy="problem-title">
      <div className="grid gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16">
        <div>
          <SectionHeading id="problem-title" lead="On a launchpad," turn="your wallet is a public trail.">
            <p>
              Every buy and every launch carries your address. Anyone can open it on an explorer and read what you hold, what you bought, and when. On a bonding curve, that turns into
              money for someone else.
            </p>
          </SectionHeading>
          <ul className="mt-10 grid gap-6">
            {HARMS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="grid grid-cols-[28px_1fr] gap-x-4">
                <Icon size={22} weight="light" aria-hidden className="mt-0.5 text-zec" />
                <div>
                  <h3 className="text-[17px] font-medium tracking-tight">{title}</h3>
                  <p className="mt-1 max-w-[52ch] text-[15px] leading-relaxed text-pretty text-muted-foreground">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="lg:self-center">
          <PublicTrail />
        </div>
      </div>
    </Section>
  );
}
