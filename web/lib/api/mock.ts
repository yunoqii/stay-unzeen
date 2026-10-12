// In-browser mock of the Unzeen backend, shaped exactly like docs/API.md.
// Used when NEXT_PUBLIC_API_MODE=mock (the default).

import type {
  FeedEvent,
  IntentRequest,
  IntentStatusResponse,
  PaymentRequest,
  Portfolio,
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

interface MockTokenState {
  token: Token;
  price: number; // SOL per token
  supply: number;
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
const intents = new Map<string, { createdAt: number }>();

function init(now: number) {
  if (state) return;
  state = SEED.map((s, i) => ({
    token: {
      mint: mintFor(s.venue, s.symbol),
      symbol: s.symbol,
      name: s.name,
      venue: s.venue,
      status: s.status,
      priceSol: "0",
      marketCapSol: "0",
      createdAt: now - (i + 1) * rand(25, 90) * 60_000,
    },
    price: s.price,
    supply: SUPPLY,
    heat: s.heat,
  }));
  syncTokenFields();

  // Back-fill the last ~12 minutes of activity.
  const backfill: FeedEvent[] = [];
  let t = now - 12 * 60_000;
  while (t < now - 4_000) {
    t += rand(6_000, 28_000);
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
  const tokens = Math.round(sol / s.price);
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
    tokenAmount: String(tokens),
    solAmount: String(sol),
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
    tokenAmount: String(Math.round(initialBuySol / price)),
    solAmount: String(initialBuySol),
    solanaTx: b58(88),
    ts,
  };
}

function nextEvent(now: number): FeedEvent {
  const ev = (Math.random() < 0.06 && makeCreateEvent(now)) || makeTradeEvent(now);
  history.unshift(ev);
  if (history.length > 500) history.length = 500;
  return ev;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const latency = () => delay(rand(120, 380));

// ---- REST ----

export async function getFeed(limit = 50): Promise<FeedEvent[]> {
  init(Date.now());
  await latency();
  return history.slice(0, limit);
}

export async function getTokens(): Promise<Token[]> {
  init(Date.now());
  await latency();
  return state!.map((s) => ({ ...s.token }));
}

export async function getToken(mint: string): Promise<TokenWithTrades | null> {
  init(Date.now());
  await latency();
  const s = state!.find((x) => x.token.mint === mint);
  if (!s) return null;
  return { ...s.token, trades: history.filter((e) => e.mint === mint).slice(0, 100) };
}

export async function createIntent(req: IntentRequest): Promise<PaymentRequest> {
  await latency();
  const intentId = b58(12);
  const amountZec = req.amount ?? "0.1";
  const address = "utest1" + b58(100).toLowerCase();
  const memo = `unzeen:v0:${intentId}`;
  intents.set(intentId, { createdAt: Date.now() });
  const memo64 = btoa(memo).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return {
    intentId,
    address,
    amountZec,
    memo,
    zip321Uri: `zcash:${address}?amount=${amountZec}&memo=${memo64}`,
    expiresAt: Date.now() + 30 * 60_000,
  };
}

export async function getIntent(id: string): Promise<IntentStatusResponse> {
  await latency();
  const it = intents.get(id);
  if (!it) return { status: "failed" };
  const age = Date.now() - it.createdAt;
  if (age < 15_000) return { status: "awaiting_payment" };
  if (age < 30_000) return { status: "seen" };
  return { status: "executed", tx: b58(88) };
}

export async function getPortfolio(anonPubkey: string): Promise<Portfolio> {
  void anonPubkey;
  init(Date.now());
  await latency();
  return { holdings: [] };
}

// ---- WS /ws/feed (simulated) ----

export function subscribeFeed(onEvent: (e: FeedEvent) => void): () => void {
  init(Date.now());
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const schedule = () => {
    // Bursty: mostly 1.5-4.5 s apart, sometimes a quick double.
    const wait = Math.random() < 0.15 ? rand(300, 900) : rand(1500, 4500);
    timer = setTimeout(() => {
      if (stopped) return;
      onEvent(nextEvent(Date.now()));
      schedule();
    }, wait);
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
