import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatPage } from "@/lib/api/types";
import { applyChatPage, chatList, EMPTY_CHAT } from "./feed";
import { ownAmounts, slowByDefault, SLOW_WINDOW_MS } from "./slow";

const msg = (id: string, seq: number, ts: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, mint: "M", nick: "abcdefgh", isCreator: false, text: `t${id}`, ts, seq: String(seq), ...extra });
const page = (messages: ChatMessage[], cursor: number, extra: Partial<ChatPage> = {}): ChatPage => ({ messages, removed: [], cursor: String(cursor), more: false, ...extra });

describe("chat feed state", () => {
  it("initial page (newest first) reads oldest first, by batch time then seq", () => {
    const s = applyChatPage(EMPTY_CHAT, page([msg("c", 3, 20), msg("b", 2, 10), msg("a", 1, 10)], 3), "initial");
    expect(chatList(s).map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(s.cursor).toBe("3");
    expect(s.oldest).toBe("1");
    expect(s.hasOlder).toBe(false);
  });

  it("after: appends, applies tombstones, never moves the cursor back", () => {
    let s = applyChatPage(EMPTY_CHAT, page([msg("a", 1, 10), msg("b", 2, 10)], 2), "initial");
    s = applyChatPage(s, page([msg("c", 3, 20)], 5, { removed: [{ id: "a", reason: "deleted" }, { id: "b", reason: "reports" }, { id: "zz", reason: "deleted" }] }), "after");
    const list = chatList(s);
    expect(list.map((m) => m.id)).toEqual(["b", "c"]);
    expect(list[0]).toMatchObject({ removed: "reports", text: "" });
    expect(s.cursor).toBe("5");
    s = applyChatPage(s, page([], 4), "after");
    expect(s.cursor).toBe("5");
  });

  it("hidden by creator: re-sent with the flag keeps its place and its text", () => {
    let s = applyChatPage(EMPTY_CHAT, page([msg("a", 1, 10), msg("b", 2, 20)], 2), "initial");
    s = applyChatPage(s, page([msg("a", 3, 10, { hiddenByCreator: true })], 3), "after");
    expect(chatList(s).map((m) => [m.id, !!m.hiddenByCreator, m.text])).toEqual([
      ["a", true, "ta"],
      ["b", false, "tb"],
    ]);
    // A tombstone "creator" from an older server also hides a message we already have.
    s = applyChatPage(s, page([], 4, { removed: [{ id: "b", reason: "creator" }] }), "after");
    expect(chatList(s)[1]).toMatchObject({ hiddenByCreator: true, text: "tb" });
  });

  it("before: older messages go on top; a removed message is never resurrected", () => {
    let s = applyChatPage(EMPTY_CHAT, page(Array.from({ length: 50 }, (_, i) => msg(`n${i}`, 100 - i, 1000 - i)), 100), "initial");
    expect(s.hasOlder).toBe(true);
    s = applyChatPage(s, page([], 101, { removed: [{ id: "n49", reason: "operator" }] }), "after");
    s = applyChatPage(s, page([msg("n49", 51, 951), msg("old", 40, 900)], 101, { more: false }), "before");
    const list = chatList(s);
    expect(list[0].id).toBe("old");
    expect(list.find((m) => m.id === "n49")).toMatchObject({ removed: "operator", text: "" });
    expect(s.hasOlder).toBe(false);
    expect(s.cursor).toBe("101");
    expect(s.oldest).toBe("40");
  });

  it("drops malformed messages (bad nick)", () => {
    const s = applyChatPage(EMPTY_CHAT, page([msg("a", 1, 1, { nick: "ANON<b>" }), msg("b", 2, 2)], 2), "initial");
    expect(chatList(s).map((m) => m.id)).toEqual(["b"]);
  });
});

describe("slow mode default (R6)", () => {
  const now = 1_000_000_000;
  it("on after an own action of this mint in the last 10 minutes only", () => {
    expect(slowByDefault([], "M", now)).toBe(false);
    expect(slowByDefault([{ mint: "M", submittedAt: now - 60_000 }], "M", now)).toBe(true);
    expect(slowByDefault([{ mint: "X", submittedAt: now - 60_000 }], "M", now)).toBe(false);
    expect(slowByDefault([{ mint: "M", submittedAt: now - SLOW_WINDOW_MS }], "M", now)).toBe(false);
    expect(slowByDefault([{ mint: "M", submittedAt: now - SLOW_WINDOW_MS + 1 }], "M", now)).toBe(true);
  });

  it("own amounts of the last 24 h for the self-link warning", () => {
    expect(
      ownAmounts(
        [
          { submittedAt: now - 1000, decimals: 6, fill: { tokenAmount: "1200000000000", solAmount: "400000000", zecSpent: "50000000" } },
          { submittedAt: now - 25 * 3_600_000, fill: { zecSpent: "100000000" } },
        ],
        now,
      ),
    ).toEqual([0.5, 0.4, 1_200_000]);
  });
});

describe("nick mint bytes (v0.20 Robinhood Chain)", () => {
  it("an 0x token is 12 zero bytes ‖ its address", async () => {
    const { mintBytes32 } = await import("@/lib/api/mock-chat");
    const b = mintBytes32("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(b.length).toBe(32);
    expect([...b.slice(0, 12)].every((x) => x === 0)).toBe(true);
    expect(Buffer.from(b.slice(12)).toString("hex")).toBe("5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
  });
});
