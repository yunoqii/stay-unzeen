// In-browser mock of the token chat backend, shaped exactly like docs/API.md v0.12, chat section (spec:
// docs/analysis/chat.md; nicknames checked against core/testdata/chat-vectors.json). Same rules as the spec: HMAC nicknames with a key outside
// the "database", a separate creator nickname, publication only on epoch boundaries (random order
// inside a batch), slow mode through publish_after, deletes / hides applied on the next boundary,
// auto-hide after 3 distinct reporters, admission by account value, per-key rate limits. Nothing here
// stores a pubkey next to a message.
//
// Time is injected (`now` on every call) so tests can walk through boundaries without waiting.

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { checkChatText } from "@/lib/chat/text";
import type { Network } from "@/lib/network";
import { ApiError } from "./errors";
import type { ActionReceipt, ChatMessage, ChatPage, ChatParams, ChatRemovedReason, PoolInfo, SignedAction } from "./types";

/** Delayed-epoch boundary of the mock (core: the same Epochs as Delayed trades, 30-60 s). */
export const MOCK_CHAT_EPOCH_MS = 10_000;
/** Slow mode delay, compressed for the demo (core: 120-300 s). */
export const MOCK_SLOW_MS: readonly [number, number] = [30_000, 60_000];
export const TOMBSTONE_MS = 24 * 3_600_000;

export const CHAT_OPS: ReadonlySet<string> = new Set(["chat", "chat_delete", "chat_hide", "chat_report"]);

export function mockChatParams(network: Network): ChatParams {
  return {
    // mainnet 0.05 ZEC, devnet 0.001 TAZ (chat.md §4.1)
    minAccountZat: network === "mainnet" ? "5000000" : "100000",
    maxChars: 280,
    maxJsonBytes: 800,
    bodyBytes: 1024,
    rate: { minIntervalSecs: 10, perHour: 20, perDay: 100 },
    reportHideThreshold: 3,
    slowDelaySecs: { min: 120, max: 300 },
    retentionDays: 30,
  };
}

// ---- nickname (chat.md §2) ----

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
const NICK_DOMAIN = new TextEncoder().encode("unzeen/chat/nick/v1");

/** Crockford base32, lower case, MSB first; the first `chars` characters. */
export function crockford32(bytes: Uint8Array, chars: number): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
    if (out.length >= chars) break;
  }
  return out;
}

const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

/** nick = b32(HMAC-SHA256(K_chat, domain ‖ chainId[2] ‖ mint[32] ‖ anonPubkey[32] ‖ flag))[0..8] */
export function chatNick(kChat: Uint8Array, chainIdHex: string, mint: string, pubkey: string, creator: boolean): string {
  const parts = [NICK_DOMAIN, hexBytes(chainIdHex), base58.decode(mint), base58.decode(pubkey), Uint8Array.of(creator ? 1 : 0)];
  const msg = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    msg.set(p, o);
    o += p.length;
  }
  return crockford32(hmac(sha256, kChat, msg), 8);
}

// ---- state ----

export interface ChatHost {
  pool(network: Network): PoolInfo;
  /** ZEC available + held + tokens at the tick price, zatoshis (chat.md §4.1). */
  accountValueZat(network: Network, pubkey: string): bigint;
  frozen(network: Network, pubkey: string): boolean;
  /** creator_tokens: this key launched this mint through Unzeen. */
  isCreator(network: Network, pubkey: string, mint: string): boolean;
  /** In the public GET /api/tokens list. */
  isPublicMint(mint: string): boolean;
  isUnzeenLaunch(mint: string): boolean;
}

interface Msg {
  id: string;
  network: Network;
  mint: string;
  nick: string;
  isCreator: boolean;
  text: string | null;
  status: "pending" | "published" | "removed";
  publishAfter: number;
  ts?: number;
  seq?: bigint;
  hiddenByCreator?: boolean;
  removedReason?: ChatRemovedReason;
  removedAt?: number;
  /** Requested delete / hide / auto-hide, applied on the boundary at or after this time. */
  removeAt?: { at: number; reason: ChatRemovedReason };
  hideAt?: number;
  /** reporter tags (the mock keeps them in memory only; core: HMAC(K_chat, id ‖ pk)). */
  reporters: Set<string>;
}

