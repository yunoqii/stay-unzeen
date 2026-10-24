"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useInView } from "motion/react";
import { House, Lightning, RocketLaunch, Wallet, Coins, Eye } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { TapeMark } from "@/components/layout/logo";
import { CollapseIdentity } from "@/components/motion/collapse-identity";
import { RedactionTape } from "@/components/motion/redaction-tape";
import { useLandingMotion } from "./motion-pref";

export interface MockTrade {
  id: string;
  verb: "bought" | "sold" | "launched";
  amount?: string;
  symbol: string;
  pay?: string;
  unit?: string;
  venue: string;
}

/** Illustration data: no real tokens, no real transactions. */
const SCRIPT: Omit<MockTrade, "id">[] = [
  { verb: "bought", amount: "1.2M", symbol: "PEPE", pay: "0.4", unit: "SOL", venue: "pump.fun" },
  { verb: "sold", amount: "860K", symbol: "MOTH", pay: "0.21", unit: "ZEC", venue: "Meteora DBC" },
  { verb: "launched", symbol: "QFROG", venue: "pump.fun" },
  { verb: "bought", amount: "3.4M", symbol: "GLOOM", pay: "1.05", unit: "ZEC", venue: "pump.fun" },
  { verb: "bought", amount: "92K", symbol: "VEIL", pay: "0.08", unit: "ZEC", venue: "Meteora DBC" },
  { verb: "sold", amount: "2.1M", symbol: "PEPE", pay: "0.77", unit: "SOL", venue: "pump.fun" },
  { verb: "bought", amount: "455K", symbol: "DUSK", pay: "0.3", unit: "ZEC", venue: "LaunchLab" },
];

const AGES = ["now", "4s", "11s", "19s", "32s"];

export function TradeLine({ t, play, className }: { t: MockTrade; play: boolean; className?: string }) {
  return (
    <p className={cn("leading-snug tracking-tight text-muted-foreground", className)}>
      <CollapseIdentity id={`mock-${t.id}`} play={play} exclusive={false} className="text-foreground/90" />{" "}
      {t.verb} {t.amount && <span className="tabular font-medium text-foreground">{t.amount} </span>}
      <span className="font-medium text-foreground">${t.symbol}</span>
      {t.pay && (
        <>
          {" "}
          for <span className={cn("tabular font-medium", t.verb === "bought" ? "text-buy" : "text-sell")}>{t.pay}</span>{" "}
          <span className={t.unit === "ZEC" ? "text-zec/80" : "text-faint-foreground"}>{t.unit}</span>
        </>
      )}
    </p>
  );
}

function Dot({ verb }: { verb: MockTrade["verb"] }) {
  return (
    <span aria-hidden className="relative mt-0.5 grid size-6 shrink-0 place-items-center">
      <span className={cn("absolute inset-0 rounded-full blur-[5px]", verb === "bought" && "bg-buy/25", verb === "sold" && "bg-sell/25", verb === "launched" && "bg-zec/30")} />
      <span className="relative size-3 rounded-full bg-[radial-gradient(circle_at_50%_35%,#3a3a42,#0b0b0d_70%)] ring-1 ring-white/10" />
    </span>
  );
}

/**
 * Hero illustration: the app on a phone. New feed rows arrive every ~2.6 s and their "who" collapses into
 * "unzeen" (the M2 gesture of the real feed). Runs only while on screen and not paused.
 */
