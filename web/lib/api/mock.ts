// In-browser mock of the Unzeen backend, shaped exactly like docs/API.md v0.2.
// Used when NEXT_PUBLIC_API_MODE=mock (the default). Signed endpoints verify x-unzeen-* headers
// with the same rules as the backend (60 s window, nonce replay, pubkey only in the header), so the
// real signing code is exercised end to end even without core/.
//
// It also simulates the chain side of a Top up (`mockPay`): the "wallet" pays a ZIP-321 URI and the
// "scanner" applies the same rules as core/ (unz1 verdict, chain_id, K confirmations, minimum).

import { HEADER_NONCE, verifyRequest, type SignedHeaders } from "@/lib/crypto/sign";
import { checkUnz1, decodeUnz1, type ChainId } from "@/lib/crypto/unz1";
import type { Network } from "@/lib/network";
import { memoText, parseZip321 } from "@/lib/zip321";
import { ApiError } from "./errors";
import type {
  ActionAccepted,
  ActionStatusResponse,
  Candle,
  CandleTimeframe,
  DepositInfo,
  FeedEvent,
  PlatformStats,
  PoolInfo,
  Portfolio,
  SignedAction,
  Token,
  TokenWithTrades,
  Venue,
} from "./types";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58(len: number, rnd: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < len; i++) out += B58[Math.floor(rnd() * B58.length)];
  return out;
}

