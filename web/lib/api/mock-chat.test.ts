// Token chat mock (docs/analysis/chat.md §9, DRAFT): body length, admission, batches on epoch boundaries,
// slow mode, delete / hide / report, HMAC nicknames. Time is injected, no timers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base58 } from "@scure/base";
import { signRequest, signerFromSecret } from "@/lib/crypto/sign";
import { BodyTooLong, padExact, PAD_MIN } from "@/lib/pad";
import { CHAT_MAX_CHARS } from "@/lib/chat/text";
import type { Network } from "@/lib/network";
import { ApiError } from "./errors";
import { chatNick, createChatMock, crockford32, MOCK_CHAT_EPOCH_MS, MOCK_SLOW_MS, type ChatHost } from "./mock-chat";
import { handle, mockPool } from "./mock";
import type { ActionReceipt, ChatPage, SignedAction, Token } from "./types";

const enc = new TextEncoder();
const bytes = (a: SignedAction) => enc.encode(JSON.stringify(padExact(a))).length;
const key = () => signerFromSecret(crypto.getRandomValues(new Uint8Array(32))).pubkey;
const MINT = base58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const T0 = 1_760_000_000_000; // on a boundary

function setup(over: Partial<ChatHost> = {}) {
  const value = new Map<string, bigint>();
  const creators = new Set<string>();
  const host: ChatHost = {
    pool: (n: Network) => mockPool(n),
    accountValueZat: (_n, pk) => value.get(pk) ?? BigInt(10_000_000),
    frozen: () => false,
    isCreator: (_n, pk, mint) => creators.has(`${pk}:${mint}`),
    isPublicMint: (m) => m === MINT,
    isUnzeenLaunch: () => false,
    ...over,
  };
  // mulberry32: deterministic, no repeats in practice
  let a = 0x2f6b1d3;
  const random = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const chat = createChatMock(host, { random });
  const post = (pk: string, a: SignedAction, now: number) => chat.submit("devnet", pk, a, bytes(a), now);
  const read = (q: Record<string, string>, now: number) => chat.get("devnet", MINT, new URLSearchParams(q), now);
  return { chat, host, value, creators, post, read };
}

const say = (text: string, extra: Partial<Extract<SignedAction, { op: "chat" }>> = {}): SignedAction => ({ op: "chat", mint: MINT, text, ...extra });

describe("chat body is exactly 1024 bytes (chat.md §5.1, H-2)", () => {
  it("every chat op and noop pads to exactly PAD_MIN", () => {
    const id = "ab".repeat(16);
    const ops: SignedAction[] = [
      say("gm"),
      say("x".repeat(CHAT_MAX_CHARS), { showCreatorBadge: true, slow: true }),
      // 800 JSON bytes of text: the worst case still fits.
      say("€".repeat(266), { showCreatorBadge: true, slow: true }),
      { op: "chat_delete", id },
      { op: "chat_hide", id },
      { op: "chat_report", id, reason: "abuse" },
      { op: "noop" },
    ];
    for (const a of ops) expect(bytes(a), a.op).toBe(PAD_MIN);
  });

  it("refuses to spill into a bigger bucket", () => {
    expect(() => padExact(say("x".repeat(1000)))).toThrow(BodyTooLong);
  });

  it("the server side rejects any other length", () => {
    const { chat } = setup();
    const pk = key();
    expect(() => chat.submit("devnet", pk, say("gm"), 1023, T0)).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => chat.submit("devnet", pk, say("gm"), 1280, T0)).toThrow(expect.objectContaining({ code: "bad_request" }));
  });
});

