"use client";

import { useEffect, useId, useRef, useState } from "react";
import { motion } from "motion/react";
import { GearSix, Lightning, ShieldCheck, Timer } from "@phosphor-icons/react";
import { EXEC_COPY, EXEC_MODES, NOW_WARNING, setDefaultExec, useDefaultExec, type ExecMode } from "@/lib/exec";
import { NETWORK_CONFIG, useNetwork, type Network } from "@/lib/network";
import { DEFAULT_BUY_PRESETS, normalizePreset, updateTradeSettings, useTradeSettings } from "@/lib/trade-settings";
import { cn } from "@/lib/utils";
import { formatRate } from "@/lib/display";
import { nativeOf } from "@/lib/network";
import { useRates } from "@/lib/display-store";
import { DisplaySwitch } from "@/components/layout/display-switch";
import { useKeyState } from "@/lib/crypto/session";
import { setPrefs, useWorkspace } from "@/lib/workspace/store";

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
      </div>

      <QuickTrade network={network} />

      <DisplayCurrency />
      <NotificationSettings />

      <p className="mt-5 text-[11px] text-pretty text-faint-foreground">
        Execution and presets are saved in this browser for {NETWORK_CONFIG[network].label} only, the price unit for every network. Never sent to the server — the
        pool only sees the orders you sign.
      </p>
    </section>
  );
}

/** Buy presets (ZEC) and one-tap mode for the trade panel. Sell presets are fixed: 25 / 50 / 100%. */
function QuickTrade({ network }: { network: Network }) {
  const settings = useTradeSettings(network);
  const id = useId();
  return (
    <div className="mt-5 border-t border-border/60 pt-5">
      <p id={`${id}-p`} className="text-sm">
        Buy presets
      </p>
      <p className="mt-0.5 text-xs text-faint-foreground">ZEC amounts on the quick buttons. Sell presets are 25%, 50% and 100%.</p>
      <div role="group" aria-labelledby={`${id}-p`} className="mt-3 grid grid-cols-3 gap-2">
        {settings.buyPresets.map((v, i) => (
          <PresetInput
            key={`${network}:${i}:${v}`}
            index={i}
            value={v}
            onCommit={(next) => {
              const list = [...settings.buyPresets] as [string, string, string];
              list[i] = next;
              updateTradeSettings(network, { buyPresets: list });
            }}
          />
        ))}
      </div>
      {settings.buyPresets.join() !== DEFAULT_BUY_PRESETS.join() && (
        <button
          type="button"
          onClick={() => updateTradeSettings(network, { buyPresets: DEFAULT_BUY_PRESETS })}
          className="mt-2 rounded text-[11px] text-faint-foreground underline-offset-4 hover:text-muted-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Reset to 0.1 / 0.5 / 1
        </button>
      )}

      <Toggle
        className="mt-4"
        checked={settings.oneTap}
        onChange={(v) => updateTradeSettings(network, { oneTap: v })}
        title="Instant trade"
        hint="A preset, a hotkey (1–3) or “Buy” on a Pulse card signs right away, with your slippage and execution mode. Off (default): a preset only fills the amount, and a card asks once to confirm."
      />
    </div>
  );
}

/** Toasts and the chime: kept with the watchlist and alerts, encrypted on this device. Needs the key unlocked. */
export function NotificationSettings() {
  const key = useKeyState();
  const ws = useWorkspace();
  if (key.status !== "unlocked" || !ws.ready) return null;
  const p = ws.file.prefs;
  return (
    <div className="mt-5 border-t border-border/60 pt-5">
      <p className="text-sm">Notifications</p>
      <Toggle
        className="mt-3"
        checked={p.toasts}
        onChange={(v) => void setPrefs(key.network, key.pubkey, { toasts: v })}
        title="Toasts when something settles"
        hint="Delayed and max-privacy batches, triggered orders and scenario steps, read from the portfolio this tab already polls."
      />
      <Toggle className="mt-3" checked={p.sound} disabled={!p.toasts} onChange={(v) => void setPrefs(key.network, key.pubkey, { sound: v })} title="Sound" hint="A short chime with them, made in the browser." />
    </div>
  );
}

function Toggle({ checked, onChange, title, hint, className, disabled }: { checked: boolean; onChange: (v: boolean) => void; title: string; hint: string; className?: string; disabled?: boolean }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3", disabled && "cursor-not-allowed opacity-50", className)}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span
        aria-hidden
        className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full border border-border-strong bg-surface-2 transition-colors peer-checked:bg-zec/30 peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
      >
        <span className={cn("absolute top-0.5 left-0.5 size-3.5 rounded-full bg-muted-foreground transition-transform duration-200", checked && "translate-x-4 bg-zec")} />
      </span>
      <span className="text-sm">
        {title}
        <span className="mt-0.5 block text-xs text-pretty text-faint-foreground">{hint}</span>
      </span>
    </label>
  );
}

function PresetInput({ index, value, onCommit }: { index: number; value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const norm = normalizePreset(draft);
  const commit = () => {
    if (norm && norm !== value) onCommit(norm);
    else setDraft(value);
  };
  return (
    <span className={cn("flex h-10 items-center rounded-xl border bg-surface-1 px-3 focus-within:border-ring", draft && !norm ? "border-destructive/60" : "border-border")}>
      <input
        aria-label={`Buy preset ${index + 1}, ZEC`}
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(",", "."))}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="tabular w-full min-w-0 bg-transparent text-sm outline-none"
      />
      <span className="ml-1 text-xs text-faint-foreground">ZEC</span>
    </span>
  );
}

/** ZEC (default) or the chain's native coin for prices, market caps, volumes and PnL. */
function DisplayCurrency() {
  const id = useId();
  const { rates } = useRates();
  return (
    <div className="mt-5 border-t border-border/60 pt-5">
      <div className="flex items-center justify-between gap-3">
        <p id={`${id}-d`} className="text-sm">
          Show prices in
        </p>
        <DisplaySwitch aria-labelledby={`${id}-d`} />
      </div>
      <p className="mt-1 text-xs text-pretty text-faint-foreground">
        Prices, market caps, volumes and PnL read in ZEC, the currency of your account. {nativeOf().symbol} shows them in the chain&rsquo;s own coin. Converted figures
        carry &ldquo;≈&rdquo; at a public rate{(nativeOf().symbol === "ETH" ? rates?.zecEth : rates?.zecSol) ? ` (1 ZEC ≈ ${formatRate((nativeOf().symbol === "ETH" ? rates?.zecEth : rates?.zecSol)!, nativeOf().symbol === "ETH" ? 6 : 4)} ${nativeOf().symbol})` : ""}; your trades always run at the
        pool&rsquo;s own quote.
      </p>
    </div>
  );
}
