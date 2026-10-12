"use client";

import { useEffect, useState } from "react";
import { api, type FeedStatus } from "@/lib/api/client";
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
}

/** GET /api/feed for history, then /ws/feed for new events. */
export function useLiveFeed({ limit = 50, mint, initial }: Options = {}): LiveFeed {
  const [events, setEvents] = useState<FeedEvent[]>(initial ?? []);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const hasInitial = initial !== undefined;

  useEffect(() => {
    let alive = true;
    let unsubscribe = () => {};

    const start = () => {
      unsubscribe = api.subscribeFeed(
        (e) => {
          if (mint && e.mint !== mint) return;
          setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [e, ...prev].slice(0, limit)));
          setFresh((prev) => new Set([e.id, ...Array.from(prev).slice(0, limit * 2)]));
        },
        (s) => alive && setStatus(s),
      );
    };

    if (hasInitial) {
      start();
    } else {
      api
        .getFeed(limit)
        .then((list) => {
          if (!alive) return;
          setEvents(mint ? list.filter((e) => e.mint === mint) : list);
          setLoading(false);
          start();
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setError(e instanceof Error ? e.message : "Feed unavailable");
          setLoading(false);
        });
    }

    return () => {
      alive = false;
      unsubscribe();
    };
  }, [limit, mint, hasInitial]);

  return { events, fresh, status, loading, error };
}
