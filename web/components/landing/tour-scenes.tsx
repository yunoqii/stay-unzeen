"use client";

import { motion, AnimatePresence } from "motion/react";
import { Check, Warning, ShieldCheck } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { CountUp } from "@/components/motion/count-up";
import { RedactionTape } from "@/components/motion/redaction-tape";
import { useSceneClock } from "./motion-pref";
import { TradeLine } from "./phone-mock";

const EASE = [0.16, 1, 0.3, 1] as const;
const fmt4 = (n: number) => n.toFixed(4);

/** Shared look of a scene: one app-like card on the stage. */
function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("w-full max-w-[400px] rounded-2xl border border-border bg-background/90 p-5 shadow-[0_30px_60px_-24px_rgb(0_0_0/0.9)]", className)}>{children}</div>;
}

function Appear({ on, children, className, delay = 0, as = "div" }: { on: boolean; children: React.ReactNode; className?: string; delay?: number; as?: "div" | "li" }) {
  const Tag = as === "li" ? motion.li : motion.div;
  return (
    <Tag
      initial={false}
      animate={on ? { opacity: 1, y: 0, filter: "blur(0px)" } : { opacity: 0, y: 6, filter: "blur(6px)" }}
      transition={{ duration: 0.45, ease: EASE, delay: on ? delay : 0 }}
      className={className}
    >
      {children}
    </Tag>
  );
}

/* ---------- 1. Top up ---------- */

/** A QR-like pattern for the illustration. Deliberately not a scannable code: nobody should pay a picture. */
function FakeQr() {
  const n = 25;
  const cells: [number, number][] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const finder = (x: number, y: number) => [[0, 0], [n - 7, 0], [0, n - 7]].some(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!finder(x, y) && rnd() > 0.52) cells.push([x, y]);
  return (
    <svg viewBox={`-2 -2 ${n + 4} ${n + 4}`} className="size-full" aria-hidden>
      <rect x={-2} y={-2} width={n + 4} height={n + 4} rx={2} fill="#ededf0" />
      {[[0, 0], [n - 7, 0], [0, n - 7]].map(([x, y]) => (
        <g key={`${x}-${y}`} fill="#0b0b0d">
          <path d={`M${x} ${y}h7v7h-7z M${x + 1} ${y + 1}v5h5v-5z`} fillRule="evenodd" />
          <rect x={x + 2} y={y + 2} width={3} height={3} />
        </g>
      ))}
      {cells.map(([x, y]) => (
        <rect key={`${x}.${y}`} x={x} y={y} width={1.02} height={1.02} fill="#0b0b0d" />
      ))}
    </svg>
  );
}

const TOPUP_MS = [1700, 1500, 3000] as const;
const PAY_STEPS = ["Waiting for payment", "Seen", "Credited"];