describe("nicknames (chat.md §2)", () => {
  it("crockford base32, lower case, MSB first", () => {
    expect(crockford32(Uint8Array.of(0, 0, 0, 0, 0), 8)).toBe("00000000");
    expect(crockford32(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff), 8)).toBe("zzzzzzzz");
    expect(crockford32(Uint8Array.of(0x08, 0x86), 3)).toBe("123");
  });

  it("differ per mint, per creator flag and per K_chat; stable otherwise", () => {
    const pk = key();
    const k1 = new Uint8Array(32).fill(1);
    const k2 = new Uint8Array(32).fill(2);
    const other = base58.encode(new Uint8Array(32).fill(7));
    const a = chatNick(k1, "0202", MINT, pk, false);
    expect(a).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
    expect(chatNick(k1, "0202", MINT, pk, false)).toBe(a);
    expect(chatNick(k1, "0202", other, pk, false)).not.toBe(a);
    expect(chatNick(k1, "0202", MINT, pk, true)).not.toBe(a);
    expect(chatNick(k2, "0202", MINT, pk, false)).not.toBe(a);
    expect(chatNick(k1, "0101", MINT, pk, false)).not.toBe(a);
  });
});

describe("posting", () => {
  it("queues, returns the nick, and publishes only on the next epoch boundary", () => {
    const { post, read } = setup();
    const pk = key();
    const now = T0 + 3_000;
    const r = post(pk, say("gm"), now);
    expect(r).toMatchObject({ status: "queued" });
    expect(r.nick).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
    expect(read({}, now + 1_000).messages).toHaveLength(0);
    const page = read({}, T0 + MOCK_CHAT_EPOCH_MS);
    expect(page.messages).toHaveLength(1);
    // ts is the boundary, never the receive time.
    expect(page.messages[0]).toMatchObject({ id: r.id, nick: r.nick, isCreator: false, text: "gm", ts: T0 + MOCK_CHAT_EPOCH_MS });
    expect(JSON.stringify(page)).not.toContain(pk);
  });

  it("one batch shares one ts; seq order inside it is random, not arrival order", () => {
    const { post, read } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(post(key(), say(`m${i}`), T0 + 100 + i * 100).id);
    const page = read({ after: "0" }, T0 + MOCK_CHAT_EPOCH_MS);
    expect(new Set(page.messages.map((m) => m.ts))).toEqual(new Set([T0 + MOCK_CHAT_EPOCH_MS]));
    const bySeq = [...page.messages].sort((a, b) => Number(a.seq) - Number(b.seq)).map((m) => m.id);
    expect(bySeq).not.toEqual(ids);
    expect(new Set(bySeq)).toEqual(new Set(ids));
  });

  it("slow mode publishes 30-60 s (mock) later, with no public marker", () => {
    const { post, read } = setup();
    const r = post(key(), say("later", { slow: true }), T0 + 1_000);
    expect(read({}, T0 + MOCK_CHAT_EPOCH_MS).messages).toHaveLength(0);
    const page = read({}, T0 + MOCK_SLOW_MS[1] + 2 * MOCK_CHAT_EPOCH_MS);
    expect(page.messages.map((m) => m.id)).toEqual([r.id]);
    expect(page.messages[0].ts % MOCK_CHAT_EPOCH_MS).toBe(0);
    expect(page.messages[0].ts).toBeGreaterThanOrEqual(T0 + MOCK_SLOW_MS[0]);
    expect(Object.keys(page.messages[0])).not.toContain("slow");
  });

  it("rejects invalid text, unknown mints, frozen and ineligible accounts without amounts", () => {
    const { post, value } = setup();
    const pk = key();
    expect(() => post(pk, say(" gm"), T0)).toThrow(expect.objectContaining({ code: "chat_text_invalid" }));
    expect(() => post(pk, say("a‮b"), T0)).toThrow(expect.objectContaining({ code: "chat_text_invalid" }));
    expect(() => post(pk, { op: "chat", mint: base58.encode(new Uint8Array(32).fill(9)), text: "gm" }, T0)).toThrow(expect.objectContaining({ code: "not_found" }));
    value.set(pk, BigInt(99_999));
    try {
      post(pk, say("gm"), T0);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("chat_not_eligible");
      expect((e as ApiError).status).toBe(403);
      expect(`${(e as ApiError).message} ${JSON.stringify((e as ApiError).details ?? null)}`).not.toMatch(/\d{3,}/);
    }
  });

  it("rate limit: one per 10 s per key", () => {
    const { post } = setup();
    const pk = key();
    post(pk, say("one"), T0);
    expect(() => post(pk, say("two"), T0 + 5_000)).toThrow(expect.objectContaining({ code: "rate_limited" }));
    expect(post(pk, say("two"), T0 + 10_000).status).toBe("queued");
  });

  it("creator badge: a separate nickname, only for the creator", () => {
    const { post, read, creators } = setup();
    const pk = key();
    expect(() => post(pk, say("hi", { showCreatorBadge: true }), T0)).toThrow(expect.objectContaining({ code: "not_creator" }));
    creators.add(`${pk}:${MINT}`);
    const plain = post(pk, say("plain"), T0);
    const badge = post(pk, say("as creator", { showCreatorBadge: true }), T0 + 10_000);
    expect(badge.nick).not.toBe(plain.nick);
    const msgs = read({ after: "0" }, T0 + 3 * MOCK_CHAT_EPOCH_MS).messages;
    expect(msgs.find((m) => m.id === badge.id)?.isCreator).toBe(true);
    expect(msgs.find((m) => m.id === plain.id)?.isCreator).toBe(false);
  });
});