export function PhoneMock() {
  const { still } = useLandingMotion();
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box, { margin: "-10% 0px" });
  const [rows, setRows] = useState<MockTrade[]>(() => SCRIPT.slice(0, 4).map((t, i) => ({ ...t, id: `s${i}` })));
  const [fresh, setFresh] = useState<string | null>(null);
  const next = useRef(4);

  useEffect(() => {
    if (still || !inView) return;
    const t = setInterval(() => {
      const n = next.current++;
      const id = `n${n}`;
      setRows((r) => [{ ...SCRIPT[n % SCRIPT.length], id }, ...r].slice(0, 5));
      setFresh(id);
    }, 2600);
    return () => clearInterval(t);
  }, [still, inView]);

  return (
    <div ref={box} aria-hidden className="relative mx-auto w-[min(100%,300px)] select-none">
      {/* Frame */}
      <div className="relative rounded-[46px] border border-white/10 bg-[linear-gradient(160deg,#1a1a1f,#0b0b0d_40%)] p-2.5 shadow-[0_40px_80px_-20px_rgb(0_0_0/0.8),0_0_0_1px_rgb(0_0_0/0.6)]">
        <div className="phone-screen relative h-[600px] overflow-hidden rounded-[38px] bg-background">
          {/* Status bar */}
          <div className="flex items-center justify-between px-6 pt-3 pb-1 font-mono text-[11px] text-muted-foreground">
            <span>9:41</span>
            <span className="h-5 w-20 rounded-full bg-black" />
            <span className="tabular">5G</span>
          </div>
          {/* App bar */}
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
            <span className="flex items-center gap-1.5 text-[13px] font-medium">
              <TapeMark className="size-5" />
              unzeen
            </span>
            <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-faint-foreground">Devnet</span>
          </div>

          {/* Balance: taped over, like the app’s Peek */}
          <div className="border-b border-border/60 px-4 py-3.5">
            <div className="flex items-center justify-between text-[11px] text-faint-foreground">
              <span>Private balance</span>
              <span className="inline-flex items-center gap-1">
                <Eye size={12} weight="light" />
                Peek
              </span>
            </div>
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className="relative inline-block">
                <span className="tabular invisible text-2xl font-medium tracking-tight">12.4810</span>
                <RedactionTape state="covered" instant className="inset-y-1" />
              </span>
              <span className="text-sm text-zec/80">ZEC</span>
            </div>
          </div>

          {/* Feed */}
          <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
            <span className="text-[12px] font-medium">What unzeen is doing</span>
            <span className="flex items-center gap-1.5 text-[10px] text-faint-foreground">
              <span className="live-dot size-1.5 rounded-full bg-buy" />
              Live
            </span>
          </div>
          <ul className="relative px-1">
            <AnimatePresence initial={false}>
              {rows.map((r, i) => (
                <motion.li
                  key={r.id}
                  layout="position"
                  initial={{ opacity: 0, filter: "blur(12px)", y: -8 }}
                  animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
                  exit={{ opacity: 0, filter: "blur(8px)", transition: { duration: 0.2 } }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], layout: { type: "spring", bounce: 0, duration: 0.4 } }}
                  className="flex items-start gap-2.5 border-b border-border/40 px-3 py-2.5"
                >
                  <Dot verb={r.verb} />
                  <div className="min-w-0 flex-1">
                    <TradeLine t={r} play={r.id === fresh} className="text-[13.5px]" />
                    <p className="mt-0.5 text-[10.5px] text-faint-foreground">{r.venue}</p>
                  </div>
                  <span className="tabular shrink-0 pt-0.5 font-mono text-[10px] text-faint-foreground">{AGES[i]}</span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>

          {/* Quick buy + tab bar */}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background to-transparent pt-8">
            <div className="flex gap-1.5 px-4 pb-3">
              {["0.1", "0.5", "1"].map((v, i) => (
                <span
                  key={v}
                  className={cn(
                    "flex-1 rounded-full border py-2 text-center text-[11.5px] font-medium",
                    i === 1 ? "border-zec/50 bg-zec/10 text-zec" : "border-border text-muted-foreground",
                  )}
                >
                  Buy {v} ZEC
                </span>
              ))}
            </div>
            <div className="flex justify-around border-t border-border/60 px-2 pt-2.5 pb-5 text-faint-foreground">
              <House size={18} weight="light" className="text-foreground" />
              <Lightning size={18} weight="light" />
              <Coins size={18} weight="light" />
              <RocketLaunch size={18} weight="light" />
              <Wallet size={18} weight="light" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
