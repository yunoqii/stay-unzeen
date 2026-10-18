"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import type { TokenListItem } from "@/lib/api/types";
import { onAnnounce } from "@/lib/activity";
import { useKeyState } from "@/lib/crypto/session";
import { formatCompact, formatPrice } from "@/lib/format";
import { chime, diffEvents, dueAlerts, eventText, snapshotOf, systemNotify } from "@/lib/notify";
import { useScenarioStore } from "@/lib/scenarios/store";
import { alertsFired, useWorkspace } from "@/lib/workspace/store";
import { usePortfolio } from "@/hooks/use-portfolio";
import type { Network } from "@/lib/network";

/** Public token list for alerts: every unlocked tab asks it on this rhythm, alerts or not. */
const ALERT_POLL_MS = 60_000;

/**
 * Notifications for the unlocked key, from data already on this device: the portfolio poll (orders and scenario
 * steps that moved) and the public token list (price alerts). Toast + optional chime; price alerts also as a
 * system notification when the browser allows it.
 */
export function TradingWatchers() {
  const key = useKeyState();
  const ws = useWorkspace();
  const scenarios = useScenarioStore();
  const { portfolio } = usePortfolio();
  const prefs = ws.file.prefs;
  const prefsRef = useRef(prefs);
  const names = useRef<{ symbols: Map<string, string>; plans: Record<string, { name: string }> }>({ symbols: new Map(), plans: {} });
  useEffect(() => {
    prefsRef.current = prefs;
    names.current.plans = scenarios.file.signed;
  });

  // The chime with the settled-trade toasts of lib/activity.
  useEffect(() => {
    onAnnounce((ok) => prefsRef.current.sound && prefsRef.current.toasts && chime(!ok));
    return () => onAnnounce(null);
  }, []);

  // Orders and scenario steps that moved since the last poll.
  const snap = useRef<{ id: string; s: ReturnType<typeof snapshotOf> } | null>(null);
  const keyId = key.status === "unlocked" ? `${key.network}:${key.pubkey}` : null;
  useEffect(() => {
    if (!keyId || !portfolio) return;
    const prev = snap.current?.id === keyId ? snap.current.s : null;
    const events = diffEvents(prev, portfolio);
    snap.current = { id: keyId, s: snapshotOf(portfolio) };
    if (!prefsRef.current.toasts) return;
    for (const e of events) {
      const t = eventText(e, (m) => names.current.symbols.get(m), (id) => names.current.plans[id]?.name);
      if (t.bad) toast.error(t.title, { description: t.body });
      else toast.success(t.title, { description: t.body });
    }
    if (events.length && prefsRef.current.sound) chime(events.every((e) => "status" in e && (e.status === "failed" || e.status === "expired")));
  }, [portfolio, keyId]);

  // Price alerts against the public list (fixed rhythm while unlocked).
  const alertsRef = useRef(ws.file.alerts);
  useEffect(() => {
    alertsRef.current = ws.file.alerts;
  });
  useEffect(() => {
    if (!keyId) return;
    const [network, pubkey] = keyId.split(":") as [Network, string];
    let alive = true;
    const check = async () => {
      let list: TokenListItem[];
      try {
        list = await api.getTokens();
      } catch {
        return;
      }
      if (!alive) return;
      for (const t of list) names.current.symbols.set(t.mint, t.symbol);
      const due = dueAlerts(alertsRef.current, list);
      if (due.length === 0) return;
      await alertsFired(network, pubkey, due.map((a) => a.id));
      for (const a of due) {
        const t = list.find((x) => x.mint === a.mint);
        const now = a.metric === "price" ? `${formatPrice(Number(t?.priceSol))} SOL` : `${formatCompact(Number(t?.marketCapSol))} SOL`;
        const title = `$${a.symbol} ${a.metric === "price" ? "price" : "market cap"} ${a.dir === "above" ? "above" : "below"} your alert`;
        toast(title, { description: `Now ${now}. The alert is spent; re-arm it on the token page.` });
        systemNotify(title, `Now ${now}.`);
      }
      if (prefsRef.current.sound) chime();
    };
    void check();
    const id = setInterval(() => void check(), ALERT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [keyId]);

  return null;
}
