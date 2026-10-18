"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Bell, BellRinging, Trash, ArrowCounterClockwise } from "@phosphor-icons/react";
import type { Token } from "@/lib/api/types";
import { useKeyState } from "@/lib/crypto/session";
import { useDisplay } from "@/lib/display-store";
import { formatCompact, formatPrice } from "@/lib/format";
import { askNotifications, notificationsAllowed, notificationsSupported } from "@/lib/notify";
import { createAlert, deleteAlert, rearmAlert, useWorkspace, type AlertDir, type AlertMetric } from "@/lib/workspace/store";
import { cn } from "@/lib/utils";

/**
 * Price / market-cap alerts for this token, kept encrypted on this device. Checked against the public token list
 * every unlocked tab polls anyway; one-shot (re-arm after it fires). Alerts work for tokens the pool trades.
 */
export function AlertButton({ token, priceSol }: { token: Token; priceSol: string }) {
  const key = useKeyState();
  const ws = useWorkspace();
  const display = useDisplay();
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState<AlertMetric>("price");
  const [dir, setDir] = useState<AlertDir>("above");
  const [value, setValue] = useState("");
  const [perm, setPerm] = useState<string>("default");
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (key.status !== "unlocked") return null;

  const mine = ws.file.alerts.filter((a) => a.mint === token.mint);
  const armed = mine.filter((a) => !a.firedAt).length;
  // The user types in the display unit (ZEC by default); the alert is kept in SOL, the list's own unit.
  const perSol = display.sol(1);
  const current = metric === "price" ? Number(priceSol) : Number(token.marketCapSol);
  const currentShown = perSol === null ? null : current * perSol;
  const v = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(v) && v > 0 && perSol !== null && perSol > 0;
  const fmt = (n: number) => (metric === "price" ? formatPrice(n) : formatCompact(n));
  const unit = display.unit;

  const add = async () => {
    if (!valid || perSol === null) return;
    await createAlert(key.network, key.pubkey, { id: crypto.randomUUID(), mint: token.mint, symbol: token.symbol, metric, dir, thresholdSol: v / perSol, createdAt: Date.now() });
    setValue("");
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-pop`}
        aria-label={armed ? `${armed} price alerts on $${token.symbol}` : `Set a price alert on $${token.symbol}`}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          armed ? "border-zec/50 text-zec" : "border-border text-muted-foreground hover:text-foreground",
        )}
      >
        {armed ? <BellRinging size={14} aria-hidden /> : <Bell size={14} aria-hidden />}
        {armed ? `Alerts · ${armed}` : "Alert"}
      </button>
      {open && (
        <div id={`${id}-pop`} role="dialog" aria-label={`Price alerts for $${token.symbol}`} className="absolute right-0 z-40 mt-2 w-80 rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-2xl">
          <p className="text-sm font-medium">Alert me when ${token.symbol}</p>
          <div className="mt-3 grid grid-cols-2 gap-1.5 text-xs">
            {(["price", "mcap"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={metric === m} onClick={() => setMetric(m)} className={cn("rounded-full border py-1.5", metric === m ? "border-zec/60 text-foreground" : "border-border text-muted-foreground")}>
                {m === "price" ? "Price" : "Market cap"}
              </button>
            ))}
            {(["above", "below"] as const).map((d) => (
              <button key={d} type="button" aria-pressed={dir === d} onClick={() => setDir(d)} className={cn("rounded-full border py-1.5", dir === d ? "border-zec/60 text-foreground" : "border-border text-muted-foreground")}>
                {d === "above" ? "Rises to" : "Falls to"}
              </button>
            ))}
          </div>
          <label htmlFor={`${id}-v`} className="mt-3 block text-xs text-faint-foreground">
            {metric === "price" ? "Price per token" : "Market cap"}, {unit}
            {currentShown !== null && <span className="tabular"> · now {display.converted ? "≈ " : ""}{fmt(currentShown)}</span>}
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id={`${id}-v`}
              inputMode="decimal"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value.replace(",", "."))}
              onKeyDown={(e) => e.key === "Enter" && void add()}
              placeholder={currentShown !== null ? fmt(currentShown) : "0"}
              className="tabular h-9 min-w-0 flex-1 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-ring"
            />
            <button type="button" disabled={!valid} onClick={() => void add()} className="h-9 rounded-xl bg-zec px-3 text-sm font-medium text-background disabled:opacity-40">
              Add
            </button>
          </div>
          {mine.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t border-border/60 pt-3 text-xs">
              {mine.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span className={cn("tabular", a.firedAt && "text-faint-foreground line-through")}>
                    {a.metric === "price" ? "Price" : "MCap"} {a.dir === "above" ? "≥" : "≤"} {perSol === null ? `${fmt(a.thresholdSol)} SOL` : `${display.converted ? "≈ " : ""}${fmt(a.thresholdSol * perSol)} ${unit}`}
                  </span>
                  <span className="flex gap-1">
                    {a.firedAt && (
                      <button type="button" aria-label="Re-arm" title="Re-arm" onClick={() => void rearmAlert(key.network, key.pubkey, a.id)} className="rounded-full p-1 text-muted-foreground hover:text-foreground">
                        <ArrowCounterClockwise size={12} aria-hidden />
                      </button>
                    )}
                    <button type="button" aria-label="Remove alert" onClick={() => void deleteAlert(key.network, key.pubkey, a.id)} className="rounded-full p-1 text-muted-foreground hover:text-sell">
                      <Trash size={12} aria-hidden />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {notificationsSupported() && !notificationsAllowed() && perm !== "denied" && (
            <button type="button" onClick={async () => setPerm(String(await askNotifications()))} className="mt-3 text-xs text-zec underline-offset-4 hover:underline">
              Also notify me outside this tab
            </button>
          )}
          <p className="mt-3 text-[11px] text-pretty text-faint-foreground">Kept encrypted on this device and checked against the public token list. The server never sees it. Works for tokens the pool trades, while a tab is open.</p>
        </div>
      )}
    </div>
  );
}
