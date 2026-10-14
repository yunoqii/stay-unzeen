// Single entry point for backend access. Components import `api` only from here.
// NEXT_PUBLIC_API_MODE=mock (default) | real
// Per network (lib/network.ts): NEXT_PUBLIC_API_URL_DEVNET / _MAINNET, NEXT_PUBLIC_WS_URL_DEVNET / _MAINNET.
// Every call resolves the network at call time, so switching Devnet <-> Mainnet needs no reload.

import { signRequest, type SignedHeaders, type Signer } from "@/lib/crypto/sign";
import { networkConfig } from "@/lib/network";
import { trackRequest } from "@/lib/connectivity";
import { EXACT_OPS, padAction, padExact, padScenario } from "@/lib/pad";
import { ApiError, errorFromResponse } from "./errors";
import * as mock from "./mock";
import type {
  ActionReceipt,
  ActionStatus,
  Candle,
  CandleTimeframe,
  ChatPage,
  CreatorCabinet,
  DiscoveryToken,
  FeedEvent,
  PendingResponse,
  PlatformStats,
  PoolInfo,
  Portfolio,
  Rates,
  SignedAction,
  TokenListItem,
  TokenSafety,
  TokenTrade,
  TokenWithTrades,
  TradeFilter,
  Token,
} from "./types";
import { isPending } from "./types";

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

/** Absent `quote` (servers before v0.13) means a SOL pair. */
/**
 * The native pair of the origin is "SOL" inside the UI (the *Sol / *Lamports fields carry the native coin).
 * v0.20: a Robinhood Chain server may name it "ETH"; that is the same native pair.
 */
const withQuote = <T extends { quote?: Token["quote"] }>(t: T): T => (!t.quote || (t.quote as string) === "ETH" ? { ...t, quote: "SOL" } : t);

export interface TradesQuery {
  before?: string;
  limit?: number; // <= 200
}

export interface TokenTradesQuery extends TradesQuery {
  filter?: TradeFilter;
}

export interface CandlesQuery {
  tf?: CandleTimeframe; // default 5m
  from?: number; // unix seconds
  to?: number; // unix seconds
  /** v0.17: 1 = bars in the pair's own units (price in quote per whole token, volume in quote base units). */
  quote?: 0 | 1;
}

/** Chat (API.md v0.12): one of the three, never combined. */
export type ChatQuery = { limit?: number } | { before: string; limit?: number } | { after: string };

export interface FeedSubscription {
  /** Only events for this mint (WS /ws/feed?mint=). */
  mint?: string;
}

/** Everything the UI can ask of the backend. Signed calls take a Signer from lib/crypto/session. */
export interface Api {
  getFeed(limit?: number): Promise<FeedEvent[]>;
  getTokens(): Promise<TokenListItem[]>;
  /**
   * null when the mint does not exist (404 not_found). A cold mint (first CA search) answers 202
   * pending: it is queued for the next fixed tick (token-intel DRAFT).
   */
  getToken(mint: string): Promise<TokenWithTrades | PendingResponse | null>;
  getTrades(mint: string, q?: TradesQuery): Promise<FeedEvent[]>;
  /** DRAFT: all on-chain trades of a mint with tags; filters whales / dev need the full feed flag. */
  getTokenTrades(mint: string, q?: TokenTradesQuery): Promise<TokenTrade[]>;
  /** DRAFT: GET /api/tokens/:mint/safety. 202 pending until the next tick; null on 404. */
  getSafety(mint: string): Promise<TokenSafety | PendingResponse | null>;
  getCandles(mint: string, q?: CandlesQuery): Promise<Candle[]>;
  /** Public pool info: UA, chain id, minimums, K. No pubkey, no cookies. */
  getPool(): Promise<PoolInfo>;
  /** DRAFT v0.18: public display rates (ZEC/SOL/ETH in USD, ZEC/SOL, ZEC/ETH). Same for everyone; display only. */
  getRates(): Promise<Rates>;
  /**
   * v0.21: page 0 of holdings comes with the regular poll; other pages ONLY on an explicit user action
   * ("Show more"), never automatically: the number of requests would tell how many positions a key has.
   */
  getPortfolio(signer: Signer, holdingsPage?: number): Promise<Portfolio>;
  postAction(signer: Signer, action: SignedAction): Promise<ActionReceipt>;
  /** Owner only (header pubkey = action author), otherwise 404. */
  getAction(signer: Signer, id: string): Promise<ActionStatus>;
  getCreator(signer: Signer): Promise<CreatorCabinet>;
  getStats(): Promise<PlatformStats>;
  /** v0.12 (features.discovery): fresh launchpad tokens, public and the same for everyone. */
  getDiscovery(): Promise<DiscoveryToken[]>;
  /** Chat (v0.12): public, unsigned, identical for every reader. */
  getChat(mint: string, q?: ChatQuery): Promise<ChatPage>;
  /**
   * Plain GET for features that bring their own endpoints and load on demand (their paths stay out
   * of the main bundle). Same transport, signing and error mapping as everything else.
   */
  request<T>(path: string, signer?: Signer): Promise<T>;
  subscribeFeed(onEvent: (e: FeedEvent) => void, onStatus?: (s: FeedStatus) => void, opts?: FeedSubscription): () => void;
}

// ---- transport shared by real and mock: identical signing and error handling ----

