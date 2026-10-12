"use client";

import { useEffect, useState } from "react";
import { errorText } from "@/lib/api/client";
import { isPending, type PendingResponse } from "@/lib/api/types";
import { useNetwork } from "@/lib/network";

export type PendingState<T> =
  | { state: "loading" }
  | { state: "pending"; retryAt: number }
  | { state: "ready"; data: T }
  | { state: "missing" }
  | { state: "error"; error: string };

/** Never hammer: at least 1 s, at most 90 s between retries, whatever retryAfterMs says. */
export const clampRetry = (ms: number) => Math.min(90_000, Math.max(1_000, Number.isFinite(ms) ? ms : 5_000));

/**
 * Loads a public resource that may answer 202 {status:"pending", retryAfterMs} (cold mint queued for the
 * backend's next tick) and retries exactly when told. `refreshMs` re-polls a ready value quietly.
 */
export function usePending<T>(key: string, load: () => Promise<T | PendingResponse | null>, refreshMs?: number): PendingState<T> {
  const network = useNetwork();
  const [st, setSt] = useState<{ key: string; value: PendingState<T> }>({ key: "", value: { state: "loading" } });

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const id = `${network}:${key}`;
    const run = () => {
      load()
        .then((r) => {
          if (!alive) return;
          if (isPending(r)) {
            const wait = clampRetry(r.retryAfterMs);
            setSt({ key: id, value: { state: "pending", retryAt: Date.now() + wait } });
            timer = setTimeout(run, wait);
          } else if (r === null) {
            setSt({ key: id, value: { state: "missing" } });
          } else {
            setSt({ key: id, value: { state: "ready", data: r } });
            if (refreshMs) timer = setTimeout(run, refreshMs);
          }
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setSt((prev) => (prev.key === id && prev.value.state === "ready" ? prev : { key: id, value: { state: "error", error: errorText(e) } }));
          if (refreshMs) timer = setTimeout(run, refreshMs);
        });
    };
    run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // `load` is expected to change only with `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, network, refreshMs]);

  return st.key === `${network}:${key}` ? st.value : { state: "loading" };
}