export function TopUpScene({ active }: { active: boolean }) {
  const step = useSceneClock({ steps: TOPUP_MS.length, stepMs: TOPUP_MS, active, loop: false });
  const credited = step >= 2;
  return (
    <Card className="grid gap-5 sm:grid-cols-[132px_1fr] sm:items-center">
      <div className="relative mx-auto size-[132px]">
        <span className={cn("absolute -inset-2 rounded-2xl border border-zec/50", !credited && "qr-breathe")} />
        <div className="relative size-full overflow-hidden rounded-xl">
          <FakeQr />
        </div>
      </div>
      <div className="min-w-0">
        <p className="text-[13px] text-faint-foreground">Scan with ZODL</p>
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">zcash:u1qz…8f?amount=0.5&amp;memo=…</p>
        <ol className="mt-4 flex gap-1 rounded-full border border-border p-1 text-[11px]">
          {PAY_STEPS.map((s, i) => (
            <li key={s} className={cn("relative flex-1 rounded-full px-1.5 py-1 text-center whitespace-nowrap", i === step ? "text-foreground" : "text-faint-foreground")}>
              {i === step && <motion.span layoutId="tour-pay" className={cn("absolute inset-0 rounded-full", i === 2 ? "bg-zec/15" : "bg-surface-3")} transition={{ type: "spring", bounce: 0, duration: 0.35 }} />}
              <span className={cn("relative", i === 2 && i === step && "text-zec")}>{s}</span>
            </li>
          ))}
        </ol>
        <div className="mt-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Incoming</span>
            <span className="relative font-mono">
              0.5 ZEC
              {credited && <RedactionTape state="covered" className="-inset-x-1 inset-y-0" />}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Private balance</span>
            <span className="tabular font-mono text-foreground">
              {credited ? <CountUp value={0.5} format={fmt4} className="text-zec" /> : fmt4(0)} <span className="text-zec/80">ZEC</span>
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ---------- 2. Trade ---------- */

const TRADE_MS = [1100, 1100, 1900, 3500] as const;

export function TradeScene({ active }: { active: boolean }) {
  const step = useSceneClock({ steps: TRADE_MS.length, stepMs: TRADE_MS, active, loop: false });
  return (
    <Card>
      <div className="flex items-baseline justify-between">
        <p className="text-lg font-medium">$PEPE</p>
        <p className="text-xs text-faint-foreground">pump.fun · on the curve</p>
      </div>
      <svg viewBox="0 0 300 60" className="mt-3 h-14 w-full" aria-hidden>
        <polyline points="0,48 25,44 50,46 75,38 100,40 125,31 150,34 175,25 200,27 225,18 250,22 275,12 300,9" fill="none" stroke="var(--uz-buy)" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <div className="mt-4 flex gap-1.5">
        {["0.1", "0.5", "1"].map((v) => (
          <span
            key={v}
            className={cn(
              "flex-1 rounded-full border py-2 text-center text-xs font-medium transition-colors duration-200",
              v === "0.5" && step >= 1 ? "border-zec/50 bg-zec/10 text-zec" : "border-border text-muted-foreground",
            )}
          >
            {v} ZEC
          </span>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="inline-flex rounded-full border border-border p-0.5">
          <span className="rounded-full px-2.5 py-1 text-faint-foreground">Now</span>
          <span className="rounded-full bg-surface-3 px-2.5 py-1 text-foreground">Delayed</span>
        </span>
        <span className="text-faint-foreground">30–60 s batch · better privacy</span>
      </div>
      <div className={cn("mt-4 grid h-11 place-items-center rounded-full text-sm font-medium", step === 2 ? "busy-hatch bg-zec/80 text-primary-foreground" : "bg-zec text-primary-foreground")}>
        {step < 2 ? "Buy 0.5 ZEC" : step === 2 ? "In the next batch · 41 s" : "Filled"}
      </div>
      <div className="mt-4 min-h-[52px] border-t border-border/60 pt-3">
        <AnimatePresence>
          {step >= 3 && (
            <motion.div key="fill" initial={{ opacity: 0, filter: "blur(10px)", y: -6 }} animate={{ opacity: 1, filter: "blur(0px)", y: 0 }} transition={{ duration: 0.5, ease: EASE }}>
              <TradeLine t={{ id: "tour-buy", verb: "bought", amount: "1.2M", symbol: "PEPE", pay: "0.5", unit: "ZEC", venue: "pump.fun" }} play className="text-[15px]" />
              <p className="mt-0.5 text-[11px] text-faint-foreground">public feed · signed by a pool vault</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Card>
  );
}

/* ---------- 3. Launch ---------- */

const LAUNCH_MS = [1000, 1400, 1500, 3600] as const;
const RULES = ["Creator’s initial buy locked for 24h", "Creator capped at 5% of supply", "Mint & freeze authority revoked"];

export function LaunchScene({ active }: { active: boolean }) {
  const step = useSceneClock({ steps: LAUNCH_MS.length, stepMs: LAUNCH_MS, active, loop: false });
  const typed = step >= 1;
  return (
    <Card>
      <div className="grid grid-cols-[1fr_104px] gap-2">
        <Field label="Name" value={typed ? "Quiet Frog" : ""} />
        <Field label="Ticker" value={typed ? "QFROG" : ""} />
      </div>
      <div className="mt-3 flex gap-1.5 text-xs">
        <span className="rounded-full border border-zec/50 bg-zec/10 px-3 py-1.5 text-zec">pump.fun</span>
        <span className="rounded-full border border-border px-3 py-1.5 text-muted-foreground">Meteora DBC</span>
      </div>
      <div className={cn("mt-4 grid h-11 place-items-center rounded-full text-sm font-medium", step === 2 ? "busy-hatch bg-zec/80 text-primary-foreground" : "bg-zec text-primary-foreground")}>
        {step < 2 ? "Launch" : step === 2 ? "Launching from a fresh creator address" : "Launched"}
      </div>
      <Appear on={step >= 3} className="mt-4 rounded-xl border border-zec/30 bg-zec-soft p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck size={16} weight="duotone" className="text-zec" aria-hidden />
          Unzeen launch: dev anonymous, rules enforced
        </p>
        <ul className="mt-3 space-y-1.5">
          {RULES.map((r, i) => (
            <Appear key={r} as="li" on={step >= 3} delay={0.15 + i * 0.12} className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Check size={13} weight="bold" className="text-zec" aria-hidden />
              {r}
            </Appear>
          ))}
        </ul>
      </Appear>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-1 px-3 py-2">
      <p className="text-[11px] text-faint-foreground">{label}</p>
      <p className="h-5 truncate text-sm">{value || <span className="text-faint-foreground/60">…</span>}</p>
    </div>
  );
}

/* ---------- 4. Withdraw ---------- */

const WITHDRAW_MS = [1300, 1300, 1600, 3400] as const;
const CHECKS = ["Gas drop from a pool vault", "Amount rounded", "Random delay before it leaves"];

export function WithdrawScene({ active }: { active: boolean }) {
  const step = useSceneClock({ steps: WITHDRAW_MS.length, stepMs: WITHDRAW_MS, active, loop: false });
  return (
    <Card>
      <p className="text-[13px] text-faint-foreground">Withdraw tokens</p>
      <p className="tabular mt-1 text-2xl font-medium tracking-tight">
        1,900,000 <span className="text-muted-foreground">$PEPE</span>
      </p>
      <div className="mt-4 rounded-xl border border-dashed border-border-strong px-3 py-2.5">
        <p className="text-[11px] text-faint-foreground">To</p>
        <p className="truncate font-mono text-sm">9xQf…k2Lm</p>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-zec/90">
        <Warning size={13} weight="fill" aria-hidden />
        Use a fresh address — not your main wallet.
      </p>
      <ul className="mt-4 space-y-2">
        {CHECKS.map((c, i) => (
          <Appear key={c} as="li" on={step >= 1} delay={i * 0.14} className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Check size={13} weight="bold" className="text-zec" aria-hidden />
            {c}
          </Appear>
        ))}
      </ul>
      <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3 text-sm">
        <span className="text-muted-foreground">Status</span>
        <span className={cn("font-mono text-[13px]", step >= 3 ? "text-zec" : "text-foreground")}>{step < 2 ? "Ready" : step === 2 ? "Leaves in 4m 12s" : "Sent · 1.9M rounded"}</span>
      </div>
    </Card>
  );
}

/* ---------- 5. Verify ---------- */

const VERIFY_MS = [1200, 900, 900, 3800] as const;
const YOU = 2; // leaf index

export function VerifyScene({ active }: { active: boolean }) {
  const step = useSceneClock({ steps: VERIFY_MS.length, stepMs: VERIFY_MS, active, loop: false });
  const levels = [8, 4, 2, 1];
  const W = 320;
  const yOf = (l: number) => 150 - l * 44;
  const xOf = (l: number, i: number) => (W / levels[l]) * (i + 0.5);
  const onPath = (l: number, i: number) => i === YOU >> l;
  const lit = (l: number) => step >= l;

  return (
    <Card>
      <svg viewBox={`0 0 ${W} 170`} className="w-full" aria-hidden>
        {levels.slice(1).map((count, li) => {
          const l = li + 1;
          return Array.from({ length: count }, (_, i) =>
            [0, 1].map((c) => {
              const child = i * 2 + c;
              const hot = onPath(l - 1, child) && lit(l);
              return (
                <line
                  key={`${l}-${i}-${c}`}
                  x1={xOf(l, i)}
                  y1={yOf(l)}
                  x2={xOf(l - 1, child)}
                  y2={yOf(l - 1)}
                  stroke={hot ? "var(--uz-zec)" : "var(--uz-fog-1)"}
                  strokeWidth={hot ? 1.6 : 1}
                  style={{ transition: "stroke 300ms" }}
                />
              );
            }),
          );
        })}
        {levels.map((count, l) =>
          Array.from({ length: count }, (_, i) => {
            const hot = onPath(l, i) && lit(l);
            return (
              <circle
                key={`n${l}-${i}`}
                cx={xOf(l, i)}
                cy={yOf(l)}
                r={l === 3 ? 7 : 5}
                fill={hot ? "var(--uz-zec)" : "var(--uz-ink-3)"}
                stroke={hot ? "var(--uz-zec)" : "var(--uz-fog-1)"}
                style={{ transition: "fill 300ms, stroke 300ms" }}
              />
            );
          }),
        )}
        <text x={xOf(0, YOU)} y={yOf(0) + 20} textAnchor="middle" className="fill-zec font-mono text-[10px]">
          you
        </text>
        <text x={xOf(3, 0) + 14} y={yOf(3) + 4} className="fill-[var(--uz-fog-3)] font-mono text-[10px]">
          root · signed
        </text>
      </svg>
      <Appear on={step >= 3} className="mt-2 space-y-1.5 border-t border-border/60 pt-3">
        <p className="flex items-center gap-2 text-sm">
          <Check size={14} weight="bold" className="text-zec" aria-hidden />
          Your balance is counted in the liabilities
        </p>
        <p className="text-[13px] text-muted-foreground">Checked in this browser. Nobody else’s balance, and no viewing key, is ever shown.</p>
      </Appear>
    </Card>
  );
}
