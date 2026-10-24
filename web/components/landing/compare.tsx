"use client";

import { useEffect, useId, useRef, useState } from "react";
import { motion, useInView } from "motion/react";
import { Check, Minus } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { RedactionTape } from "@/components/motion/redaction-tape";
import { Section, SectionHeading } from "./section";
import { useLandingMotion } from "./motion-pref";

type Mode = "plain" | "unzeen";

/** Illustration only: invented addresses and amounts. */
const LOG = [
  { what: "Funded from", plain: "exchange hot wallet", unzeen: "shielded ZEC", amount: "+12 SOL", amountUnzeen: "encrypted" },
  { what: "Bought $PEPE", plain: "7xKX…pQ2m", unzeen: "vault 9wQe…c07E", amount: "1.4 SOL" },
  { what: "Launched $QFROG", plain: "7xKX…pQ2m", unzeen: "fresh creator 4tUa…mB8s", amount: "0.5 SOL" },
  { what: "Sold $PEPE", plain: "7xKX…pQ2m", unzeen: "vault 9wQe…c07E", amount: "2.2 SOL" },
  { what: "Withdrew to", plain: "same wallet", unzeen: "fresh address, delayed", amount: "1.9M $PEPE" },
];

const amountOf = (r: (typeof LOG)[number], mode: Mode) => (mode === "unzeen" && "amountUnzeen" in r ? r.amountUnzeen : r.amount);

const PLAIN = [
  "Every trade is signed by your address",
  "Your funding source sits one hop away",
  "Your launches link to your trades",
  "Bots and trackers follow the address in real time",
  "Your whole history is one click on an explorer",
];
const WITH = [
  "Pool vaults sign every trade, shared by everyone",
  "You top up once in shielded ZEC: sender, amount, memo encrypted",
  "Each launch uses a fresh creator address of the pool",
  "Trades run in batches every 30–60 s, in random order",
  "Withdrawals go to a fresh address, with gas, a delay and a rounded amount",
];

