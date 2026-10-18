import { describe, expect, it } from "vitest";
import { hotkeyIntent, isTyping, requestTrade, takeIntent } from "./trade-intent";

describe("hotkeys", () => {
  it("maps B / S / 1–4 / Esc / ?", () => {
    expect(hotkeyIntent("b", "M", "sell")).toEqual({ mint: "M", side: "buy", kind: "side" });
    expect(hotkeyIntent("S", "M", "buy")).toEqual({ mint: "M", side: "sell", kind: "side" });
    expect(hotkeyIntent("2", "M", "buy")).toEqual({ mint: "M", side: "buy", kind: "slot", slot: 2 });
    expect(hotkeyIntent("4", "M", "sell")).toEqual({ mint: "M", side: "sell", kind: "slot", slot: 4 });
    expect(hotkeyIntent("Escape", "M", "buy")).toEqual({ mint: "M", side: "buy", kind: "clear" });
    expect(hotkeyIntent("?", "M", "orders")).toBe("help");
    expect(hotkeyIntent("1", "M", "orders")).toBeNull(); // presets do nothing on the orders tab
    expect(hotkeyIntent("x", "M", "buy")).toBeNull();
  });
  it("never fires while typing", () => {
    expect(isTyping({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isTyping({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
    expect(isTyping({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTyping({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
  });
  it("an intent is taken once, by the matching mint and side", () => {
    requestTrade({ mint: "M", side: "sell", kind: "percent", pct: 50 });
    expect(takeIntent("M", "buy")).toBeNull();
    expect(takeIntent("X", "sell")).toBeNull();
    expect(takeIntent("M", "sell")).toEqual({ mint: "M", side: "sell", kind: "percent", pct: 50, seq: expect.any(Number) });
    expect(takeIntent("M", "sell")).toBeNull();
  });
});
