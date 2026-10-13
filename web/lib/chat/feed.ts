// Client-side state of one token chat, built from GET /api/tokens/:mint/chat pages (chat.md §5.3).
// Pure: the hook (hooks/use-chat.ts) owns timing and transport.

import type { ChatMessage, ChatPage, ChatRemovedReason } from "@/lib/api/types";

export const CHAT_PAGE = 50;

/** A message as shown: hidden ones keep their place, removed ones lose their text. */
export type ChatItem = ChatMessage & {
  /** Hidden after reports / by the operator: the text is gone, a placeholder stays where it was. */
  removed?: Exclude<ChatRemovedReason, "deleted">;
};

export interface ChatState {
  byId: ReadonlyMap<string, ChatItem>;
  /** Highest seq seen: the next after=. Null until the first page. */
  cursor: string | null;
  /** Lowest seq seen: the next before=. */
  oldest: string | null;
  hasOlder: boolean;
}

export const EMPTY_CHAT: ChatState = { byId: new Map(), cursor: null, oldest: null, hasOlder: false };

const big = (s: string | null | undefined): bigint | null => (s && /^\d+$/.test(s) ? BigInt(s) : null);
const maxSeq = (a: string | null, b: string | null): string | null => {
  const x = big(a);
  const y = big(b);
  if (x === null) return y === null ? null : b;
  if (y === null) return a;
  return y > x ? b : a;
};
const minSeq = (a: string | null, b: string | null): string | null => {
  const x = big(a);
  const y = big(b);
  if (x === null) return y === null ? null : b;
  if (y === null) return a;
  return y < x ? b : a;
};

export type PageKind = "initial" | "after" | "before";

/** Merge one page. Unknown tombstones are ignored; a later event for the same id wins. */
export function applyChatPage(state: ChatState, page: ChatPage, kind: PageKind): ChatState {
  const byId = new Map(state.byId);
  let oldest = state.oldest;
  for (const m of page.messages) {
    if (!isMessage(m)) continue;
    const prev = byId.get(m.id);
    // A message already removed stays removed; an older page cannot resurrect it.
    if (prev?.removed) continue;
    // A "before" page can carry an older copy of a message the stream already updated.
    if (prev && kind === "before") continue;
    byId.set(m.id, { ...m, text: m.text || prev?.text || "" });
    oldest = minSeq(oldest, m.seq);
  }
  for (const r of page.removed ?? []) {
    const prev = byId.get(r.id);
    if (!prev) continue;
    if (r.reason === "deleted") byId.delete(r.id);
    else if (r.reason === "creator") byId.set(r.id, { ...prev, hiddenByCreator: true });
    else byId.set(r.id, { ...prev, text: "", hiddenByCreator: undefined, removed: r.reason });
  }
  const cursor = kind === "before" ? state.cursor : maxSeq(state.cursor, page.cursor);
  const hasOlder = kind === "after" ? state.hasOlder : page.more || page.messages.length >= CHAT_PAGE;
  return { byId, cursor, oldest, hasOlder };
}

/** Oldest first (a chat reads top to bottom): by the batch time, then by seq inside the batch. */
export function chatList(state: ChatState): ChatItem[] {
  return [...state.byId.values()].sort((a, b) => a.ts - b.ts || cmpSeq(a.seq, b.seq));
}

function cmpSeq(a: string, b: string): number {
  const x = big(a) ?? BigInt(0);
  const y = big(b) ?? BigInt(0);
  return x < y ? -1 : x > y ? 1 : 0;
}

const NICK_RE = /^[0-9a-hjkmnp-tv-z]{8}$/;

/** Shape check of what the server sent (the text itself is rendered as a plain text node anyway). */
function isMessage(m: unknown): m is ChatMessage {
  if (!m || typeof m !== "object") return false;
  const x = m as Partial<ChatMessage>;
  return typeof x.id === "string" && typeof x.nick === "string" && NICK_RE.test(x.nick) && typeof x.text === "string" && typeof x.ts === "number" && typeof x.seq === "string";
}

export const isNick = (s: string): boolean => NICK_RE.test(s);