function Toggle({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  const pill = useId();
  return (
    <div role="radiogroup" aria-label="Show the trade log" className="inline-flex rounded-full border border-border p-1">
      {(["plain", "unzeen"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          onClick={() => setMode(m)}
          className={cn(
            "relative h-9 rounded-full px-4 text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            mode === m ? (m === "unzeen" ? "text-zec" : "text-foreground") : "text-muted-foreground hover:text-foreground",
          )}
        >
          {mode === m && (
            <motion.span layoutId={pill} className={cn("absolute inset-0 rounded-full", m === "unzeen" ? "bg-zec/12" : "bg-surface-3")} transition={{ type: "spring", bounce: 0, duration: 0.35 }} />
          )}
          <span className="relative">{m === "plain" ? "Plain wallet" : "With unzeen"}</span>
        </button>
      ))}
    </div>
  );
}

/** One signer cell: the address gets taped over, and the pool’s side shows up under the tape. */
function Signer({ plain, unzeen, mode, index }: { plain: string; unzeen: string; mode: Mode; index: number }) {
  const [shown, setShown] = useState<Mode>(mode);
  const [tape, setTape] = useState<"hidden" | "covered" | "lifted">("hidden");
  const { still } = useLandingMotion();
  /** What the cell shows (or is about to show once the tape covers it). */
  const target = useRef<Mode>(mode);

  // Keyed on `mode` only: the swap must not cancel its own lift.
  useEffect(() => {
    if (mode === target.current) return;
    target.current = mode;
    if (still) {
      const t = setTimeout(() => {
        setShown(mode);
        setTape("hidden");
      }, 0);
      return () => clearTimeout(t);
    }
    const d = index * 110;
    const t1 = setTimeout(() => setTape("covered"), d);
    const t2 = setTimeout(() => setShown(mode), d + 260);
    const t3 = setTimeout(() => setTape("lifted"), d + 380);
    return () => {
      [t1, t2, t3].forEach(clearTimeout);
      // Interrupted (fast double toggle): land on the target without the tape.
      setShown(target.current);
      setTape("hidden");
    };
  }, [mode, still, index]);

  const isUnzeen = shown === "unzeen";
  return (
    <span className="relative inline-block max-w-full">
      <span className={cn("block truncate font-mono text-[13px]", isUnzeen ? "text-zec/90" : plain.includes("…") ? "text-sell/90" : "text-muted-foreground")}>
        {isUnzeen ? unzeen : plain}
      </span>
      {tape !== "hidden" && <RedactionTape state={tape} coverMs={220} className="-inset-x-1 inset-y-0" />}
    </span>
  );
}

export function Compare() {
  const [mode, setMode] = useState<Mode>("plain");
  const [touched, setTouched] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box, { margin: "-25% 0px", once: true });
  const { still } = useLandingMotion();

  // Plays the redaction once when the log scrolls into view, unless the visitor already chose.
  useEffect(() => {
    if (!inView || touched || still) return;
    const t = setTimeout(() => setMode("unzeen"), 1400);
    return () => clearTimeout(t);
  }, [inView, touched, still]);

  const choose = (m: Mode) => {
    setTouched(true);
    setMode(m);
  };
  const linked = mode === "plain";

  return (
    <Section id="compare" labelledBy="compare-title">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <SectionHeading id="compare-title" lead="Same trades." turn="Nothing to follow.">
          <p>Here is one person’s week on a launchpad, as an explorer shows it. Switch to Unzeen and watch what is left to connect.</p>
        </SectionHeading>
        <Toggle mode={mode} setMode={choose} />
      </div>

      <div ref={box} className="mt-12 overflow-hidden rounded-2xl border border-border">
        <table className="w-full table-fixed text-left">
          <caption className="sr-only">An example trade log, as a plain wallet and with Unzeen</caption>
          <thead>
            <tr className="border-b border-border text-xs text-faint-foreground">
              <th scope="col" className="w-[34%] px-4 py-3 font-normal sm:px-5">Event</th>
              <th scope="col" className="px-4 py-3 font-normal sm:px-5">Signed by / goes to</th>
              <th scope="col" className="hidden w-[18%] px-5 py-3 text-right font-normal sm:table-cell">Amount</th>
            </tr>
          </thead>
          <tbody>
            {LOG.map((r, i) => (
              <tr key={r.what} className="border-b border-border/60 last:border-0">
                <td className="px-4 py-4 text-[15px] sm:px-5">
                  {r.what}
                  <span className="mt-0.5 block font-mono text-xs text-faint-foreground sm:hidden">{amountOf(r, mode)}</span>
                </td>
                <td className="px-4 py-4 sm:px-5">
                  <span className="flex min-w-0 items-center gap-2">
                    <Signer plain={r.plain} unzeen={r.unzeen} mode={mode} index={i} />
                    {i > 0 && i < 4 && (
                      <motion.span
                        initial={false}
                        animate={{ opacity: linked ? 1 : 0 }}
                        transition={{ duration: 0.25 }}
                        className="hidden shrink-0 rounded-full border border-sell/30 px-2 py-0.5 text-[11px] text-sell/90 md:inline"
                      >
                        same wallet
                      </motion.span>
                    )}
                  </span>
                </td>
                <td className="tabular hidden px-5 py-4 text-right font-mono text-[13px] text-muted-foreground sm:table-cell">{amountOf(r, mode)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-faint-foreground">Illustration. Vault trades and their amounts stay public with Unzeen: the price has to be.</p>

      <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-2">
        <div className="bg-background p-6 sm:p-8">
          <h3 className="text-[17px] font-medium">Plain wallet</h3>
          <ul className="mt-5 space-y-3.5">
            {PLAIN.map((t) => (
              <li key={t} className="flex gap-3 text-[15px] leading-relaxed text-muted-foreground">
                <Minus size={16} weight="bold" aria-hidden className="mt-1 shrink-0 text-sell/80" />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-background p-6 sm:p-8">
          <h3 className="text-[17px] font-medium">With unzeen</h3>
          <ul className="mt-5 space-y-3.5">
            {WITH.map((t) => (
              <li key={t} className="flex gap-3 text-[15px] leading-relaxed text-foreground/90">
                <Check size={16} weight="bold" aria-hidden className="mt-1 shrink-0 text-zec" />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}
