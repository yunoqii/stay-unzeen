// What the user asked the trade panel to do from elsewhere on the token page: a hotkey, or "Sell 50 %" on the
// position panel. One pending intent per mint; the panel switches side and the matching form takes it once.

export type IntentSide = "buy" | "sell";
export type TradeIntent =
  | { mint: string; side: IntentSide; kind: "side" }
  | { mint: string; side: IntentSide; kind: "slot"; slot: 1 | 2 | 3 | 4 }
  | { mint: string; side: IntentSide; kind: "percent"; pct: number }
  | { mint: string; side: IntentSide; kind: "clear" };

let pending: (TradeIntent & { seq: number }) | null = null;
let seq = 0;
const listeners = new Set<() => void>();

export function requestTrade(i: TradeIntent) {
  pending = { ...i, seq: ++seq };
  listeners.forEach((l) => l());
}

/** The pending intent for this mint and side, removed once read (a form applies it exactly once). */
export function takeIntent(mint: string, side: IntentSide): TradeIntent | null {
  if (!pending || pending.mint !== mint || pending.side !== side) return null;
  const i = pending;
  pending = null;
  return i;
}

export function peekIntent(mint: string): (TradeIntent & { seq: number }) | null {
  return pending && pending.mint === mint ? pending : null;
}

export function onIntent(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** Sell slots of hotkeys 1–4. */
export const SELL_SLOTS = [25, 50, 75, 100] as const;

/** Keyboard map of the token page (docs and the "?" sheet read it from here). */
export const HOTKEYS: { keys: string; does: string }[] = [
  { keys: "B", does: "Buy tab" },
  { keys: "S", does: "Sell tab" },
  { keys: "1 · 2 · 3", does: "Buy: your presets · Sell: 25 · 50 · 75 %" },
  { keys: "4", does: "Buy: max balance · Sell: 100 %" },
  { keys: "Enter", does: "Sign (in the amount field)" },
  { keys: "Esc", does: "Clear the amount, close this sheet" },
  { keys: "?", does: "Show these keys" },
];

/** True when a keystroke belongs to a text field and must not trigger a hotkey. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
}

/** Hotkey -> intent for the side currently shown, or null (not ours). Pure, tested. */
export function hotkeyIntent(key: string, mint: string, side: IntentSide | "orders"): TradeIntent | "help" | null {
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (k === "b") return { mint, side: "buy", kind: "side" };
  if (k === "s") return { mint, side: "sell", kind: "side" };
  if (k === "?") return "help";
  if (side === "orders") return null;
  if (k === "Escape") return { mint, side, kind: "clear" };
  if (k === "1" || k === "2" || k === "3" || k === "4") return { mint, side, kind: "slot", slot: Number(k) as 1 | 2 | 3 | 4 };
  return null;
}
