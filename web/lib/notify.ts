// Notifications from data this browser already has: the fixed-rhythm portfolio poll (orders, scenario steps)
// and the public token list (price alerts). Nothing extra is asked of the server, nothing is reported to it.
// Settled trades of this tab are already toasted by lib/activity; this adds orders and scenario steps, the
// chime and price alerts.

import type { Order, Portfolio, Scenario, TokenListItem } from "@/lib/api/types";
import type { PriceAlert } from "@/lib/workspace/store";

export type TradeEvent =
  | { kind: "order"; id: string; mint: string; orderKind: Order["kind"]; status: "triggered" | "filled" | "failed"; leg?: "tp" | "sl" }
  | { kind: "step"; scenario: string; step: number; status: "done" | "failed" }
  | { kind: "plan"; scenario: string; status: "done" | "failed" | "expired" };

interface Snapshot {
  orders: Map<string, Order["status"]>;
  steps: Map<string, string>;
  plans: Map<string, Scenario["status"]>;
}

export function snapshotOf(p: Pick<Portfolio, "orders" | "scenarios"> | null): Snapshot {
  const s: Snapshot = { orders: new Map(), steps: new Map(), plans: new Map() };
  for (const o of p?.orders ?? []) s.orders.set(o.id, o.status);
  for (const sc of p?.scenarios ?? []) {
    s.plans.set(sc.id, sc.status);
    for (const st of sc.steps ?? []) s.steps.set(`${sc.id}:${st.id}`, st.status);
  }
  return s;
}

/**
 * What changed between two polls that deserves a word: an order fired / filled / failed, a scenario step done
 * or failed, a plan finished. Things first seen already settled (reload, another device) are not announced.
 */
export function diffEvents(prev: Snapshot | null, next: Pick<Portfolio, "orders" | "scenarios">): TradeEvent[] {
  if (!prev) return [];
  const out: TradeEvent[] = [];
  for (const o of next.orders ?? []) {
    const was = prev.orders.get(o.id);
    if (!was || was === o.status) continue;
    if (o.status === "triggered" || o.status === "filled" || (o.status === "failed" && was !== "failed"))
      out.push({ kind: "order", id: o.id, mint: o.mint, orderKind: o.kind, status: o.status, ...(o.leg ? { leg: o.leg } : {}) });
  }
  for (const sc of next.scenarios ?? []) {
    for (const st of sc.steps ?? []) {
      const was = prev.steps.get(`${sc.id}:${st.id}`);
      if (was && was !== st.status && (st.status === "done" || st.status === "failed")) out.push({ kind: "step", scenario: sc.id, step: st.id, status: st.status });
    }
    const was = prev.plans.get(sc.id);
    if (was && was !== sc.status && (sc.status === "done" || sc.status === "failed" || sc.status === "expired")) out.push({ kind: "plan", scenario: sc.id, status: sc.status });
  }
  return out;
}

const ORDER_WORD: Record<Order["kind"], string> = { limit_buy: "Limit buy", limit_sell: "Limit sell", take_profit: "Take profit", stop_loss: "Stop-loss", bracket: "Bracket" };

export function eventText(e: TradeEvent, symbolOf: (mint: string) => string | undefined, planName: (id: string) => string | undefined): { title: string; body: string; bad: boolean } {
  if (e.kind === "order") {
    const sym = symbolOf(e.mint);
    const what = `${ORDER_WORD[e.orderKind]}${e.leg ? ` (${e.leg.toUpperCase()} leg)` : ""}${sym ? ` $${sym}` : ""}`;
    if (e.status === "triggered") return { title: `${what} triggered`, body: "It goes out in the next batch.", bad: false };
    if (e.status === "filled") return { title: `${what} filled`, body: "Your balance is updated.", bad: false };
    return { title: `${what} failed`, body: "The hold went back to your balance.", bad: true };
  }
  const name = planName(e.scenario) ?? "Your scenario";
  if (e.kind === "step") return e.status === "done" ? { title: `${name}: step ${e.step + 1} done`, body: "The plan moves on.", bad: false } : { title: `${name}: step ${e.step + 1} failed`, body: "Its “if it fails” rule applies.", bad: true };
  return e.status === "done" ? { title: `${name} finished`, body: "Every step ran.", bad: false } : { title: `${name} ${e.status}`, body: "Open My scenarios for details.", bad: true };
}

// ---- price alerts ----

/** Alerts whose condition holds on this list (fired ones are skipped). Pure, tested. */
export function dueAlerts(alerts: readonly PriceAlert[], list: readonly Pick<TokenListItem, "mint" | "priceSol" | "marketCapSol">[]): PriceAlert[] {
  const by = new Map(list.map((t) => [t.mint, t]));
  return alerts.filter((a) => {
    if (a.firedAt) return false;
    const t = by.get(a.mint);
    if (!t) return false;
    const v = Number(a.metric === "price" ? t.priceSol : t.marketCapSol);
    if (!Number.isFinite(v) || v <= 0) return false;
    return a.dir === "above" ? v >= a.thresholdSol : v <= a.thresholdSol;
  });
}

// ---- chime and browser notifications ----

let ctx: AudioContext | null = null;
/** Two short soft tones, generated here (no audio file, no request). Silently nothing if audio is blocked. */
export function chime(bad = false) {
  try {
    const AC = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
    if (!AC) return;
    ctx ??= new AC();
    const t0 = ctx.currentTime;
    const notes = bad ? [520, 390] : [660, 880];
    notes.forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + i * 0.12);
      g.gain.linearRampToValueAtTime(0.06, t0 + i * 0.12 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.18);
      o.connect(g).connect(ctx!.destination);
      o.start(t0 + i * 0.12);
      o.stop(t0 + i * 0.12 + 0.2);
    });
  } catch {
    /* no audio */
  }
}

export const notificationsSupported = () => typeof window !== "undefined" && "Notification" in window;
export const notificationsAllowed = () => notificationsSupported() && Notification.permission === "granted";

/** Ask once, on a click. Returns the permission now in force. */
export async function askNotifications(): Promise<NotificationPermission | "unsupported"> {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

/** A system notification, only with permission. The text stays generic enough for a lock screen. */
export function systemNotify(title: string, body: string) {
  if (!notificationsAllowed()) return;
  try {
    new Notification(title, { body, tag: "unzeen", silent: true });
  } catch {
    /* some browsers only allow it from a service worker */
  }
}