/** Deterministic PRNG so mock mints survive a page reload (/token/[mint] stays valid). */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mintFor(venue: Venue, symbol: string): string {
  const rnd = seeded("unzeen-mock:" + symbol);
  // pump.fun vanity mints end with "pump"; Meteora DBC mints are plain base58.
  return venue === "pumpfun" ? b58(40, rnd) + "pump" : b58(44, rnd);
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const logRand = (min: number, max: number) => Math.exp(rand(Math.log(min), Math.log(max)));

function trimDecimals(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

// pump.fun = 6 decimals; Meteora DBC mocks use 9 so the UI is forced to honour `decimals`.
const DECIMALS: Record<Venue, number> = { pumpfun: 6, "meteora-dbc": 9, jupiter: 6 };

/** Whole tokens (2 dp precision) -> integer string in base units. */
function toBaseUnits(whole: number, decimals: number): string {
  const cents = BigInt(Math.round(whole * 100));
  return decimals >= 2 ? (cents * BigInt(10) ** BigInt(decimals - 2)).toString() : (cents / BigInt(10) ** BigInt(2 - decimals)).toString();
}

const toLamports = (sol: number) => BigInt(Math.round(sol * 1e9)).toString();

interface MockTokenState {
  token: Token;
  price: number; // SOL per whole token
  supply: number; // whole tokens
  heat: number; // relative trade frequency
}

const SEED: Array<{ symbol: string; name: string; venue: Venue; status: Token["status"]; price: number; heat: number }> = [
  { symbol: "PEPE", name: "Pepe in the Dark", venue: "pumpfun", status: "curve", price: 3.4e-7, heat: 5 },
  { symbol: "GHOST", name: "Ghost Protocol", venue: "pumpfun", status: "curve", price: 1.1e-6, heat: 4 },
  { symbol: "UMBRA", name: "Umbra", venue: "meteora-dbc", status: "curve", price: 8.2e-6, heat: 3 },
  { symbol: "NOX", name: "Nox", venue: "pumpfun", status: "graduated", price: 6.4e-5, heat: 3 },
  { symbol: "VEIL", name: "Veil Cat", venue: "meteora-dbc", status: "curve", price: 2.7e-7, heat: 2 },
  { symbol: "MOTH", name: "Moth to the Flame", venue: "pumpfun", status: "curve", price: 5.9e-7, heat: 2 },
  { symbol: "WRAITH", name: "Wraith", venue: "meteora-dbc", status: "graduated", price: 1.9e-5, heat: 1 },
];

const NEW_TOKEN_NAMES: Array<[string, string]> = [
  ["SHADE", "Shade"],
  ["HUSH", "Hush Money"],
  ["MASK", "Masked Frog"],
  ["NULL", "Null Address"],
  ["DUSK", "Dusk Dog"],
  ["CLOAK", "Cloak & Dagger"],
  ["ZEEN", "Never Zeen"],
  ["ECHO", "Echo Chamber"],
];

const SUPPLY = 1_000_000_000;

let state: MockTokenState[] | null = null;
let history: FeedEvent[] = [];
let newTokenCursor = 0;
const actions = new Map<string, { createdAt: number; action: SignedAction; pubkey: string }>();
const seenNonces = new Map<string, number>(); // `${pubkey}:${nonce}` -> expiry

function init(now: number) {
  if (state) return;
  state = SEED.map((s, i) => ({
    token: {
      mint: mintFor(s.venue, s.symbol),
      symbol: s.symbol,
      name: s.name,
      venue: s.venue,
      status: s.status,
      decimals: DECIMALS[s.venue],
      priceSol: "0",
      marketCapSol: "0",
      createdAt: now - (i + 1) * rand(25, 90) * 60_000,
    },
    price: s.price,
    supply: SUPPLY,
    heat: s.heat,
  }));
  syncTokenFields();

  // Back-fill the last ~40 minutes of activity.
  const backfill: FeedEvent[] = [];
  let t = now - 40 * 60_000;
  while (t < now - 4_000) {
    t += rand(4_000, 20_000);
    backfill.push(makeTradeEvent(Math.min(t, now - 4_000), false));
  }
  history = backfill.reverse();
}

function syncTokenFields() {
  for (const s of state!) {
    s.token.priceSol = s.price.toPrecision(4);
    s.token.marketCapSol = trimDecimals(s.price * s.supply, 2);
  }
}

function pickToken(): MockTokenState {
  const list = state!;
  const total = list.reduce((acc, s) => acc + s.heat, 0);
  let r = Math.random() * total;
  for (const s of list) {
    r -= s.heat;
    if (r <= 0) return s;
  }
  return list[0];
}

function makeTradeEvent(ts: number, mutate = true): FeedEvent {
  const s = pickToken();
  const kind: FeedEvent["kind"] = Math.random() < 0.72 ? "buy" : "sell";
  // Rounded amounts, as the relayer rounds to blur deposit sizes.
  const raw = logRand(0.05, 6);
  const sol = Number(trimDecimals(raw, raw >= 1 ? 1 : 2));
  const tokens = sol / s.price;
  if (mutate) {
    const impact = sol / Math.max(30, s.price * s.supply) / 2;
    s.price *= kind === "buy" ? 1 + impact : 1 - impact;
    syncTokenFields();
  }
  return {
    id: b58(16),
    kind,
    venue: s.token.venue,
    mint: s.token.mint,
    symbol: s.token.symbol,
    tokenAmount: toBaseUnits(tokens, s.token.decimals),
    solAmount: toLamports(sol),
    decimals: s.token.decimals,
    solanaTx: b58(88),
    ts,
  };
}

function makeCreateEvent(ts: number): FeedEvent | null {
  if (newTokenCursor >= NEW_TOKEN_NAMES.length) return null;
  const [symbol, name] = NEW_TOKEN_NAMES[newTokenCursor++];
  const venue: Venue = seeded(symbol)() < 0.6 ? "pumpfun" : "meteora-dbc";
  const price = logRand(2e-8, 1.5e-7);
  const initialBuySol = Number(trimDecimals(logRand(0.3, 3), 1));
  const s: MockTokenState = {
    token: {
      mint: mintFor(venue, symbol),
      symbol,
      name,
      venue,
      status: "curve",
      decimals: DECIMALS[venue],
      priceSol: "0",
      marketCapSol: "0",
      createdAt: ts,
    },
    price,
    supply: SUPPLY,
    heat: 3,
  };
  state!.push(s);
  syncTokenFields();
  return {
    id: b58(16),
    kind: "create",
    venue,
    mint: s.token.mint,
    symbol,
    tokenAmount: toBaseUnits(initialBuySol / price, s.token.decimals),
    solAmount: toLamports(initialBuySol),
    decimals: s.token.decimals,
    solanaTx: b58(88),
    ts,
  };
}

function nextEvent(now: number): FeedEvent {
  const ev = (Math.random() < 0.06 && makeCreateEvent(now)) || makeTradeEvent(now);
  history.unshift(ev);
  if (history.length > 1000) history.length = 1000;
  return ev;
}

function findToken(mint: string): MockTokenState {
  const s = state!.find((x) => x.token.mint === mint);
  if (!s) throw new ApiError("not_found", `unknown mint ${mint}`, 404);
  return s;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- candles ----

const TF_SEC: Record<CandleTimeframe, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };

function candles(s: MockTokenState, tf: CandleTimeframe, from: number | undefined, to: number | undefined): Candle[] {
  const step = TF_SEC[tf];
  const nowSec = Math.floor(Date.now() / 1000);
  const end = Math.floor(Math.min(to ?? nowSec, nowSec) / step) * step;
  const created = Math.floor(s.token.createdAt / 1000 / step) * step;
  let start = from !== undefined ? Math.ceil(from / step) * step : end - 299 * step;
  start = Math.max(start, created, end - 999 * step);
  if (start > end) return [];

  // Walk backwards from the live price so the last close matches priceSol.
  const rnd = seeded(`candles:${s.token.mint}:${tf}`);
  const bars: Candle[] = [];
  let close = s.price;
  for (let t = end; t >= start; t -= step) {
    const vol = 0.012 * Math.sqrt(step / 60);
    const open = close * Math.exp((rnd() - 0.52) * 2 * vol);
    const high = Math.max(open, close) * (1 + rnd() * vol);
    const low = Math.min(open, close) * (1 - rnd() * vol);
    const empty = rnd() < 0.12 && t !== end; // bars without trades are omitted
    if (!empty) {
      bars.push({
        time: t,
        open: open.toPrecision(6),
        high: high.toPrecision(6),
        low: low.toPrecision(6),
        close: close.toPrecision(6),
        volume: toLamports(logRand(0.2, 40) * Math.sqrt(step / 60)),
      });
    }
    close = open;
  }
  return bars.reverse();
}

// ---- auth (same checks as core/) ----

function authorize(method: string, path: string, body: string | undefined, headers: Partial<SignedHeaders>): string {
  const now = Date.now();
  const res = verifyRequest(headers, { method, pathWithQuery: path, body }, now);
  if (!res.ok) throw new ApiError("unauthorized", `signature ${res.reason}`, 401);
  for (const [k, exp] of seenNonces) if (exp < now) seenNonces.delete(k);
  const key = `${res.pubkey}:${headers[HEADER_NONCE]}`;
  if (seenNonces.has(key)) throw new ApiError("replay", "nonce already used", 409);
  seenNonces.set(key, now + 120_000);
  return res.pubkey;
}

// ---- pool and accounts (per network) ----

function poolAddress(network: Network): string {
  // Looks like a UA (bech32 charset); not a real address.
  const rnd = seeded("unzeen-mock-pool:" + network);
  const cs = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  let out = network === "mainnet" ? "u1" : "utest1";
  for (let i = 0; i < 106; i++) out += cs[Math.floor(rnd() * cs.length)];
  return out;
}

export function mockPool(network: Network): PoolInfo {
  return network === "mainnet"
    ? { address: poolAddress(network), network: "main", chainId: "0101", minDepositZat: "1000000", minActionZat: "100000", confirmations: 3 }
    : { address: poolAddress(network), network: "test", chainId: "0202", minDepositZat: "1000000", minActionZat: "100000", confirmations: 3 };
}

interface MockAccount {
  zecBalance: bigint;
  zecHeld: bigint;
  frozen: boolean;
  holdings: { mint: string; amount: string }[];
  deposits: DepositInfo[];
}

const accounts = new Map<string, MockAccount>(); // `${network}:${pubkey}`

function account(network: Network, pubkey: string): MockAccount {
  const key = `${network}:${pubkey}`;
  let a = accounts.get(key);
  if (!a) {
    // New keys start with no ZEC (empty states are visible); some get a few demo tokens.
    const rnd = seeded("portfolio:" + key);
    const picks = rnd() < 0.7 ? state!.filter(() => rnd() < 0.5).slice(0, 3) : [];
    a = {
      zecBalance: BigInt(0),
      zecHeld: BigInt(0),
      frozen: false,
      holdings: picks.map((s) => ({ mint: s.token.mint, amount: toBaseUnits((rnd() * 4 + 0.2) / s.price, s.token.decimals) })),
      deposits: [],
    };
    accounts.set(key, a);
  }
  return a;
}

function portfolioOf(network: Network, pubkey: string): Portfolio {
  const a = account(network, pubkey);
  return {
    zecBalance: a.zecBalance.toString(),
    zecHeld: a.zecHeld.toString(),
    frozen: a.frozen,
    holdings: a.holdings.map((h) => ({ ...h })),
    claimable: [],
    deposits: a.deposits.slice(0, 20).map((d) => ({ ...d })),
  };
}

// ---- simulated chain: wallet pays a ZIP-321 URI, scanner credits it ----

export type MockDepositPhase = "mempool" | "confirming" | "credited" | "dust" | "frozen" | "ignored";

interface MockNote {
  network: Network;
  memo: string | null;
  amountZat: bigint;
  toPool: boolean;
  sentAt: number;
  minedAt: number;
  settled: boolean;
  outcome?: MockDepositPhase;
}

const notes: MockNote[] = [];
const MEMPOOL_MS = 1_500;
const BLOCK_MS = 4_000;

function chainIdOf(pool: PoolInfo): ChainId {
  return [parseInt(pool.chainId.slice(0, 2), 16), parseInt(pool.chainId.slice(2), 16)] as unknown as ChainId;
}

/** Runs the scanner rules (docs/API.md table) on every note that reached K confirmations. */
function scan(now: number) {
  for (const n of notes) {
    if (n.settled) continue;
    const pool = mockPool(n.network);
    const confs = now < n.minedAt ? 0 : 1 + Math.floor((now - n.minedAt) / BLOCK_MS);
    if (confs < pool.confirmations) continue;
    n.settled = true;
    if (!n.toPool) {
      n.outcome = "ignored";
      continue;
    }
    if (n.amountZat < BigInt(pool.minDepositZat)) {
      n.outcome = "dust";
      continue;
    }
    const verdict = n.memo ? checkUnz1(n.memo, chainIdOf(pool), Math.floor(n.minedAt / 1000)) : "malformed";
    if (verdict === "malformed" || verdict === "bad_signature") {
      n.outcome = "frozen"; // pubkey from such a memo is not kept
      continue;
    }
    // valid, or expired without refund receiver: credited either way (we never set a refund).
    const pub = decodeUnz1(n.memo!, chainIdOf(pool)).anonPubkey;
    const a = account(n.network, pub);
    a.zecBalance += n.amountZat;
    a.deposits.unshift({ amountZat: n.amountZat.toString(), status: "credited", ts: Math.floor(now / 60_000) * 60_000 });
    n.outcome = "credited";
  }
}

/** The "wallet" sends the payment described by a ZIP-321 URI. Throws on a URI a wallet would reject. */
export function mockPay(network: Network, uri: string): void {
  init(Date.now());
  const [p] = parseZip321(uri);
  if (!p.amountZat) throw new Error("amount required");
  const now = Date.now();
  notes.push({
    network,
    memo: memoText(p),
    amountZat: BigInt(p.amountZat),
    toPool: p.address === mockPool(network).address,
    sentAt: now,
    minedAt: now + MEMPOOL_MS + BLOCK_MS,
    settled: false,
  });
}

/**
 * What a wallet watching its own outgoing tx would see for the latest payment with this memo.
 * Mock-only helper (the real API cannot attribute a note before K confirmations).
 */
export function mockDepositPhase(network: Network, memo: string): { phase: MockDepositPhase | "none"; confirmations: number } {
  const now = Date.now();
  scan(now);
  const n = [...notes].reverse().find((x) => x.network === network && x.memo === memo);
  if (!n || now < n.sentAt + MEMPOOL_MS) return { phase: "none", confirmations: 0 };
  const confs = now < n.minedAt ? 0 : 1 + Math.floor((now - n.minedAt) / BLOCK_MS);
  if (n.outcome) return { phase: n.outcome, confirmations: confs };
  return { phase: confs === 0 ? "mempool" : "confirming", confirmations: confs };
}

function stats(): PlatformStats {
  const byVenue: PlatformStats["byVenue"] = {
    pumpfun: { volumeSol: "0", trades: 0 },
    "meteora-dbc": { volumeSol: "0", trades: 0 },
    jupiter: { volumeSol: "0", trades: 0 },
  };
  let vol = 0;
  for (const e of history) {
    const sol = Number(e.solAmount) / 1e9;
    vol += sol;
    byVenue[e.venue].trades++;
    byVenue[e.venue].volumeSol = trimDecimals(Number(byVenue[e.venue].volumeSol) + sol, 2);
  }
  return {
    volumeSol: trimDecimals(vol, 2),
    zecShielded: trimDecimals(vol * 0.31, 2),
    trades: history.length,
    launches: history.filter((e) => e.kind === "create").length,
    byVenue,
    topTokens: [...state!].sort((a, b) => b.price * b.supply - a.price * a.supply).slice(0, 5).map((s) => ({ ...s.token })),
  };
}

// ---- router ----

/** Emulates one HTTP round-trip. Throws ApiError exactly where core/ would answer non-2xx. */
export async function handle(
  network: Network,
  method: "GET" | "POST",
  pathWithQuery: string,
  body: string | undefined,
  headers: Partial<SignedHeaders>,
): Promise<unknown> {
  init(Date.now());
  await delay(rand(120, 380));
  scan(Date.now());
  const url = new URL(pathWithQuery, "http://mock.local");
  const p = url.pathname;
  const q = url.searchParams;
  let m: RegExpMatchArray | null;
  const json = () => (body ? (JSON.parse(body) as unknown) : null);

  if (method === "GET") {
    if (p === "/api/feed") return history.slice(0, Math.min(Number(q.get("limit") ?? 50), 200));
    if (p === "/api/tokens") return state!.map((s) => ({ ...s.token }));
    if (p === "/api/stats") return stats();

    if ((m = p.match(/^\/api\/tokens\/([^/]+)$/))) {
      const s = findToken(decodeURIComponent(m[1]));
      const out: TokenWithTrades = { ...s.token, trades: history.filter((e) => e.mint === s.token.mint).slice(0, 50) };
      return out;
    }
    if ((m = p.match(/^\/api\/tokens\/([^/]+)\/trades$/))) {
      const s = findToken(decodeURIComponent(m[1]));
      const limit = Number(q.get("limit") ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError("bad_request", "limit must be 1..200", 400);
      let list = history.filter((e) => e.mint === s.token.mint);
      const before = q.get("before");
      if (before) {
        const i = list.findIndex((e) => e.id === before);
        if (i < 0) throw new ApiError("not_found", "unknown trade id", 404);
        list = list.slice(i + 1);
      }
      return list.slice(0, limit);
    }
    if ((m = p.match(/^\/api\/tokens\/([^/]+)\/candles$/))) {
      const s = findToken(decodeURIComponent(m[1]));
      const tf = (q.get("tf") ?? "5m") as CandleTimeframe;
      if (!(tf in TF_SEC)) throw new ApiError("bad_request", "bad tf", 400);
      const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
      return candles(s, tf, num("from"), num("to"));
    }
    if (p === "/api/pool") return mockPool(network);
    if ((m = p.match(/^\/api\/actions\/([^/]+)$/))) {
      const pub = authorize(method, pathWithQuery, body, headers);
      const a = actions.get(decodeURIComponent(m[1]));
      if (!a || a.pubkey !== pub) throw new ApiError("not_found", "unknown action", 404);
      const res: ActionStatusResponse =
        Date.now() - a.createdAt < 4_000 ? { status: "queued" } : { status: "executed", solanaTx: b58(88) };
      return res;
    }
    if (p === "/api/portfolio") {
      // pubkey comes only from the signed header, never from the path.
      return portfolioOf(network, authorize(method, pathWithQuery, body, headers));
    }
    if (p === "/api/orders" || p === "/api/creator") {
      authorize(method, pathWithQuery, body, headers);
      return [];
    }
  }

  if (method === "POST") {
    if (p === "/api/actions") {
      const pub = authorize(method, pathWithQuery, body, headers);
      const action = json() as SignedAction | null;
      if (!action?.op) throw new ApiError("bad_request", "op required", 400);
      if (account(network, pub).frozen) throw new ApiError("balance_frozen", "balance frozen", 423);
      const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
      const id = hex; // 128 random bits, hex (docs/API.md)
      actions.set(id, { createdAt: Date.now(), action, pubkey: pub });
      const res: ActionAccepted = { id, status: "queued" };
      return res;
    }
  }

  throw new ApiError("not_found", `${method} ${p}`, 404);
}

// ---- WS /ws/feed[?mint=] (simulated) ----

export function subscribeFeed(onEvent: (e: FeedEvent) => void, mint?: string): () => void {
  init(Date.now());
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const schedule = () => {
    // Bursty: mostly 1.5-4.5 s apart, sometimes a quick double.
    const wait = Math.random() < 0.15 ? rand(300, 900) : rand(1500, 4500);
    timer = setTimeout(() => {
      if (stopped) return;
      const ev = nextEvent(Date.now());
      if (!mint || ev.mint === mint) onEvent(ev);
      schedule();
    }, wait);
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