interface Call {
  method: "GET" | "POST";
  path: string; // path + query, exactly as signed and sent
  body?: unknown;
  signer?: Signer;
  /** Resend the exact same signed bytes this many times after a network failure (idempotent by nonce). */
  retries?: number;
}

function prepare(call: Call): { body: string | undefined; headers: Record<string, string> } {
  // Serialize once: the signed bytes must be exactly the bytes on the wire.
  const body = call.body === undefined ? undefined : JSON.stringify(call.body);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (call.signer) Object.assign(headers, signRequest(call.signer, { chainId: networkConfig().chainIdHex, method: call.method, pathWithQuery: call.path, body }));
  return { body, headers };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function httpCall<T>(call: Call): Promise<T> {
  // Signed once: a retry after a timeout sends the same nonce and body, so the backend answers with
  // the original receipt instead of creating a second action (docs/API.md, POST /api/actions).
  const { body, headers } = prepare(call);
  const url = networkConfig().apiUrl + call.path;
  let res: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, {
        method: call.method,
        body,
        headers,
        // No cookies, no referrer: the backend must not learn more than the request itself.
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      break;
    } catch {
      if (attempt >= (call.retries ?? 0)) throw new ApiError("network", `${call.method} ${call.path}: network error`);
      await sleep(700 * (attempt + 1));
    }
  }
  if (!res.ok) throw await errorFromResponse(res, `${call.method} ${call.path}`);
  return (await res.json()) as T;
}

async function mockCall<T>(call: Call): Promise<T> {
  const { body, headers } = prepare(call);
  return mock.handle(networkConfig().id, call.method, call.path, body, headers as Partial<SignedHeaders>) as Promise<T>;
}

/** Report every call to the connection banner: transport failures and 5xx count, other answers do not. */
function tracked(send: <T>(call: Call) => Promise<T>): <T>(call: Call) => Promise<T> {
  return async <T,>(call: Call) => {
    const done = trackRequest();
    try {
      const r = await send<T>(call);
      done("ok");
      return r;
    } catch (e) {
      done(e instanceof ApiError && (e.code === "network" || e.status >= 500) ? "transport" : "http");
      throw e;
    }
  };
}

function makeApi(rawSend: <T>(call: Call) => Promise<T>, subscribeFeed: Api["subscribeFeed"]): Api {
  const send = tracked(rawSend);
  const get = <T>(path: string, signer?: Signer) => send<T>({ method: "GET", path, signer });
  const post = <T>(path: string, body: unknown, signer?: Signer, retries?: number) =>
    send<T>({ method: "POST", path, body, signer, retries });

  return {
    getFeed: (limit = 50) => get(`/api/feed${qs({ limit })}`),
    // v0.13: a server before non-SOL pairs sends no `quote`; that is a SOL pair.
    getTokens: async () => (await get<TokenListItem[]>("/api/tokens")).map(withQuote),
    getToken: async (mint) => {
      try {
        const t = await get<TokenWithTrades | PendingResponse>(`/api/tokens/${enc(mint)}`);
        return isPending(t) ? t : withQuote(t);
      } catch (e) {
        if (e instanceof ApiError && e.code === "not_found") return null;
        throw e;
      }
    },
    getTrades: (mint, q = {}) => get(`/api/tokens/${enc(mint)}/trades${qs({ before: q.before, limit: q.limit })}`),
    getTokenTrades: (mint, q = {}) =>
      get(`/api/tokens/${enc(mint)}/trades${qs({ filter: q.filter, before: q.before, limit: q.limit })}`),
    getSafety: async (mint) => {
      try {
        return await get<TokenSafety | PendingResponse>(`/api/tokens/${enc(mint)}/safety`);
      } catch (e) {
        if (e instanceof ApiError && e.code === "not_found") return null;
        throw e;
      }
    },
    getCandles: (mint, q = {}) => get(`/api/tokens/${enc(mint)}/candles${qs({ tf: q.tf, from: q.from, to: q.to, quote: q.quote })}`),
    getPool: () => get("/api/pool"),
    getRates: () => get("/api/rates"),
    // The anon pubkey never goes into a URL path or query (access logs = IP <-> key). Header only.
    // v0.21: the query is part of the signed path; page 0 is sent without it, as before.
    getPortfolio: (signer, holdingsPage = 0) => get(holdingsPage > 0 ? `/api/portfolio${qs({ holdingsPage })}` : "/api/portfolio", signer),
    // Padded to a fixed size bucket before signing: the length must not reveal the op or the mode.
    // Chat and noop: exactly 1024 bytes (chat.md §5.1); a longer one throws before anything is signed.
    postAction: (signer, action) =>
      post("/api/actions", EXACT_OPS.has(action.op) ? padExact(action) : action.op === "scenario_create" ? padScenario(action) : padAction(action), signer, 2),
    getAction: (signer, id) => get(`/api/actions/${enc(id)}`, signer),
    getCreator: (signer) => get("/api/creator", signer),
    getStats: () => get("/api/stats"),
    getDiscovery: () => get("/api/tokens?source=discovery"),
    getChat: (mint, q = {}) =>
      get(
        `/api/tokens/${enc(mint)}/chat${qs({
          limit: "limit" in q ? q.limit : undefined,
          before: "before" in q ? q.before : undefined,
          after: "after" in q ? q.after : undefined,
        })}`,
      ),
    request: (path, signer) => get(path, signer),
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
  return mock.subscribeFeed(onEvent, opts?.mint, networkConfig().id);
});

export const api: Api = API_MODE === "real" ? real : mocked;