export interface ChatMockOptions {
  /** Simulated other people (demo). Off in tests. */
  chatter?: boolean;
  random?: () => number;
}

export interface ChatMock {
  submit(network: Network, pubkey: string, action: SignedAction, bodyBytes: number, now: number): ActionReceipt;
  get(network: Network, mint: string, q: URLSearchParams, now: number): ChatPage;
  tick(now: number): void;
  /** Test hook: K_chat of a network. */
  key(network: Network): Uint8Array;
}

const boundaryAtOrAfter = (t: number) => Math.ceil(t / MOCK_CHAT_EPOCH_MS) * MOCK_CHAT_EPOCH_MS;
const nextBoundary = (t: number) => Math.floor(t / MOCK_CHAT_EPOCH_MS) * MOCK_CHAT_EPOCH_MS + MOCK_CHAT_EPOCH_MS;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isMint = (m: string) => {
  if (!MINT_RE.test(m)) return false;
  try {
    return base58.decode(m).length === 32;
  } catch {
    return false;
  }
};

export function createChatMock(host: ChatHost, opts: ChatMockOptions = {}): ChatMock {
  const rnd = opts.random ?? Math.random;
  const keys: Record<Network, Uint8Array> = {
    devnet: sha256(new TextEncoder().encode("unzeen-mock/K_chat/devnet")),
    mainnet: sha256(new TextEncoder().encode("unzeen-mock/K_chat/mainnet")),
    hood: sha256(new TextEncoder().encode("unzeen-mock/K_chat/hood")),
  };
  const msgs = new Map<string, Msg>();
  let seq = BigInt(0);
  /** Per-key timestamps of chat ops (core: in-memory Limiter with a hashed key). */
  const ops = new Map<string, number[]>();

  const hex16 = () => Array.from({ length: 16 }, () => Math.floor(rnd() * 256).toString(16).padStart(2, "0")).join("");
  const nickOf = (network: Network, mint: string, pubkey: string, creator: boolean) => chatNick(keys[network], host.pool(network).chainId, mint, pubkey, creator);

  function limit(network: Network, pubkey: string, now: number) {
    const k = `${network}:${pubkey}`;
    const list = (ops.get(k) ?? []).filter((t) => now - t < 86_400_000);
    const p = mockChatParams(network).rate;
    const last = list[list.length - 1];
    if (last !== undefined && now - last < p.minIntervalSecs * 1000) throw new ApiError("rate_limited", "chat: too fast", 429, undefined, Math.ceil((p.minIntervalSecs * 1000 - (now - last)) / 1000));
    if (list.filter((t) => now - t < 3_600_000).length >= p.perHour) throw new ApiError("rate_limited", "chat: hourly limit", 429);
    if (list.length >= p.perDay) throw new ApiError("rate_limited", "chat: daily limit", 429);
    list.push(now);
    ops.set(k, list);
  }

  function eligible(network: Network, pubkey: string) {
    if (host.accountValueZat(network, pubkey) < BigInt(mockChatParams(network).minAccountZat)) {
      // No amounts in the answer: neither the balance nor how far it is from the threshold.
      throw new ApiError("chat_not_eligible", "account below the chat minimum", 403);
    }
  }

  function find(network: Network, id: unknown): Msg {
    const m = typeof id === "string" ? msgs.get(id) : undefined;
    if (!m || m.network !== network || m.status === "removed") throw new ApiError("not_found", "unknown message", 404);
    return m;
  }

  const isAuthor = (m: Msg, network: Network, pubkey: string) => nickOf(network, m.mint, pubkey, m.isCreator) === m.nick;

  function submit(network: Network, pubkey: string, action: SignedAction, bodyBytes: number, now: number): ActionReceipt {
    tick(now);
    const params = mockChatParams(network);
    if (!host.pool(network).features?.chat) throw new ApiError("bad_request", "chat is off", 400);
    if (bodyBytes !== params.bodyBytes) throw new ApiError("bad_request", `chat bodies are exactly ${params.bodyBytes} bytes`, 400);
    if (host.frozen(network, pubkey)) throw new ApiError("balance_frozen", "balance frozen", 423);

    switch (action.op) {
      case "chat": {
        const mint = String(action.mint);
        if (!isMint(mint)) throw new ApiError("bad_request", "mint: not a Solana address", 400);
        if (!host.isPublicMint(mint)) throw new ApiError("not_found", "unknown mint", 404);
        if (typeof action.text !== "string") throw new ApiError("bad_request", "text: expected a string", 400);
        const check = checkChatText(action.text);
        if (!check.ok) throw new ApiError("chat_text_invalid", "text rejected", 400, check.problem); // details = rule code (v0.12)
        if (action.showCreatorBadge !== undefined && typeof action.showCreatorBadge !== "boolean") throw new ApiError("bad_request", "showCreatorBadge: boolean", 400);
        if (action.slow !== undefined && typeof action.slow !== "boolean") throw new ApiError("bad_request", "slow: boolean", 400);
        eligible(network, pubkey);
        const creator = action.showCreatorBadge === true;
        if (creator && !host.isCreator(network, pubkey, mint)) throw new ApiError("not_creator", "not the creator of this mint", 403);
        const pendingHere = [...msgs.values()].filter((m) => m.network === network && m.mint === mint && m.status === "pending").length;
        if (pendingHere >= 50) throw new ApiError("rate_limited", "chat: batch full", 429);
        limit(network, pubkey, now);
        const [lo, hi] = MOCK_SLOW_MS;
        const m: Msg = {
          id: hex16(),
          network,
          mint,
          nick: nickOf(network, mint, pubkey, creator),
          isCreator: creator,
          text: action.text,
          status: "pending",
          publishAfter: action.slow ? now + lo + rnd() * (hi - lo) : now,
          reporters: new Set(),
        };
        msgs.set(m.id, m);
        return { id: m.id, status: "queued", nick: m.nick };
      }
      case "chat_delete": {
        const m = find(network, action.id);
        if (!isAuthor(m, network, pubkey)) throw new ApiError("not_found", "unknown message", 404);
        limit(network, pubkey, now);
        m.removeAt ??= { at: nextBoundary(now), reason: "deleted" };
        return { id: m.id, status: "queued" };
      }
      case "chat_hide": {
        const m = find(network, action.id);
        if (!host.isCreator(network, pubkey, m.mint)) throw new ApiError("not_creator", "not the creator of this mint", 403);
        limit(network, pubkey, now);
        if (!m.hiddenByCreator) m.hideAt ??= nextBoundary(now);
        return { id: m.id, status: "queued" };
      }
      case "chat_report": {
        if (!["spam", "scam", "abuse"].includes(action.reason)) throw new ApiError("bad_request", "reason: spam | scam | abuse", 400);
        eligible(network, pubkey);
        const m = find(network, action.id);
        limit(network, pubkey, now);
        // Your own message, or a repeat: 200 without effect (nothing tells you why).
        const own = nickOf(network, m.mint, pubkey, false) === m.nick || nickOf(network, m.mint, pubkey, true) === m.nick;
        if (!own) {
          m.reporters.add(`${network}:${pubkey}`);
          if (m.reporters.size >= mockChatParams(network).reportHideThreshold) m.removeAt ??= { at: nextBoundary(now), reason: "reports" };
        }
        return { id: m.id, status: "executed" };
      }
      default:
        throw new ApiError("bad_request", "not a chat op", 400);
    }
  }

  /** Publish everything due, boundary by boundary; then apply removals and hides of that boundary. */
  function tick(now: number) {
    if (opts.chatter) chatter(now);
    const due = new Set<number>();
    for (const m of msgs.values()) {
      if (m.status === "pending" && boundaryAtOrAfter(m.publishAfter) <= now) due.add(boundaryAtOrAfter(m.publishAfter));
      if (m.removeAt && m.status !== "removed" && boundaryAtOrAfter(m.removeAt.at) <= now) due.add(boundaryAtOrAfter(m.removeAt.at));
      if (m.hideAt !== undefined && boundaryAtOrAfter(m.hideAt) <= now) due.add(boundaryAtOrAfter(m.hideAt));
    }
    for (const b of [...due].sort((x, y) => x - y)) {
      // Removals requested for this boundary also cover messages still pending: they never appear.
      const batch = [...msgs.values()].filter((m) => m.status === "pending" && boundaryAtOrAfter(m.publishAfter) <= b && !(m.removeAt && m.removeAt.at <= b));
      // Random order inside a batch: seq must not reveal who sent first.
      for (let i = batch.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [batch[i], batch[j]] = [batch[j], batch[i]];
      }
      for (const m of batch) {
        m.status = "published";
        m.ts = b;
        m.publishAfter = b; // no receive time left behind (chat.md §9 migration note)
        m.seq = ++seq;
      }
      for (const m of msgs.values()) {
        if (m.removeAt && m.status !== "removed" && boundaryAtOrAfter(m.removeAt.at) <= b) {
          const wasPublished = m.status === "published";
          m.status = "removed";
          m.text = null;
          m.removedReason = m.removeAt.reason;
          m.removedAt = b;
          m.hideAt = undefined;
          if (wasPublished) m.seq = ++seq;
          else msgs.delete(m.id);
        } else if (m.hideAt !== undefined && m.status === "published" && boundaryAtOrAfter(m.hideAt) <= b) {
          m.hiddenByCreator = true;
          m.hideAt = undefined;
          m.seq = ++seq; // re-sent through after= with the flag
        }
      }
    }
    for (const [id, m] of msgs) if (m.status === "removed" && m.removedAt !== undefined && now - m.removedAt > TOMBSTONE_MS) msgs.delete(id);
  }

  const view = (m: Msg): ChatMessage => ({
    id: m.id,
    mint: m.mint,
    nick: m.nick,
    isCreator: m.isCreator,
    text: m.text ?? "",
    ts: m.ts!,
    seq: m.seq!.toString(),
    ...(m.hiddenByCreator ? { hiddenByCreator: true as const } : {}),
  });

  function get(network: Network, mint: string, q: URLSearchParams, now: number): ChatPage {
    if (!isMint(mint)) throw new ApiError("bad_request", "mint: not a Solana address", 400);
    if (!host.isPublicMint(mint)) return { messages: [], removed: [], cursor: "0", more: false };
    watch(network, mint, now);
    tick(now);
    const here = [...msgs.values()].filter((m) => m.network === network && m.mint === mint && m.seq !== undefined);
    const top = here.reduce((x, m) => (m.seq! > x ? m.seq! : x), BigInt(0));
    const after = q.get("after");
    const before = q.get("before");
    const lim = q.has("limit") ? Number(q.get("limit")) : 50;
    if (!Number.isInteger(lim) || lim < 1 || lim > 100) throw new ApiError("bad_request", "limit must be 1..100", 400);
    const seqParam = (v: string) => {
      if (!/^\d{1,19}$/.test(v)) throw new ApiError("bad_request", "cursor: decimal string", 400);
      return BigInt(v);
    };
    if (after !== null) {
      const from = seqParam(after);
      const events = here.filter((m) => m.seq! > from).sort((a, b) => (a.seq! < b.seq! ? -1 : 1));
      const page = events.slice(0, 100);
      const last = page.length ? page[page.length - 1].seq! : from;
      return {
        messages: page.filter((m) => m.status === "published").map(view),
        removed: page.filter((m) => m.status === "removed").map((m) => ({ id: m.id, reason: m.removedReason! })),
        cursor: last.toString(),
        more: events.length > page.length,
      };
    }
    const live = here.filter((m) => m.status === "published").sort((a, b) => (a.seq! > b.seq! ? -1 : 1));
    const pool = before !== null ? live.filter((m) => m.seq! < seqParam(before)) : live;
    const page = pool.slice(0, lim);
    return { messages: page.map(view), removed: [], cursor: top.toString(), more: pool.length > page.length };
  }

  // ---- simulated other people (demo only) ----

  const watched = new Map<string, number>(); // `${network}:${mint}` -> last read
  let lastChatter = 0;

  function fakeKey(mint: string, i: number): string {
    return base58.encode(sha256(new TextEncoder().encode(`unzeen-mock/chat-person/${mint}/${i}`)));
  }

  function fake(network: Network, mint: string, person: number, text: string, at: number, creator = false): Msg {
    const m: Msg = { id: hex16(), network, mint, nick: nickOf(network, mint, fakeKey(mint, person), creator), isCreator: creator, text, status: "pending", publishAfter: at, reporters: new Set() };
    msgs.set(m.id, m);
    return m;
  }

  function watch(network: Network, mint: string, now: number) {
    const k = `${network}:${mint}`;
    const first = !watched.has(k);
    watched.set(k, now);
    if (!first || !opts.chatter) return;
    // A believable backlog: published on past boundaries, oldest first.
    const n = 10 + Math.floor(rnd() * 8);
    const start = boundaryAtOrAfter(now - 50 * 60_000);
    for (let i = 0; i < n; i++) {
      const at = start + Math.floor(((i + rnd() * 0.5) / n) * 45 * 60_000);
      fake(network, mint, Math.floor(rnd() * 7), LINES[Math.floor(rnd() * LINES.length)], at);
    }
    if (host.isUnzeenLaunch(mint)) {
      fake(network, mint, 0, CREATOR_LINES[Math.floor(rnd() * CREATOR_LINES.length)], now - 20 * 60_000, true);
      const fud = fake(network, mint, 9, "dev is going to rug this tonight, sell everything now", now - 12 * 60_000);
      fud.hideAt = now + 25_000; // hidden live, a little after you open the chat
    }
    const spam = fake(network, mint, 8, "FREE AIRDROP for holders, claim fast at unzeen-airdrop dot xyz", now - 6 * 60_000);
    for (let r = 0; r < 3; r++) spam.reporters.add(`fake:${r}`);
    spam.removeAt = { at: now + 15_000, reason: "reports" }; // auto-hidden live by reports
  }

  function chatter(now: number) {
    const b = Math.floor(now / MOCK_CHAT_EPOCH_MS) * MOCK_CHAT_EPOCH_MS;
    if (b <= lastChatter) return;
    const steps = lastChatter === 0 ? 1 : Math.min(6, (b - lastChatter) / MOCK_CHAT_EPOCH_MS);
    lastChatter = b;
    for (const [k, seen] of watched) {
      if (now - seen > 2 * 60_000) continue;
      const [network, mint] = k.split(":") as [Network, string];
      for (let s = 0; s < steps; s++) if (rnd() < 0.3) fake(network, mint, Math.floor(rnd() * 7), LINES[Math.floor(rnd() * LINES.length)], b);
    }
  }

  return { submit, get, tick, key: (n) => keys[n] };
}

const LINES = [
  "gm",
  "chart looks clean, no dev dumps so far",
  "who else is in from the first batch?",
  "curve filling faster than I expected",
  "holding, not selling below 2x",
  "nobody can see my bags and I love it",
  "volume picking up again",
  "this is the quietest pump I've seen",
  "just topped up, ZEC is in the pool",
  "anyone know if it graduates today?",
  "wen raydium",
  "paper hands left already, good",
  "slow mode is underrated",
  "stay unzeen",
  "chart says accumulate",
  "lp burned? checked the safety panel, looks fine",
  "took some profit, still holding the rest",
  "can't believe this is still on the curve",
];

const CREATOR_LINES = ["dev here. lock is on for 24h, check the safety panel", "creator here: no team wallet, no presale. just the curve"];

