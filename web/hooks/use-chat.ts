"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "@/lib/api/client";
import { applyChatPage, CHAT_PAGE, chatList, EMPTY_CHAT, type ChatItem, type ChatState } from "@/lib/chat/feed";
import { useNetwork } from "@/lib/network";

/**
 * Token chat by polling (chat.md §5.3, R4): first the last 50, then `after=<cursor>` every 10-15 s with
 * jitter for as long as the token page is open, whichever tab is shown. The rhythm never speeds up,
 * pauses or restarts because of your own message (the lesson of now-mode N-2): a poll right after a
 * post would tell a network observer which POST was a chat message.
 */
export const CHAT_POLL_MIN_MS = 10_000;
export const CHAT_POLL_JITTER_MS = 5_000;
const MAX_CATCH_UP = 5;

export interface ChatFeed {
  status: "loading" | "ready" | "error";
  error: string | null;
  items: ChatItem[];
  state: ChatState;
  /** Last successful poll. */
  updatedAt: number | null;
  /** Cursor right after the first page: what counts as "already there" for unread badges. */
  initialCursor: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
}

interface Snap {
  id: string;
  chat: ChatState;
  status: ChatFeed["status"];
  error: string | null;
  initialCursor: string | null;
  at: number | null;
}

export function useChat(mint: string, enabled: boolean): ChatFeed {
  const network = useNetwork();
  const id = `${network}:${mint}`;
  const [snap, setSnap] = useState<Snap | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const ref = useRef<Snap | null>(null);

  const commit = useCallback((next: Snap) => {
    ref.current = next;
    setSnap(next);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    ref.current = { id, chat: EMPTY_CHAT, status: "loading", error: null, initialCursor: null, at: null };

    const poll = async () => {
      const cur = ref.current!;
      try {
        if (cur.chat.cursor === null) {
          const page = await api.getChat(mint, { limit: CHAT_PAGE });
          if (!alive) return;
          const chat = applyChatPage(ref.current!.chat, page, "initial");
          commit({ id, chat, status: "ready", error: null, initialCursor: chat.cursor, at: Date.now() });
        } else {
          for (let i = 0; i < MAX_CATCH_UP; i++) {
            const page = await api.getChat(mint, { after: ref.current!.chat.cursor ?? "0" });
            if (!alive) return;
            commit({ ...ref.current!, chat: applyChatPage(ref.current!.chat, page, "after"), status: "ready", error: null, at: Date.now() });
            if (!page.more) break;
          }
        }
      } catch (e) {
        if (!alive) return;
        const s = ref.current!;
        commit({ ...s, status: s.status === "loading" || s.status === "error" ? "error" : s.status, error: errorText(e) });
      }
    };

    const tick = () => {
      if (document.visibilityState === "visible" || ref.current?.chat.cursor === null) void poll();
      timer = setTimeout(tick, CHAT_POLL_MIN_MS + Math.random() * CHAT_POLL_JITTER_MS);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, mint, enabled, commit]);

  const loadOlder = useCallback(() => {
    const s = ref.current;
    const before = s?.chat.oldest;
    if (!s || !before || loadingOlder) return;
    setLoadingOlder(true);
    api
      .getChat(mint, { before, limit: CHAT_PAGE })
      .then((page) => {
        const cur = ref.current;
        if (cur && cur.id === s.id) commit({ ...cur, chat: applyChatPage(cur.chat, page, "before") });
      })
      .catch((e: unknown) => {
        const cur = ref.current;
        if (cur) commit({ ...cur, error: errorText(e) });
      })
      .finally(() => setLoadingOlder(false));
  }, [mint, loadingOlder, commit]);

  const view = snap && snap.id === id ? snap : null;
  const state = view?.chat ?? EMPTY_CHAT;
  const items = useMemo(() => chatList(state), [state]);
  return {
    status: view?.status ?? "loading",
    error: view?.error ?? null,
    items,
    state,
    initialCursor: view?.initialCursor ?? null,
    updatedAt: view?.at ?? null,
    hasOlder: state.hasOlder,
    loadingOlder,
    loadOlder,
  };
}
