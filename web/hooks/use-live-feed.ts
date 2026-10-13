"use client";

import { useEffect, useState } from "react";
import { api, errorText, type FeedStatus } from "@/lib/api/client";
import { useNetwork } from "@/lib/network";
import type { FeedEvent } from "@/lib/api/types";

interface Options {
  limit?: number;
  /** Only keep events for this mint. */
  mint?: string;
  /** Skip the initial GET /api/feed and start from these events. */
  initial?: FeedEvent[];
}

export interface LiveFeed {
  events: FeedEvent[];
  /** Ids that arrived over the socket (animate these in). */
  fresh: ReadonlySet<string>;
  status: FeedStatus;
  loading: boolean;
  error: string | null;
  /** Last time the feed was known current (connected or an event arrived); null before that. */
  updatedAt: number | null;
  /** Re-run the initial load after an error. */
  retry: () => void;
}

/** History (GET /api/feed, or /api/tokens/:mint/trades), then /ws/feed[?mint=] for new events. */
export function useLiveFeed({ limit = 50, mint, initial }: Options = {}): LiveFeed {
  const [events, setEvents] = useState<FeedEvent[]>(initial ?? []);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const hasInitial = initial !== undefined;

  const network = useNetwork(); // refetch / resubscribe on Devnet <-> Mainnet
  useEffect(() => {
    let alive = true;
    let unsubscribe = () => {};

    const start = () => {
      unsubscribe = api.subscribeFeed(
        (e) => {
          if (mint && e.mint !== mint) return; // server filters by ?mint=, keep the guard anyway
          setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [e, ...prev].slice(0, limit)));
          setFresh((prev) => new Set([e.id, ...Array.from(prev).slice(0, limit * 2)]));
          setUpdatedAt(Date.now());
        },
        (s) => {
          if (!alive) return;
          setStatus(s);
          if (s === "live") setUpdatedAt(Date.now());
        },
        { mint },
      );
    };

    if (hasInitial) {
      start();
    } else {
      (mint ? api.getTrades(mint, { limit: Math.min(limit, 200) }) : api.getFeed(limit))
        .then((list) => {
          if (!alive) return;
          setEvents(list);
          setLoading(false);
          setError(null);
          setUpdatedAt(Date.now());
          start();
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setError(errorText(e));
          setLoading(false);
        });
    }

    return () => {
      alive = false;
      unsubscribe();
    };
  }, [limit, mint, hasInitial, network, attempt]);

  const retry = () => {
    setLoading(true);
    setError(null);
    setAttempt((a) => a + 1);
  };
  return { events, fresh, status, loading, error, updatedAt, retry };
}
