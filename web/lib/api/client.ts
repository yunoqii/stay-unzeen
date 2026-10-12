// Single entry point for backend access. Components import `api` only from here.
// NEXT_PUBLIC_API_MODE=mock (default) | real
// Per network (lib/network.ts): NEXT_PUBLIC_API_URL_DEVNET / _MAINNET, NEXT_PUBLIC_WS_URL_DEVNET / _MAINNET.
// Every call resolves the network at call time, so switching Devnet <-> Mainnet needs no reload.

import { signRequest, type SignedHeaders, type Signer } from "@/lib/crypto/sign";
import { networkConfig } from "@/lib/network";
import { ApiError, errorFromResponse } from "./errors";
import * as mock from "./mock";
import type {
  ActionAccepted,
  ActionStatusResponse,
  Candle,
  CandleTimeframe,
  CreatorToken,
  FeedEvent,
  IntentRequest,
  IntentStatusResponse,
  Order,
  PaymentRequest,
  PlatformStats,
  Portfolio,
  SignedAction,
  Token,
  TokenWithTrades,
} from "./types";

export { ApiError, errorText } from "./errors";

export type ApiMode = "mock" | "real";
export type FeedStatus = "connecting" | "live" | "offline";

export const API_MODE: ApiMode = process.env.NEXT_PUBLIC_API_MODE === "real" ? "real" : "mock";

function wsBase(): string {
  const { wsUrl, apiUrl } = networkConfig();
  if (wsUrl) return wsUrl;
  if (apiUrl) return apiUrl.replace(/^http/, "ws");
  if (typeof window === "undefined") return "";
  return (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

const enc = encodeURIComponent;

export interface TradesQuery {
  before?: string;
  limit?: number; // <= 200
}

export interface CandlesQuery {
  tf?: CandleTimeframe; // default 5m
  from?: number; // unix seconds
  to?: number; // unix seconds
}

export interface FeedSubscription {
  /** Only events for this mint (WS /ws/feed?mint=). */
  mint?: string;
}

/** Everything the UI can ask of the backend. Signed calls take a Signer from lib/crypto/session. */
export interface Api {
  getFeed(limit?: number): Promise<FeedEvent[]>;
  getTokens(): Promise<Token[]>;
  /** null when the backend does not track this mint (404 not_found). */
  getToken(mint: string): Promise<TokenWithTrades | null>;
  getTrades(mint: string, q?: TradesQuery): Promise<FeedEvent[]>;
  getCandles(mint: string, q?: CandlesQuery): Promise<Candle[]>;
  createIntent(body: IntentRequest): Promise<PaymentRequest>;
  getIntent(id: string): Promise<IntentStatusResponse>;
  createDeposit(anonPubkey: string): Promise<PaymentRequest>;
  getPortfolio(signer: Signer): Promise<Portfolio>;
  postAction(signer: Signer, action: SignedAction): Promise<ActionAccepted>;
  getAction(id: string): Promise<ActionStatusResponse>;
  getOrders(signer: Signer): Promise<Order[]>;
  getCreator(signer: Signer): Promise<CreatorToken[]>;
  getStats(): Promise<PlatformStats>;
  subscribeFeed(onEvent: (e: FeedEvent) => void, onStatus?: (s: FeedStatus) => void, opts?: FeedSubscription): () => void;
}

// ---- transport shared by real and mock: identical signing and error handling ----

interface Call {
  method: "GET" | "POST";
  path: string; // path + query, exactly as signed and sent
  body?: unknown;
  signer?: Signer;
}

function prepare(call: Call): { body: string | undefined; headers: Record<string, string> } {
  // Serialize once: the signed bytes must be exactly the bytes on the wire.
  const body = call.body === undefined ? undefined : JSON.stringify(call.body);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (call.signer) Object.assign(headers, signRequest(call.signer, { method: call.method, pathWithQuery: call.path, body }));
  return { body, headers };
}

async function httpCall<T>(call: Call): Promise<T> {
  const { body, headers } = prepare(call);
  let res: Response;
  try {
    res = await fetch(networkConfig().apiUrl + call.path, {
      method: call.method,
      body,
      headers,
      // No cookies, no referrer: the backend must not learn more than the request itself.
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
  } catch {
    throw new ApiError("network", `${call.method} ${call.path}: network error`);
  }
  if (!res.ok) throw await errorFromResponse(res, `${call.method} ${call.path}`);
  return (await res.json()) as T;
}

async function mockCall<T>(call: Call): Promise<T> {
  const { body, headers } = prepare(call);
  return mock.handle(call.method, call.path, body, headers as Partial<SignedHeaders>) as Promise<T>;
}

function makeApi(send: <T>(call: Call) => Promise<T>, subscribeFeed: Api["subscribeFeed"]): Api {
  const get = <T>(path: string, signer?: Signer) => send<T>({ method: "GET", path, signer });
  const post = <T>(path: string, body: unknown, signer?: Signer) => send<T>({ method: "POST", path, body, signer });

  return {
    getFeed: (limit = 50) => get(`/api/feed${qs({ limit })}`),
    getTokens: () => get("/api/tokens"),
    getToken: async (mint) => {
      try {
        return await get<TokenWithTrades>(`/api/tokens/${enc(mint)}`);
      } catch (e) {
        if (e instanceof ApiError && e.code === "not_found") return null;
        throw e;
      }
    },
    getTrades: (mint, q = {}) => get(`/api/tokens/${enc(mint)}/trades${qs({ before: q.before, limit: q.limit })}`),
    getCandles: (mint, q = {}) => get(`/api/tokens/${enc(mint)}/candles${qs({ tf: q.tf, from: q.from, to: q.to })}`),
    createIntent: (body) => post("/api/intents", body),
    getIntent: (id) => get(`/api/intents/${enc(id)}`),
    createDeposit: (anonPubkey) => post("/api/deposit", { anonPubkey }),
    // Deviation from docs/API.md v0.1 (`/api/portfolio/:anonPubkey`), per analyst review H9: the anon
    // pubkey never goes into a URL path or query (hosting access logs = IP <-> key). Header only.
    getPortfolio: (signer) => get("/api/portfolio", signer),
    postAction: (signer, action) => post("/api/actions", action, signer),
    getAction: (id) => get(`/api/actions/${enc(id)}`),
    getOrders: (signer) => get("/api/orders", signer),
    getCreator: (signer) => get("/api/creator", signer),
    getStats: () => get("/api/stats"),
    subscribeFeed,
  };
}

function wsSubscribe(
  onEvent: (e: FeedEvent) => void,
  onStatus?: (s: FeedStatus) => void,
  opts: FeedSubscription = {},
): () => void {
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;
  const url = wsBase() + "/ws/feed" + qs({ mint: opts.mint });

  const connect = () => {
    onStatus?.("connecting");
    ws = new WebSocket(url);
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
}

const real = makeApi(httpCall, wsSubscribe);

const mocked = makeApi(mockCall, (onEvent, onStatus, opts) => {
  onStatus?.("live");
  return mock.subscribeFeed(onEvent, opts?.mint);
});

export const api: Api = API_MODE === "real" ? real : mocked;