describe("moderation (chat.md §6.1)", () => {
  function published() {
    const s = setup();
    const author = key();
    const r = s.post(author, say("hello"), T0 + 1);
    const first = s.read({}, T0 + MOCK_CHAT_EPOCH_MS);
    return { ...s, author, id: r.id, cursor: first.cursor };
  }

  it("delete: only the author, applied on the next boundary, then a tombstone", () => {
    const { post, read, author, id, cursor } = published();
    expect(() => post(key(), { op: "chat_delete", id }, T0 + MOCK_CHAT_EPOCH_MS + 1)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(post(author, { op: "chat_delete", id }, T0 + MOCK_CHAT_EPOCH_MS + 1).status).toBe("queued");
    expect(read({}, T0 + MOCK_CHAT_EPOCH_MS + 2).messages).toHaveLength(1);
    const later = read({ after: cursor }, T0 + 2 * MOCK_CHAT_EPOCH_MS);
    expect(later.removed).toEqual([{ id, reason: "deleted" }]);
    expect(read({}, T0 + 2 * MOCK_CHAT_EPOCH_MS).messages).toHaveLength(0);
  });

  it("delete of a still-pending message: it never appears", () => {
    const { post, read } = setup();
    const pk = key();
    const r = post(pk, say("oops", { slow: true }), T0 + 1);
    post(pk, { op: "chat_delete", id: r.id }, T0 + 10_001);
    expect(read({ after: "0" }, T0 + 10 * MOCK_CHAT_EPOCH_MS)).toMatchObject({ messages: [], removed: [] });
  });

  it("hide: only the creator; the text stays so readers can reveal it", () => {
    const { post, read, creators, id, cursor } = published();
    const creator = key();
    expect(() => post(creator, { op: "chat_hide", id }, T0 + MOCK_CHAT_EPOCH_MS + 1)).toThrow(expect.objectContaining({ code: "not_creator" }));
    creators.add(`${creator}:${MINT}`);
    expect(post(creator, { op: "chat_hide", id }, T0 + MOCK_CHAT_EPOCH_MS + 20_000).status).toBe("queued");
    const page = read({ after: cursor }, T0 + 4 * MOCK_CHAT_EPOCH_MS);
    expect(page.messages).toEqual([expect.objectContaining({ id, text: "hello", hiddenByCreator: true })]);
    expect(BigInt(page.cursor)).toBeGreaterThan(BigInt(cursor));
  });

  it("reports: 3 distinct reporters hide it on the next boundary; repeats and own reports do nothing", () => {
    const { post, read, author, id, cursor } = published();
    const t = T0 + MOCK_CHAT_EPOCH_MS + 1;
    const a = key();
    const b = key();
    expect(post(a, { op: "chat_report", id, reason: "spam" }, t).status).toBe("executed");
    expect(post(a, { op: "chat_report", id, reason: "spam" }, t + 10_000).status).toBe("executed");
    expect(post(author, { op: "chat_report", id, reason: "spam" }, t)).toMatchObject({ status: "executed" });
    expect(post(b, { op: "chat_report", id, reason: "scam" }, t)).toMatchObject({ status: "executed" });
    expect(read({ after: cursor }, T0 + 5 * MOCK_CHAT_EPOCH_MS).removed).toEqual([]);
    post(key(), { op: "chat_report", id, reason: "abuse" }, T0 + 5 * MOCK_CHAT_EPOCH_MS + 1);
    const page = read({ after: cursor }, T0 + 6 * MOCK_CHAT_EPOCH_MS);
    expect(page.removed).toEqual([{ id, reason: "reports" }]);
  });

  it("report needs admission and a known reason", () => {
    const { post, value, id } = published();
    const pk = key();
    expect(() => post(pk, { op: "chat_report", id, reason: "meh" as "spam" }, T0 + 20_000)).toThrow(expect.objectContaining({ code: "bad_request" }));
    value.set(pk, BigInt(0));
    expect(() => post(pk, { op: "chat_report", id, reason: "spam" }, T0 + 20_000)).toThrow(expect.objectContaining({ code: "chat_not_eligible" }));
  });
});

describe("reading", () => {
  it("unknown public mint -> empty page, bad mint -> 400, cursors page back", () => {
    const { chat, post, read } = setup();
    expect(chat.get("devnet", base58.encode(new Uint8Array(32).fill(5)), new URLSearchParams(), T0)).toEqual({ messages: [], removed: [], cursor: "0", more: false });
    expect(() => chat.get("devnet", "nope", new URLSearchParams(), T0)).toThrow(expect.objectContaining({ code: "bad_request" }));
    for (let i = 0; i < 5; i++) post(key(), say(`m${i}`), T0 + i);
    const last2 = read({ limit: "2" }, T0 + MOCK_CHAT_EPOCH_MS);
    expect(last2.messages).toHaveLength(2);
    expect(last2.more).toBe(true);
    const older = read({ before: last2.messages[1].seq, limit: "10" }, T0 + MOCK_CHAT_EPOCH_MS);
    expect(older.messages).toHaveLength(3);
    expect(older.more).toBe(false);
  });
});

describe("through the mock router", () => {
  beforeEach(() => vi.useFakeTimers({ now: T0 }));
  afterEach(() => vi.useRealTimers());

  async function call<T>(body: unknown, sk: Uint8Array): Promise<T> {
    const b = JSON.stringify(body);
    const signer = signerFromSecret(sk);
    const p = handle("devnet", "POST", "/api/actions", b, signRequest(signer, { chainId: "0202", method: "POST", pathWithQuery: "/api/actions", body: b }));
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);
    return (await p) as T;
  }

  it("noop: 1024 bytes accepted, anything else 400; nothing lands in the portfolio", async () => {
    const sk = crypto.getRandomValues(new Uint8Array(32));
    await expect(call<ActionReceipt>(padExact({ op: "noop" }), sk)).resolves.toMatchObject({ status: "queued" });
    await expect(call({ op: "noop" }, sk)).rejects.toMatchObject({ code: "bad_request" });
  });

  it("chat: PoolInfo carries the params and a short body is refused", async () => {
    const pool = mockPool("devnet");
    expect(pool.features?.chat).toBe(true);
    expect(pool.chat?.bodyBytes).toBe(1024);
    const tokens = (await (async () => {
      const p = handle("devnet", "GET", "/api/tokens", undefined, {});
      await vi.advanceTimersByTimeAsync(500);
      return p;
    })()) as Token[];
    const sk = crypto.getRandomValues(new Uint8Array(32));
    await expect(call({ op: "chat", mint: tokens[0].mint, text: "gm" }, sk)).rejects.toMatchObject({ code: "bad_request" });
    const page = handle("devnet", "GET", `/api/tokens/${tokens[0].mint}/chat?limit=50`, undefined, {});
    await vi.advanceTimersByTimeAsync(500);
    expect(((await page) as ChatPage).cursor).toMatch(/^\d+$/);
  });
});
