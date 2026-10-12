// Single entry point for backend access. Components import `api` only from here.
// NEXT_PUBLIC_API_MODE=mock (default) | real
// NEXT_PUBLIC_API_URL  — REST base, e.g. http://localhost:8080 (empty = same origin)
// NEXT_PUBLIC_WS_URL   — WS base, e.g. ws://localhost:8080 (derived from API_URL if empty)

import * as mock from "./mock";
import type {
  FeedEvent,
  IntentRequest,
  IntentStatusResponse,
  PaymentRequest,
  Portfolio,
  Token,
  TokenWithTrades,
} from "./types";

export type ApiMode = "mock" | "real";

export const API_MODE: ApiMode = process.env.NEXT_PUBLIC_API_MODE === "real" ? "real" : "mock";

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

function wsBase(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  if (API_URL) return API_URL.replace(/^http/, "ws");
  if (typeof window === "undefined") return "";
  return (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_URL + path, {
    ...init,
    // No cookies, no referrer: the backend must not learn more than the request itself.
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) throw new ApiError(res.status, `${init?.method ?? "GET"} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

const real = {
  getFeed: (limit = 50) => request<FeedEvent[]>(`/api/feed?limit=${limit}`),
  getTokens: () => request<Token[]>("/api/tokens"),
  getToken: async (mint: string): Promise<TokenWithTrades | null> => {
    try {
      return await request<TokenWithTrades>(`/api/tokens/${encodeURIComponent(mint)}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  createIntent: (body: IntentRequest) =>
    request<PaymentRequest>("/api/intents", { method: "POST", body: JSON.stringify(body) }),
  getIntent: (id: string) => request<IntentStatusResponse>(`/api/intents/${encodeURIComponent(id)}`),
  // Signing scheme for this request is not fixed in docs/API.md yet; caller passes auth headers.
  getPortfolio: (anonPubkey: string, headers?: HeadersInit) =>
    request<Portfolio>(`/api/portfolio/${encodeURIComponent(anonPubkey)}`, { headers }),

  subscribeFeed(onEvent: (e: FeedEvent) => void, onStatus?: (s: FeedStatus) => void): () => void {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let closed = false;

    const connect = () => {
      onStatus?.("connecting");
      ws = new WebSocket(wsBase() + "/ws/feed");
      ws.onopen = () => {
        attempt = 0;
        onStatus?.("live");
      };
      ws.onmessage = (msg) => {
        try {
          onEvent(JSON.parse(msg.data as string) as FeedEvent);
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        onStatus?.("offline");
        const wait = Math.min(15_000, 500 * 2 ** attempt++);
        retry = setTimeout(connect, wait);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  },
};

export type FeedStatus = "connecting" | "live" | "offline";

const mocked: typeof real = {
  getFeed: mock.getFeed,
  getTokens: mock.getTokens,
  getToken: mock.getToken,
  createIntent: mock.createIntent,
  getIntent: mock.getIntent,
  getPortfolio: (anonPubkey: string) => mock.getPortfolio(anonPubkey),
  subscribeFeed(onEvent, onStatus) {
    onStatus?.("live");
    return mock.subscribeFeed(onEvent);
  },
};

export const api = API_MODE === "real" ? real : mocked;
