// In-browser mock of the Unzeen backend, shaped exactly like docs/API.md v0.2.
// Used when NEXT_PUBLIC_API_MODE=mock (the default). Signed endpoints verify x-unzeen-* headers
// with the same rules as the backend (60 s window, nonce replay, pubkey only in the header), so the
// real signing code is exercised end to end even without core/.
//
// It also simulates the chain side of a Top up (`mockPay`): the "wallet" pays a ZIP-321 URI and the
// "scanner" applies the same rules as core/ (unz1 verdict, chain_id, K confirmations, minimum).

import { base58 } from "@scure/base";
import { bodyHash, HEADER_NONCE, verifyRequest, type SignedHeaders } from "@/lib/crypto/sign";
import { isExecMode } from "@/lib/exec";
import { isSolanaAddress } from "@/lib/trade";
import { checkWithdrawUa } from "@/lib/zcash/ua";
import { checkUnz1, decodeUnz1, type ChainId } from "@/lib/crypto/unz1";
import type { Network } from "@/lib/network";
import { memoText, parseZip321 } from "@/lib/zip321";
import { ApiError } from "./errors";
import type { FairHost, FairMock } from "./mock-fair";
import type { VerifyMock } from "./mock-verify";
import type {
  ActionReceipt,
  ActionStatus,
  Candle,
  CreatorCabinet,
  CreatorToken,
  CandleTimeframe,
  DepositInfo,
  ExecMode,
  FeedEvent,
  Order,
  OrderKind,
  OrdersParams,
  PlatformStats,
  PoolInfo,
  Portfolio,
  PendingResponse,
  RateUsed,
  SignedAction,
  Token,
  TokenSafety,
  TokenTrade,
  TokenWithTrades,
  TradeFilter,
  TradeTag,
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

/** A valid Solana address (base58 of 32 bytes), stable per symbol. */
function mintFor(venue: Venue, symbol: string): string {
  const rnd = seeded(`unzeen-mock:${venue}:${symbol}`);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Math.floor(rnd() * 256);
  bytes[0] |= 1; // no leading-zero "1" prefix
  return base58.encode(bytes);
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const logRand = (min: number, max: number) => Math.exp(rand(Math.log(min), Math.log(max)));

function trimDecimals(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

/** `sig` significant digits as a plain decimal string (never e-notation, as core sends). */
function plain(n: number, sig: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const digits = Math.min(100, Math.max(0, sig - 1 - Math.floor(Math.log10(n))));
  return trimDecimals(n, digits);
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
    s.token.priceSol = plain(s.price, 4);
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
  accrueCreatorFee(ev);
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
        open: plain(open, 6),
        high: plain(high, 6),
        low: plain(low, 6),
        close: plain(close, 6),
        volume: toLamports(logRand(0.2, 40) * Math.sqrt(step / 60)),
      });
    }
    close = open;
  }
  return bars.reverse();
}

// ---- auth (same checks as core/) ----

function verify(network: Network, method: string, path: string, body: string | undefined, headers: Partial<SignedHeaders>) {
  const now = Date.now();
  const res = verifyRequest(headers, { chainId: mockPool(network).chainId, method, pathWithQuery: path, body }, now);
  if (!res.ok) throw new ApiError("unauthorized", `signature ${res.reason}`, 401);
  for (const [k, exp] of seenNonces) if (exp < now) seenNonces.delete(k);
  return { pubkey: res.pubkey, nonceKey: `${network}:${res.pubkey}:${headers[HEADER_NONCE]}`, now };
}

function authorize(
  network: Network,
  method: string,
  path: string,
  body: string | undefined,
  headers: Partial<SignedHeaders>,
): string {
  const { pubkey, nonceKey, now } = verify(network, method, path, body, headers);
  if (seenNonces.has(nonceKey)) throw new ApiError("replay", "nonce already used", 409);
  seenNonces.set(nonceKey, now + 120_000);
  return pubkey;
}

// ---- pool and accounts (per network) ----

const hex16 = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
const UNSUPPORTED_OPS = new Set(["chat"]);

function poolAddress(network: Network): string {
  // Looks like a UA (bech32 charset); not a real address.
  const rnd = seeded("unzeen-mock-pool:" + network);
  const cs = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  let out = network === "mainnet" ? "u1" : "utest1";
  for (let i = 0; i < 106; i++) out += cs[Math.floor(rnd() * cs.length)];
  return out;
}

/** launchRules.maxInitialBuyLamports of the mock: about 5% of supply on a fresh curve. */
const MOCK_MAX_INITIAL_BUY_LAMPORTS = BigInt(1_500_000_000);
/** v0.6 per-venue cap: meteora-dbc narrowed by 5/5.013 (its 1 % fee vs ~1.25 %), as core does for now. */
const mockVenueCap = (venue: string) => (venue === "meteora-dbc" ? (MOCK_MAX_INITIAL_BUY_LAMPORTS * BigInt(5000)) / BigInt(5013) : MOCK_MAX_INITIAL_BUY_LAMPORTS);

/** Flat fee of exec "now" (field name pending in docs/API.md). Shown in quotes; the mock does not charge it. */
const NOW_FEE_ZAT = "5000";
const FEES = { nowFeeZat: NOW_FEE_ZAT, createFeeZat: "100000", withdrawZecFeeZat: "15000" };

/** Mock twin of UNZEEN_CREATE_ENABLED: NEXT_PUBLIC_MOCK_CREATE_DISABLED=1 shows the disabled launch state. */
const CREATE_ENABLED = process.env.NEXT_PUBLIC_MOCK_CREATE_DISABLED !== "1";

export function mockPool(network: Network): PoolInfo {
  const extra = {
    createEnabled: CREATE_ENABLED,
    // v0.7: with the flag off the key is absent altogether (absent = off). The condition is written on
    // process.env directly so the build drops the whole branch, names included (review F3).
    ...(process.env.NEXT_PUBLIC_MOCK_FAIR_LAUNCH === "1"
      ? { features: { fullTrades: FULL_FEED, fairLaunch: true }, ...(fair ? { fairLaunch: fair.params(network) } : {}) }
      : { features: { fullTrades: FULL_FEED } }),
    orders: ORDER_PARAMS,
    launchRules: {
      lockSecs: 86_400,
      capBps: 500,
      maxInitialBuyLamports: MOCK_MAX_INITIAL_BUY_LAMPORTS.toString(),
      maxInitialBuyLamportsByVenue: { pumpfun: MOCK_MAX_INITIAL_BUY_LAMPORTS.toString(), "meteora-dbc": mockVenueCap("meteora-dbc").toString() },
    },
  };
  const rate = { lamportsPerZec: MID_LAMPORTS_PER_ZEC.toString(), lamportsPerZecBuy: mockRate(true).lamportsPerZec, lamportsPerZecSell: mockRate(false).lamportsPerZec, spreadBps: Number(SPREAD_BPS), source: "fixed" as const, ts: Math.floor(Date.now() / 60_000) * 60_000 };
  return network === "mainnet"
    ? { address: poolAddress(network), network: "main", chainId: "0101", minDepositZat: "1000000", minActionZat: "100000", confirmations: 3, fees: FEES, rate, ...extra }
    : { address: poolAddress(network), network: "test", chainId: "0202", minDepositZat: "1000000", minActionZat: "100000", confirmations: 3, fees: FEES, rate, ...extra };
}

interface MockAccount {
  zecBalance: bigint;
  zecHeld: bigint;
  frozen: boolean;
  holdings: { mint: string; amount: string; held: string }[];
  deposits: DepositInfo[];
  /** v0.7 creator fees owed, lamports per mint this key launched. */
  claimable: Map<string, bigint>;
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
      holdings: picks.map((s) => ({ mint: s.token.mint, amount: toBaseUnits((rnd() * 4 + 0.2) / s.price, s.token.decimals), held: "0" })),
      deposits: [],
      claimable: new Map(),
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
    claimable: [...a.claimable].filter(([, v]) => v > N0).map(([mint, v]) => ({ mint, solAmount: v.toString() })),
    deposits: a.deposits.slice(0, 20).map((d) => ({ ...d })),
    // Every own action rides along with the regular poll (order_* never: an order shows in `orders`).
    actions: [...actions.values()]
      .filter((x) => x.network === network && x.pubkey === pubkey && !x.hidden)
      .map((x) => ({ id: x.id, kind: x.action.op as NonNullable<NonNullable<Portfolio["actions"]>[number]["kind"]>, ...x.status })),
    orders: ordersOf(network, pubkey, Date.now()),
    ...(fair ? fair.portfolio(network, pubkey) : {}),
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
    a.deposits.unshift({ id: hex16(), amountZat: n.amountZat.toString(), status: "credited", ts: Math.floor(now / 86_400_000) * 86_400_000 });
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

// ---- GET /api/stats (v0.9): one frozen snapshot per UTC day, k-anonymity k = 5 ----

const K = 5;
const DAY_MS = 86_400_000;
/** Mock twin of "before the first snapshot": NEXT_PUBLIC_MOCK_STATS_EMPTY=1 answers 404. */
const STATS_EMPTY = process.env.NEXT_PUBLIC_MOCK_STATS_EMPTY === "1";
let statsSnap: { day: number; data: PlatformStats } | null = null;

const kCount = (n: number): number | "<5" => (n < K ? "<5" : n);
/** SOL rounded DOWN to 0.1 SOL, "<5" when built from fewer than 5 trades. */
const kSol = (lamports: bigint, n: number): string | "<5" => (n < K ? "<5" : trimDecimals(Number(lamports / BigInt(100_000_000)) / 10, 1) || "0");

/**
 * The mock has only ~40 minutes of history, so its "daily snapshot" is taken over everything seen
 * when it is first asked for that UTC day, then frozen until the next day (core: strictly before
 * 00:00 UTC, built once). Nothing here moves when a trade or deposit happens.
 */
function stats(now: number): PlatformStats {
  if (STATS_EMPTY) throw new ApiError("not_found", "no stats snapshot yet", 404);
  const day = Math.floor(now / DAY_MS) * DAY_MS;
  if (statsSnap?.day === day) return structuredClone(statsSnap.data);
  const trades = history.filter((e) => e.kind !== "create");
  const venues: Venue[] = ["pumpfun", "meteora-dbc", "jupiter"];
  const byVenue = Object.fromEntries(
    venues.map((v) => {
      const t = trades.filter((e) => e.venue === v);
      const vol = t.reduce((x, e) => x + BigInt(e.solAmount), N0);
      return [v, { volumeSol: kSol(vol, t.length), trades: kCount(t.length), launches: kCount(history.filter((e) => e.kind === "create" && e.venue === v).length) }];
    }),
  ) as PlatformStats["byVenue"];
  const per = new Map<string, { vol: bigint; n: number }>();
  for (const e of trades) {
    const x = per.get(e.mint) ?? { vol: N0, n: 0 };
    per.set(e.mint, { vol: x.vol + BigInt(e.solAmount), n: x.n + 1 });
  }
  const top = state!
    .filter((st) => (per.get(st.token.mint)?.n ?? 0) >= K)
    .sort((a, b) => Number(per.get(b.token.mint)!.vol - per.get(a.token.mint)!.vol))
    .slice(0, 10)
    .map((st) => ({ ...st.token, volumeSol: kSol(per.get(st.token.mint)!.vol, K) as string, trades: per.get(st.token.mint)!.n }));
  const deposits = [...accounts.values()].reduce((n, a) => n + a.deposits.length, 0);
  const total = trades.reduce((x, e) => x + BigInt(e.solAmount), N0);
  const data: PlatformStats = {
    asOf: day,
    volumeSol: kSol(total, trades.length),
    trades: kCount(trades.length),
    launches: kCount(history.filter((e) => e.kind === "create").length),
    // Demo figure: the mock has no real deposit history worth summing; core rounds down to 1 ZEC.
    zecShielded: deposits + 40 < K ? "<5" : String(Math.floor(Number(total) / 1e9 * 0.31)),
    byVenue,
    topTokens: top,
    topWindowDays: 7,
  };
  statsSnap = { day, data };
  return structuredClone(data);
}

/** TEST: forget the frozen daily snapshot. */
export function mockResetStats() {
  statsSnap = null;
}

// ---- actions from the balance (rules of docs/API.md "Правила исполнения действий" and core/api) ----

/** Mid rate, SOL per ZEC (devnet "fixed" source); the pool spread is applied per side. */
const MID_LAMPORTS_PER_ZEC = BigInt(1_800_000_000);
const SPREAD_BPS = BigInt(50);
const ZAT = BigInt(100_000_000);
const N0 = BigInt(0);
const CREATE_FEE_ZAT = BigInt(100_000);
const WITHDRAW_ZEC_FEE_ZAT = BigInt(15_000);
const WITHDRAW_TOKEN_LAMPORTS_PER_PART = BigInt(2_000_000 + 2_100_000);

function mockRate(buy: boolean): RateUsed {
  const v = (MID_LAMPORTS_PER_ZEC * (BigInt(10_000) + (buy ? -SPREAD_BPS : SPREAD_BPS))) / BigInt(10_000);
  return { lamportsPerZec: v.toString(), source: "fixed", ts: Date.now() };
}

/**
 * Execution delays, compressed for the demo (core: buy/sell 3-20 s, withdraw_token 30 s-5 min or up to
 * maxDelayMin per part, withdraw_zec 1-10 min). Order and states are the same.
 */
const EXEC_DELAY_MS: Record<string, [number, number]> = {
  buy: [3_000, 8_000],
  sell: [3_000, 8_000],
  create: [5_000, 10_000],
  withdraw_token: [8_000, 16_000],
  withdraw_zec: [12_000, 24_000],
};

/**
 * Execution mode timing (owner decision 12.10). "now" is real-time (1-3 s); "delayed" (30-60 s) and
 * "max" (5-15 min) are compressed so a demo does not stall. Without `exec` the op's own delay applies.
 */
export const MOCK_EXEC_MODE_MS: Record<ExecMode, [number, number]> = {
  now: [1_000, 3_000],
  delayed: [8_000, 15_000],
  max: [25_000, 45_000],
};
const TRADE_OPS = new Set(["buy", "sell", "create"]);
const WITHDRAW_OPS = new Set(["withdraw_token", "withdraw_zec"]);

function execDelay(action: SignedAction, padOnly = false): [number, number] {
  const pad = (action as { pad?: unknown }).pad;
  if (pad !== undefined && (typeof pad !== "string" || pad.length > 8192)) throw new ApiError("bad_request", "pad: expected a string", 400);
  if (padOnly) return [0, 0];
  const mode = "exec" in action ? action.exec : undefined;
  if (mode === undefined) return EXEC_DELAY_MS[action.op] ?? [5_000, 10_000];
  if (!isExecMode(mode)) throw new ApiError("bad_request", 'exec: expected "now" | "delayed" | "max"', 400);
  if (WITHDRAW_OPS.has(action.op)) {
    // Withdrawals are never instant: that would link a trade to the receiving address on-chain.
    if (mode === "now") throw new ApiError("bad_request", "exec: withdrawals take delayed | max", 400);
    return mode === "max" ? MOCK_EXEC_MODE_MS.max : EXEC_DELAY_MS[action.op];
  }
  if (!TRADE_OPS.has(action.op)) throw new ApiError("bad_request", `exec is not allowed for ${action.op}`, 400);
  return MOCK_EXEC_MODE_MS[mode];
}

interface MockAction {
  id: string;
  network: Network;
  pubkey: string;
  nonceKey: string;
  bodyHash: string;
  action: SignedAction;
  receipt: ActionReceipt;
  status: ActionStatus;
  /** What is reserved until execution. */
  holdZat: bigint;
  holdToken?: { mint: string; amount: bigint };
  /** fl_* ops: kept for nonce idempotency only, never listed in Portfolio.actions (v0.6). */
  hidden?: boolean;
}

const actions = new Map<string, MockAction>();
const byNonce = new Map<string, string>(); // nonceKey -> action id

const isUint = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,18})$/.test(v);
function amountOf(v: unknown, field: string, positive = true): bigint {
  if (!isUint(v)) throw new ApiError("bad_request", `${field}: expected an integer string in base units`, 400);
  const b = BigInt(v);
  if (positive && b === N0) throw new ApiError("bad_request", `${field} must be > 0`, 400);
  return b;
}

function holdingOf(a: MockAccount, mint: string) {
  let h = a.holdings.find((x) => x.mint === mint);
  if (!h) {
    h = { mint, amount: "0", held: "0" };
    a.holdings.push(h);
  }
  return h;
}

function tidyHoldings(a: MockAccount) {
  a.holdings = a.holdings.filter((h) => h.amount !== "0" || h.held !== "0");
}

function tradeToken(mint: string, venue: string): MockTokenState {
  if (!["pumpfun", "meteora-dbc", "jupiter"].includes(venue)) throw new ApiError("bad_request", "venue: expected pumpfun | meteora-dbc | jupiter", 400);
  if (!isSolanaAddress(mint)) throw new ApiError("bad_request", "mint: not a Solana address", 400);
  const s = findToken(mint);
  if (venue !== "jupiter" && s.token.venue !== venue) throw new ApiError("bad_request", `token trades on ${s.token.venue}, not ${venue}`, 400);
  if (s.token.status === "graduated" && venue !== "jupiter") throw new ApiError("graduated", "token left the bonding curve", 409);
  return s;
}

/** Validate and reserve. Throws exactly where core/ would answer non-2xx; nothing is held then. */
function accept(network: Network, pubkey: string, action: SignedAction): Omit<MockAction, "id" | "nonceKey" | "bodyHash"> {
  const pool = mockPool(network);
  const minAction = BigInt(pool.minActionZat);
  const a = account(network, pubkey);
  if (a.frozen) throw new ApiError("balance_frozen", "balance frozen", 423);
  const base = { network, pubkey, action, holdZat: N0 } as const;
  const queued = (rate?: RateUsed): { receipt: ActionReceipt; status: ActionStatus } => ({
    receipt: { id: "", status: "queued", ...(rate ? { rate } : {}) },
    status: { status: "queued", ...(rate ? { rate } : {}) },
  });

  switch (action.op) {
    case "buy": {
      const zecIn = amountOf(action.zecIn, "zecIn");
      amountOf(action.minOut, "minOut", false);
      if (zecIn < minAction) throw new ApiError("below_minimum", "zecIn below PoolInfo.minActionZat", 422);
      tradeToken(action.mint, action.venue);
      if (a.zecBalance < zecIn) throw new ApiError("insufficient_balance", "not enough ZEC", 422);
      a.zecBalance -= zecIn;
      a.zecHeld += zecIn;
      return { ...base, holdZat: zecIn, ...queued(mockRate(true)) };
    }
    case "sell": {
      const amount = amountOf(action.amount, "amount");
      const minZecOut = amountOf(action.minZecOut, "minZecOut", false);
      const s = tradeToken(action.mint, action.venue);
      const rate = mockRate(false);
      const est = (BigInt(Math.floor(Number(formatUnitsNum(amount, s.token.decimals)) * s.price * 1e9)) * ZAT) / BigInt(rate.lamportsPerZec);
      if (minZecOut < minAction && est < minAction)
        throw new ApiError("below_minimum", "sell value below PoolInfo.minActionZat (raise amount or minZecOut)", 422);
      const h = holdingOf(a, action.mint);
      if (BigInt(h.amount) < amount) throw new ApiError("insufficient_balance", "not enough tokens", 422);
      h.amount = (BigInt(h.amount) - amount).toString();
      h.held = (BigInt(h.held) + amount).toString();
      return { ...base, holdToken: { mint: action.mint, amount }, ...queued(rate) };
    }
    case "create": {
      const initial = action.initialBuyZec === undefined ? N0 : amountOf(action.initialBuyZec, "initialBuyZec", false);
      if (action.venue === "jupiter") throw new ApiError("bad_request", "create: jupiter is not a launchpad", 400);
      if (!CREATE_ENABLED) throw new ApiError("venue_unavailable", "create is not enabled", 503);
      if (initial > N0 && initial < minAction) throw new ApiError("below_minimum", "initialBuyZec below PoolInfo.minActionZat", 422);
      if ((initial * BigInt(mockRate(true).lamportsPerZec)) / ZAT > mockVenueCap(action.venue)) throw new ApiError("creator_cap", "initial buy above launchRules.maxInitialBuyLamportsByVenue", 422);
      const total = initial + CREATE_FEE_ZAT;
      if (a.zecBalance < total) throw new ApiError("insufficient_balance", "not enough ZEC", 422);
      a.zecBalance -= total;
      a.zecHeld += total;
      return { ...base, holdZat: total, ...queued(mockRate(true)) };
    }
    case "withdraw_zec": {
      const v = checkWithdrawUa(String(action.to ?? ""), network);
      if (!v.ok) throw new ApiError("bad_request", `to: ${v.reason}`, 400);
      const amount = amountOf(action.amount, "amount");
      if (amount < minAction) throw new ApiError("below_minimum", "amount below PoolInfo.minActionZat", 422);
      const total = amount + WITHDRAW_ZEC_FEE_ZAT;
      if (a.zecBalance < total) throw new ApiError("insufficient_balance", "not enough ZEC", 422);
      a.zecBalance -= total;
      a.zecHeld += total;
      return { ...base, holdZat: total, ...queued() };
    }
    case "withdraw_token": {
      if (!isSolanaAddress(action.mint)) throw new ApiError("bad_request", "mint: not a Solana address", 400);
      const amount = amountOf(action.amount, "amount");
      const dests = Array.isArray(action.to) ? action.to : [action.to];
      const parts = action.smart ? action.smart.parts : 1;
      if (action.smart && (!(parts >= 2 && parts <= 5) || !(action.smart.maxDelayMin >= 1 && action.smart.maxDelayMin <= 1440)))
        throw new ApiError("bad_request", "smart: parts 2..5, maxDelayMin 1..1440", 400);
      if (dests.length !== parts) throw new ApiError("bad_request", "to: one address per part (length of `to` = smart.parts)", 400);
      if (dests.some((d) => typeof d !== "string" || !isSolanaAddress(d))) throw new ApiError("bad_request", "to: not a Solana address", 400);
      if (new Set(dests).size !== dests.length) throw new ApiError("bad_request", "to: addresses must be distinct", 400);
      if (amount < BigInt(parts)) throw new ApiError("bad_request", "amount smaller than the number of parts", 400);
      const rate = mockRate(true);
      const lamports = BigInt(parts) * WITHDRAW_TOKEN_LAMPORTS_PER_PART;
      const fee = (lamports * ZAT + BigInt(rate.lamportsPerZec) - BigInt(1)) / BigInt(rate.lamportsPerZec);
      const h = a.holdings.find((x) => x.mint === action.mint);
      if (!h || BigInt(h.amount) < amount) throw new ApiError("insufficient_balance", "not enough tokens", 422);
      if (a.zecBalance < fee) throw new ApiError("insufficient_balance", "not enough ZEC for gas", 422);
      a.zecBalance -= fee;
      a.zecHeld += fee;
      h.amount = (BigInt(h.amount) - amount).toString();
      h.held = (BigInt(h.held) + amount).toString();
      return { ...base, holdZat: fee, holdToken: { mint: action.mint, amount }, ...queued(rate) };
    }
    default:
      throw new ApiError("bad_request", "op not supported yet", 400);
  }
}

const formatUnitsNum = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;

function releaseZat(a: MockAccount, act: MockAction, spent: bigint) {
  a.zecHeld -= act.holdZat;
  a.zecBalance += act.holdZat - spent;
}

function releaseTokens(a: MockAccount, act: MockAction, consumed: bigint) {
  if (!act.holdToken) return;
  const h = holdingOf(a, act.holdToken.mint);
  h.held = (BigInt(h.held) - act.holdToken.amount).toString();
  h.amount = (BigInt(h.amount) + act.holdToken.amount - consumed).toString();
}

function fail(act: MockAction, a: MockAccount, error: ActionStatus["error"]) {
  releaseZat(a, act, N0);
  releaseTokens(a, act, N0);
  act.status = { status: "failed", error, rate: act.status.rate };
  settleOrderOf(act);
}

/** The relayer: executes one queued action and publishes the trade like any other vault trade. */
function execute(act: MockAction) {
  if (act.status.status !== "queued") return;
  const a = account(act.network, act.pubkey);
  const x = act.action;
  const tx = b58(88);
  const rate = act.status.rate;
  const now = Date.now();

  if (x.op === "buy") {
    const s = findToken(x.mint);
    const lamports = (BigInt(x.zecIn) * BigInt(rate!.lamportsPerZec)) / ZAT;
    const sol = Number(lamports) / 1e9;
    const out = BigInt(toBaseUnits(sol / s.price, s.token.decimals));
    if (out < BigInt(x.minOut)) return fail(act, a, "slippage");
    releaseZat(a, act, act.holdZat);
    const h = holdingOf(a, x.mint);
    h.amount = (BigInt(h.amount) + out).toString();
    s.heat = Math.max(s.heat, 1);
    s.price *= 1 + sol / Math.max(30, s.price * s.supply) / 2;
    syncTokenFields();
    publish({ id: b58(16), kind: "buy", venue: s.token.venue, mint: s.token.mint, symbol: s.token.symbol, tokenAmount: out.toString(), solAmount: lamports.toString(), decimals: s.token.decimals, solanaTx: tx, ts: now });
    act.status = { status: "executed", executedAt: Math.floor(now / 60_000) * 60_000, solanaTx: tx, rate, fill: { tokenAmount: out.toString(), solAmount: lamports.toString(), zecSpent: x.zecIn } };
  } else if (x.op === "sell") {
    const s = findToken(x.mint);
    const amount = BigInt(x.amount);
    const sol = formatUnitsNum(amount, s.token.decimals) * s.price;
    const lamports = BigInt(Math.floor(sol * 1e9));
    const zec = (lamports * ZAT) / BigInt(rate!.lamportsPerZec);
    if (zec < BigInt(x.minZecOut)) return fail(act, a, "slippage");
    releaseTokens(a, act, amount);
    a.zecBalance += zec;
    s.price *= 1 - sol / Math.max(30, s.price * s.supply) / 2;
    syncTokenFields();
    publish({ id: b58(16), kind: "sell", venue: s.token.venue, mint: s.token.mint, symbol: s.token.symbol, tokenAmount: amount.toString(), solAmount: lamports.toString(), decimals: s.token.decimals, solanaTx: tx, ts: now });
    act.status = { status: "executed", executedAt: Math.floor(now / 60_000) * 60_000, solanaTx: tx, rate, fill: { tokenAmount: amount.toString(), solAmount: lamports.toString(), zecCredited: zec.toString() } };
  } else if (x.op === "create") {
    const initial = act.holdZat - CREATE_FEE_ZAT;
    const lamports = (initial * BigInt(rate!.lamportsPerZec)) / ZAT;
    const venue: Venue = x.venue;
    const price = 2.8e-8;
    const s: MockTokenState = {
      token: { mint: mintFor(venue, x.meta.symbol + ":" + act.id), symbol: x.meta.symbol, name: x.meta.name, image: x.meta.image, venue, status: "curve", decimals: DECIMALS[venue], priceSol: "0", marketCapSol: "0", createdAt: now },
      price,
      supply: SUPPLY,
      heat: 3,
    };
    state!.push(s);
    unzeenLaunches.add(s.token.mint);
    syncTokenFields();
    const out = lamports > N0 ? BigInt(toBaseUnits(Number(lamports) / 1e9 / price, s.token.decimals)) : N0;
    // Launch buy locked for launchRules.lockSecs (end rounded up to the hour).
    creators.set(s.token.mint, { network: act.network, pubkey: act.pubkey, lockedAmount: out, lockUntil: Math.ceil((now + 86_400_000) / 3_600_000) * 3_600_000, claimed: N0 });
    releaseZat(a, act, act.holdZat);
    if (out > N0) holdingOf(a, s.token.mint).amount = out.toString();
    publish({ id: b58(16), kind: "create", venue, mint: s.token.mint, symbol: s.token.symbol, tokenAmount: out.toString(), solAmount: lamports.toString(), decimals: s.token.decimals, solanaTx: tx, ts: now });
    act.status = { status: "executed", executedAt: Math.floor(now / 60_000) * 60_000, solanaTx: tx, rate, fill: { tokenAmount: out.toString(), solAmount: lamports.toString(), zecSpent: initial.toString(), mint: s.token.mint } };
  } else if (x.op === "withdraw_token") {
    // Separate transfers from another vault; not a trade, so nothing in the feed.
    releaseZat(a, act, act.holdZat);
    releaseTokens(a, act, act.holdToken!.amount);
    act.status = { status: "executed", executedAt: Math.floor(now / 60_000) * 60_000, solanaTx: tx, rate, fill: { tokenAmount: x.amount } };
  } else if (x.op === "withdraw_zec") {
    releaseZat(a, act, act.holdZat);
    act.status = { status: "executed" };
  }
  tidyHoldings(a);
  settleOrderOf(act);
}

function submit(network: Network, method: "POST", path: string, body: string | undefined, headers: Partial<SignedHeaders>): ActionReceipt {
  const { pubkey, nonceKey, now } = verify(network, method, path, body, headers);
  const hash = bodyHash(body);
  const prior = byNonce.get(nonceKey);
  if (prior) {
    // Same signed request again (retry after a timeout): the original receipt. Other body: replay.
    const act = actions.get(prior)!;
    if (act.bodyHash !== hash) throw new ApiError("replay", "nonce already used", 409);
    return act.receipt;
  }
  if (seenNonces.has(nonceKey)) throw new ApiError("replay", "nonce already used", 409);
  let action: SignedAction | null = null;
  try {
    action = body ? (JSON.parse(body) as SignedAction) : null;
  } catch {
    /* handled below */
  }
  if (!action?.op) throw new ApiError("bad_request", "op required", 400);
  if (UNSUPPORTED_OPS.has(action.op)) throw new ApiError("bad_request", "op not supported yet", 400);
  if (process.env.NEXT_PUBLIC_MOCK_FAIR_LAUNCH === "1" && fair && action.op.startsWith("fl_")) {
    execDelay({ op: "fl", pad: (action as { pad?: unknown }).pad } as unknown as SignedAction, true);
    const receipt = fair.submit(network, pubkey, action);
    seenNonces.set(nonceKey, now + 120_000);
    const act: MockAction = { id: receipt.id, network, pubkey, action, nonceKey, bodyHash: hash, receipt, status: { status: receipt.status as ActionStatus["status"] }, holdZat: N0, hidden: true };
    actions.set(receipt.id, act);
    byNonce.set(nonceKey, receipt.id);
    return receipt;
  }
  if (LEDGER_OPS.has(action.op)) {
    execDelay(action, true); // pad check only: ledger ops have no batch
    const r = ledgerOp(network, pubkey, action, now);
    seenNonces.set(nonceKey, now + 120_000);
    const act: MockAction = { ...r.act, id: r.receipt.id, network, pubkey, action, nonceKey, bodyHash: hash, receipt: r.receipt };
    // Orders are kept for nonce idempotency only (not in Portfolio.actions, not under GET /api/actions/:id).
    const key = act.hidden ? `ledger:${nonceKey}` : act.id;
    actions.set(key, act);
    byNonce.set(nonceKey, key);
    return r.receipt;
  }
  const [lo, hi] = execDelay(action);
  // Rejected actions do not burn the nonce (docs/API.md).
  const accepted = accept(network, pubkey, action);
  seenNonces.set(nonceKey, now + 120_000);
  const id = hex16(); // 128 random bits, hex (docs/API.md)
  const act: MockAction = { ...accepted, id, nonceKey, bodyHash: hash, receipt: { ...accepted.receipt, id } };
  actions.set(id, act);
  byNonce.set(nonceKey, id);
  setTimeout(() => execute(act), rand(lo, hi));
  return act.receipt;
}

// ---- private orders (v0.8) and creator fees (v0.7 claim) ----

const ORDER_PARAMS: OrdersParams = {
  kinds: ["limit_buy", "limit_sell", "take_profit", "stop_loss"],
  venues: ["pumpfun"],
  maxOpenPerKey: 10,
  maxOpenPerMint: 4,
  maxTtlSecs: 259_200,
  defaultTtlSecs: 86_400,
  defaultSlippageBps: { limit_buy: 500, limit_sell: 500, take_profit: 500, stop_loss: 1500 },
  slConfirmTicks: 2,
  priceTick: { minSecs: 45, maxSecs: 75 },
};
const ORDER_KINDS = new Set<string>(ORDER_PARAMS.kinds);
const SELL_KINDS = new Set<OrderKind>(["limit_sell", "take_profit", "stop_loss"]);
const HOUR = 3_600_000;
/** Closed orders stay in Portfolio.orders for 24 h (D1), then their amounts and price are erased. */
const ORDER_KEEP_MS = 24 * HOUR;

/**
 * Indexer price tick (core: every 45-75 s over all pool tokens at once, independent of orders),
 * compressed for the demo. Orders are checked once per tick; stop-loss needs 2 ticks in a row.
 */
export const MOCK_ORDER_TICK_MS = 10_000;
/** Pool-wide creator-fee collector (core: every 6-12 h), compressed for the demo. */
export const MOCK_FEE_SWEEP_MS = 30_000;
/** Creator fee share of each trade on a token launched through the pool (mock figure). */
const CREATOR_FEE_BPS = BigInt(30);

interface MockOrder {
  pub: Order;
  network: Network;
  pubkey: string;
  /** ms when it left `open`/`triggered` (for the 24 h retention). */
  closedAt?: number;
}

const orders = new Map<string, MockOrder>();
/** Mints launched through the pool -> their (anonymous) creator key. Never exposed publicly. */
const creators = new Map<string, { network: Network; pubkey: string; lockedAmount: bigint; lockUntil: number; claimed: bigint }>();
/** Fees earned since the last collector run, per mint. */
const pendingFees = new Map<string, bigint>();
let lastOrderTick: number | null = null;
let lastSweep: number | null = null;

const DECIMAL_RE = /^(0|[1-9]\d*)(\.\d+)?$/;
function sigDigits(v: string): number {
  return v.replace(".", "").replace(/^0+/, "").replace(/0+$/, "").length;
}

function ordersOf(network: Network, pubkey: string, now: number): Order[] {
  const live = (o: MockOrder) => o.pub.status === "open" || o.pub.status === "triggered";
  return [...orders.values()]
    .filter((o) => o.network === network && o.pubkey === pubkey && (live(o) || now - (o.closedAt ?? now) < ORDER_KEEP_MS))
    .sort((a, b) => Number(live(b)) - Number(live(a)) || b.pub.createdAt - a.pub.createdAt)
    .slice(0, 20)
    .map((o) => structuredClone(o.pub));
}

function releaseOrder(o: MockOrder) {
  const a = account(o.network, o.pubkey);
  if (o.pub.kind === "limit_buy") {
    const v = BigInt(o.pub.amount);
    a.zecHeld -= v;
    a.zecBalance += v;
  } else {
    const h = holdingOf(a, o.pub.mint);
    h.held = (BigInt(h.held) - BigInt(o.pub.amount)).toString();
    h.amount = (BigInt(h.amount) + BigInt(o.pub.amount)).toString();
  }
}

function closeOrder(o: MockOrder, status: Order["status"], now: number, error?: Order["error"]) {
  o.pub.status = status;
  delete o.pub.armed;
  if (error) o.pub.error = error;
  o.closedAt = now;
}

/** Value of `amount` base units at `priceSol`, lamports (floor). */
function lamportsAt(amount: bigint, decimals: number, priceSol: number): bigint {
  return BigInt(Math.floor((Number(amount) / 10 ** decimals) * priceSol * 1e9));
}

function createOrder(network: Network, pubkey: string, x: Extract<SignedAction, { op: "order_create" }>, now: number): MockOrder {
  const pool = mockPool(network);
  if (x.venue !== "pumpfun") throw new ApiError("bad_request", "venue: orders are pumpfun only", 400);
  if (!ORDER_KINDS.has(x.kind)) throw new ApiError("bad_request", "kind: limit_buy | limit_sell | take_profit | stop_loss", 400);
  if (!isSolanaAddress(String(x.mint))) throw new ApiError("bad_request", "mint: not a Solana address", 400);
  const t = String(x.triggerPriceSol ?? "");
  if (!DECIMAL_RE.test(t) || !(Number(t) > 0) || sigDigits(t) > 18) throw new ApiError("bad_request", "triggerPriceSol: positive decimal, <= 18 significant digits", 400);
  const amount = amountOf(x.amount, "amount");
  const slippageBps = x.slippageBps ?? ORDER_PARAMS.defaultSlippageBps[x.kind];
  if (!Number.isInteger(slippageBps) || slippageBps < 50 || slippageBps > 5000) throw new ApiError("bad_request", "slippageBps: 50..5000", 400);
  const ttl = x.ttlSecs ?? ORDER_PARAMS.defaultTtlSecs;
  if (!Number.isInteger(ttl) || ttl < 3600 || ttl > ORDER_PARAMS.maxTtlSecs) throw new ApiError("bad_request", `ttlSecs: 3600..${ORDER_PARAMS.maxTtlSecs}`, 400);
  const exec = x.exec ?? "delayed";
  if (exec !== "delayed" && exec !== "max") throw new ApiError("bad_request", 'exec: orders take "delayed" | "max"', 400);
  // Only mints the pool already trades (public GET /api/tokens), on the pump.fun curve.
  const s = state!.find((y) => y.token.mint === x.mint);
  if (!s || s.heat === 0 || s.token.venue !== "pumpfun" || s.token.status !== "curve") throw new ApiError("order_unsupported_mint", "mint not supported for orders", 422);
  const a = account(network, pubkey);
  if (a.frozen) throw new ApiError("balance_frozen", "balance frozen", 423);
  const open = [...orders.values()].filter((o) => o.network === network && o.pubkey === pubkey && o.pub.status === "open");
  if (open.length >= ORDER_PARAMS.maxOpenPerKey || open.filter((o) => o.pub.mint === x.mint).length >= ORDER_PARAMS.maxOpenPerMint)
    throw new ApiError("order_limit", "too many open orders", 422);
  const minAction = BigInt(pool.minActionZat);
  if (x.kind === "limit_buy") {
    if (amount < minAction) throw new ApiError("below_minimum", "amount below PoolInfo.minActionZat", 422);
    if (a.zecBalance < amount) throw new ApiError("insufficient_balance", "not enough ZEC", 422);
    a.zecBalance -= amount;
    a.zecHeld += amount;
  } else {
    const value = (lamportsAt(amount, s.token.decimals, Number(t)) * ZAT) / BigInt(mockRate(false).lamportsPerZec);
    if (value < minAction) throw new ApiError("below_minimum", "amount × trigger below PoolInfo.minActionZat", 422);
    const h = holdingOf(a, x.mint);
    if (BigInt(h.amount) < amount) {
      tidyHoldings(a);
      throw new ApiError("insufficient_balance", "not enough tokens", 422);
    }
    h.amount = (BigInt(h.amount) - amount).toString();
    h.held = (BigInt(h.held) + amount).toString();
  }
  const o: MockOrder = {
    network,
    pubkey,
    pub: {
      id: hex16(),
      venue: "pumpfun",
      mint: x.mint,
      kind: x.kind,
      triggerPriceSol: t,
      amount: amount.toString(),
      slippageBps,
      exec,
      status: "open",
      createdAt: Math.floor(now / 60_000) * 60_000,
      expiresAt: Math.ceil((now + ttl * 1000) / HOUR) * HOUR,
    },
  };
  orders.set(o.pub.id, o);
  return o;
}

/** Ledger-only ops: no batch, no chain. Throws exactly where core/ would answer non-2xx. */
function ledgerOp(network: Network, pubkey: string, x: SignedAction, now: number): { receipt: ActionReceipt; act: Pick<MockAction, "status" | "holdZat" | "hidden"> } {
  if (x.op === "order_create") {
    const o = createOrder(network, pubkey, x, now);
    return { receipt: { id: o.pub.id, status: "open" }, act: { status: { status: "queued" }, holdZat: N0, hidden: true } };
  }
  if (x.op === "order_cancel") {
    const o = orders.get(String(x.orderId));
    if (!o || o.network !== network || o.pubkey !== pubkey) throw new ApiError("not_found", "unknown order", 404);
    if (o.pub.status !== "open") throw new ApiError("order_not_open", `order is ${o.pub.status}`, 409);
    releaseOrder(o);
    closeOrder(o, "cancelled", now);
    tidyHoldings(account(network, pubkey));
    return { receipt: { id: o.pub.id, status: "cancelled" }, act: { status: { status: "queued" }, holdZat: N0, hidden: true } };
  }
  if (x.op === "claim") {
    if (x.mint !== undefined && !isSolanaAddress(String(x.mint))) throw new ApiError("bad_request", "mint: not a Solana address", 400);
    const a = account(network, pubkey);
    if (a.frozen) throw new ApiError("balance_frozen", "balance frozen", 423);
    const mints = x.mint === undefined ? [...a.claimable.keys()] : [x.mint];
    const lamports = mints.reduce((sum, m) => sum + (a.claimable.get(m) ?? N0), N0);
    const rate = mockRate(false);
    const zat = (lamports * ZAT) / BigInt(rate.lamportsPerZec);
    if (zat === N0 || zat < BigInt(mockPool(network).minActionZat)) throw new ApiError("below_minimum", "nothing to claim above PoolInfo.minActionZat", 422);
    for (const m of mints) {
      const c = creators.get(m);
      if (c && c.network === network && c.pubkey === pubkey) c.claimed += a.claimable.get(m) ?? N0;
      a.claimable.delete(m);
    }
    a.zecBalance += zat;
    const id = hex16();
    return {
      receipt: { id, status: "executed", rate },
      act: { status: { status: "executed", executedAt: Math.floor(now / 60_000) * 60_000, rate }, holdZat: N0 },
    };
  }
  throw new ApiError("bad_request", "op not supported yet", 400);
}
const LEDGER_OPS = new Set(["order_create", "order_cancel", "claim"]);

/** One indexer tick: check every open order against the pool's current prices. */
function orderTick(now: number) {
  for (const o of orders.values()) {
    if (o.pub.status !== "open") continue;
    if (now >= o.pub.expiresAt) {
      releaseOrder(o);
      closeOrder(o, "expired", now);
      tidyHoldings(account(o.network, o.pubkey));
      continue;
    }
    const s = state!.find((y) => y.token.mint === o.pub.mint);
    if (!s) continue;
    if (s.token.status === "graduated") {
      releaseOrder(o);
      closeOrder(o, "failed", now, "graduated");
      tidyHoldings(account(o.network, o.pubkey));
      continue;
    }
    const trigger = Number(o.pub.triggerPriceSol);
    const p = s.price;
    const hit = o.pub.kind === "limit_buy" || o.pub.kind === "stop_loss" ? p <= trigger : p >= trigger;
    if (o.pub.kind === "stop_loss") {
      if (!hit) {
        delete o.pub.armed;
        continue;
      }
      if (!o.pub.armed) {
        o.pub.armed = true; // confirmed only on the next tick in a row
        continue;
      }
    } else if (!hit) continue;
    fireOrder(o, s);
  }
}

/** The order becomes an ordinary buy/sell in the next batch; the hold moves over unchanged. */
function fireOrder(o: MockOrder, s: MockTokenState) {
  const slip = o.pub.slippageBps / 10_000;
  const trigger = Number(o.pub.triggerPriceSol);
  const amount = BigInt(o.pub.amount);
  let action: SignedAction;
  let rate: RateUsed;
  if (o.pub.kind === "limit_buy") {
    rate = mockRate(true);
    const lamports = (amount * BigInt(rate.lamportsPerZec)) / ZAT;
    const minOut = BigInt(Math.floor((Number(lamports) / 1e9 / (trigger * (1 + slip))) * 10 ** s.token.decimals));
    action = { op: "buy", venue: "pumpfun", mint: o.pub.mint, zecIn: o.pub.amount, minOut: minOut.toString(), exec: o.pub.exec };
  } else {
    rate = mockRate(false);
    const minLamports = BigInt(Math.floor(Number(lamportsAt(amount, s.token.decimals, trigger)) * (1 - slip)));
    action = { op: "sell", venue: "pumpfun", mint: o.pub.mint, amount: o.pub.amount, minZecOut: ((minLamports * ZAT) / BigInt(rate.lamportsPerZec)).toString(), exec: o.pub.exec };
  }
  const id = hex16();
  const act: MockAction = {
    id,
    network: o.network,
    pubkey: o.pubkey,
    nonceKey: "",
    bodyHash: "",
    action,
    receipt: { id, status: "queued", rate },
    status: { status: "queued", rate },
    holdZat: o.pub.kind === "limit_buy" ? amount : N0,
    ...(SELL_KINDS.has(o.pub.kind) ? { holdToken: { mint: o.pub.mint, amount } } : {}),
  };
  actions.set(id, act);
  delete o.pub.armed;
  o.pub.status = "triggered";
  o.pub.actionId = id;
  setTimeout(() => execute(act), rand(...MOCK_EXEC_MODE_MS[o.pub.exec]));
}

/** The trade an order turned into has settled: the order follows it. */
function settleOrderOf(act: MockAction) {
  for (const o of orders.values()) {
    if (o.pub.actionId !== act.id || o.pub.status !== "triggered") continue;
    if (act.status.status === "executed") closeOrder(o, "filled", Date.now());
    else if (act.status.status === "failed") closeOrder(o, "failed", Date.now(), act.status.error);
  }
}

/** Creator fee of a trade on a token launched through the pool: pending until the collector runs. */
function accrueCreatorFee(ev: FeedEvent) {
  if (ev.kind === "create" || !creators.has(ev.mint)) return;
  const fee = (BigInt(ev.solAmount) * CREATOR_FEE_BPS) / BigInt(10_000);
  if (fee > N0) pendingFees.set(ev.mint, (pendingFees.get(ev.mint) ?? N0) + fee);
}

/** The pool's global collector: moves pending fees to the creators' claimable balances. */
function sweepFees() {
  for (const [mint, fee] of pendingFees) {
    const c = creators.get(mint);
    if (!c) continue;
    const a = account(c.network, c.pubkey);
    a.claimable.set(mint, (a.claimable.get(mint) ?? N0) + fee);
  }
  pendingFees.clear();
}

/** Fixed schedules, independent of requests: price ticks for orders, the fee collector. */
function catchUpTicks(now: number) {
  const tick = Math.floor(now / MOCK_ORDER_TICK_MS);
  if (lastOrderTick === null || tick < lastOrderTick) lastOrderTick = tick;
  // At most a few missed ticks are replayed (the price did not move in between anyway).
  for (let i = 0; i < Math.min(tick - lastOrderTick, 3); i++) orderTick(now);
  lastOrderTick = tick;
  const sweep = Math.floor(now / MOCK_FEE_SWEEP_MS);
  if (lastSweep !== null && sweep > lastSweep) sweepFees();
  lastSweep = sweep;
}

/** GET /api/creator (v0.9): the key's own launches only, padded to a multiple of 4096 bytes. */
function creatorCabinet(network: Network, pubkey: string, now: number): CreatorCabinet {
  const a = account(network, pubkey);
  const tokens: CreatorToken[] = [];
  for (const [mint, c] of creators) {
    if (c.network !== network || c.pubkey !== pubkey) continue;
    const st = state!.find((y) => y.token.mint === mint);
    if (!st) continue;
    const t = st.token;
    const trades = history.filter((e) => e.mint === mint && e.kind !== "create");
    const h = a.holdings.find((x) => x.mint === mint);
    const rnd = seeded("holders:" + mint);
    const locked = now < c.lockUntil ? c.lockedAmount : N0;
    tokens.push({
      mint,
      symbol: t.symbol,
      name: t.name,
      image: t.image,
      decimals: t.decimals,
      venue: t.venue === "meteora-dbc" ? "meteora-dbc" : "pumpfun",
      status: t.status,
      ...(t.status === "curve" ? { curveProgressPct: pct(Math.min(99, 3 + (st.price / 2.8e-8 - 1) * 12)) } : {}),
      createdAt: t.createdAt,
      fees: { claimableLamports: (a.claimable.get(mint) ?? N0).toString(), claimedLamports: c.claimed.toString() },
      volumeLamports: trades.reduce((x, e) => x + BigInt(e.solAmount), N0).toString(),
      trades: trades.length,
      holders: trades.length === 0 ? null : 1 + Math.floor(trades.length * (1.5 + rnd())),
      holdersAsOf: Math.floor(now / 60_000) * 60_000,
      lock: { lockedAmount: locked.toString(), until: locked > N0 ? c.lockUntil : null },
      cap: {
        capBps: 500,
        capTokens: ((BigInt(toBaseUnits(SUPPLY, t.decimals)) * BigInt(500)) / BigInt(10_000)).toString(),
        positionTokens: (h ? BigInt(h.amount) + BigInt(h.held) : N0).toString(),
      },
    });
  }
  tokens.sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0));
  const out: CreatorCabinet = { tokens: tokens.slice(0, 50), pad: "" };
  const len = JSON.stringify(out).length;
  out.pad = " ".repeat(Math.ceil(len / 4096) * 4096 - len);
  return out;
}

/** TEST / DEMO: move a token's price (the indexer reads it on the next tick). */
export function mockSetPrice(mint: string, priceSol: number) {
  init(Date.now());
  findToken(mint).price = priceSol;
  syncTokenFields();
}

/** TEST / DEMO: credit creator fees straight to a key's claimable balance. */
export function mockCreditCreatorFees(network: Network, pubkey: string, mint: string, lamports: bigint) {
  init(Date.now());
  const a = account(network, pubkey);
  a.claimable.set(mint, (a.claimable.get(mint) ?? N0) + lamports);
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
  await loadFair();
  await delay(rand(120, 380));
  scan(Date.now());
  fair?.tick(Date.now());
  catchUpTicks(Date.now());
  const url = new URL(pathWithQuery, "http://mock.local");
  const p = url.pathname;
  const q = url.searchParams;
  let m: RegExpMatchArray | null;

  if (method === "GET") {
    if (p === "/api/feed") return history.slice(0, Math.min(Number(q.get("limit") ?? 50), 200));
    // Cold mints from CA searches stay out of the public list until unzeen trades them: listing them
    // would tell everyone what someone searched for.
    if (p === "/api/tokens") return state!.filter((s) => s.heat > 0).map((s) => ({ ...s.token }));
    if (p === "/api/stats") return stats(Date.now());

    if ((m = p.match(/^\/api\/tokens\/([^/]+)$/))) {
      const s = resolveMint(decodeURIComponent(m[1]));
      if ("status" in s) return s;
      const out: TokenWithTrades = { ...s.token, trades: history.filter((e) => e.mint === s.token.mint).slice(0, 50) };
      return out;
    }
    if ((m = p.match(/^\/api\/tokens\/([^/]+)\/safety$/))) {
      const s = resolveMint(decodeURIComponent(m[1]));
      if ("status" in s) return s;
      return safetyOf(s);
    }
    if ((m = p.match(/^\/api\/tokens\/([^/]+)\/trades$/)) && q.has("filter")) {
      const s = findToken(decodeURIComponent(m[1]));
      return tokenTrades(s, q.get("filter") ?? "all", q.get("before"), Number(q.get("limit") ?? 50));
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
    if (process.env.NEXT_PUBLIC_MOCK_FAIR_LAUNCH === "1" && fair && (p === "/api/launches" || p.startsWith("/api/launches/"))) return fair.get(network, p, q);
    if ((m = p.match(/^\/api\/actions\/([^/]+)$/))) {
      const pub = authorize(network, method, pathWithQuery, body, headers);
      const a = actions.get(decodeURIComponent(m[1]));
      if (!a || a.pubkey !== pub || a.network !== network) throw new ApiError("not_found", "unknown action", 404);
      return structuredClone(a.status);
    }
    if (p === "/api/portfolio") {
      // pubkey comes only from the signed header, never from the path.
      return portfolioOf(network, authorize(network, method, pathWithQuery, body, headers));
    }
    // Verify (v0.7): its own chunk, loaded on the first call.
    if (p === "/api/verify" || p.startsWith("/api/verify/")) return (await loadVerify()).get(network, pathWithQuery, headers);
    // v0.9: the creator's cabinet, padded so its size does not tell "creator" from "not".
    if (p === "/api/creator") return creatorCabinet(network, authorize(network, method, pathWithQuery, body, headers), Date.now());
  }

  if (method === "POST") {
    if (p === "/api/actions") return { ...submit(network, method, pathWithQuery, body, headers) };
  }

  throw new ApiError("not_found", `${method} ${p}`, 404);
}

// ---- token intel (DRAFT, docs/analysis/token-intel.md §5) ----

/** Mock twin of the backend flag: dev history, first blocks and the full trade feed after the Helius upgrade. */
const FULL_FEED = process.env.NEXT_PUBLIC_MOCK_FULL_TRADES === "1";
/** Tokens launched through Unzeen ("rules enforced"). GHOST is one from the start. */
const unzeenLaunches = new Set<string>();
/** Cold mints from CA searches, waiting for the next tick. mint -> tick it resolves at. */
const coldQueue = new Map<string, number>();
/** Tick of the cold queue: fixed schedule, independent of requests (compressed from 60 s for the demo). */
export const MOCK_TICK_MS = 12_000;

/** Next tick boundary after `now`, with a per-tick jitter (0-3 s) that does not depend on who asks. */
export function nextTick(now: number): number {
  let i = Math.floor(now / MOCK_TICK_MS);
  for (;;) {
    const at = i * MOCK_TICK_MS + Math.floor(seeded(`tick:${i}`)() * 3_000);
    if (at > now) return at;
    i++;
  }
}

const COLD_NAMES: Array<[string, string]> = [
  ["DRIFT", "Driftwood"],
  ["MOON", "Moonless"],
  ["BONKY", "Bonky"],
  ["FOG", "Fog Machine"],
  ["KOI", "Night Koi"],
  ["RAVEN", "Raven"],
];

/** Known token, or the shared 202 pending of a cold mint until its tick (same answer for everyone). */
function resolveMint(mint: string): MockTokenState | PendingResponse {
  if (!isSolanaAddress(mint)) throw new ApiError("bad_request", "mint: not base58 of 32 bytes", 400);
  const known = state!.find((x) => x.token.mint === mint);
  if (known) return known;
  const now = Date.now();
  let at = coldQueue.get(mint);
  if (at === undefined) {
    at = nextTick(now);
    coldQueue.set(mint, at);
  }
  if (now < at) return { status: "pending", retryAfterMs: at - now };
  coldQueue.delete(mint);
  const rnd = seeded("cold:" + mint);
  const [symbol, name] = COLD_NAMES[Math.floor(rnd() * COLD_NAMES.length)];
  const s: MockTokenState = {
    token: { mint, symbol, name, venue: "pumpfun", status: "curve", decimals: 6, priceSol: "0", marketCapSol: "0", createdAt: at - Math.floor(rnd() * 6 * 3_600_000) },
    price: logRand(2e-8, 4e-7),
    supply: SUPPLY,
    heat: 0, // no unzeen trades until someone buys through the pool
  };
  state!.push(s);
  syncTokenFields();
  return s;
}

const pct = (n: number) => trimDecimals(n, n < 10 ? 2 : 1);

function safetyOf(s: MockTokenState): TokenSafety {
  const t = s.token;
  const rnd = seeded("safety:" + t.mint);
  const unzeen = unzeenLaunches.has(t.mint) || t.symbol === "GHOST";
  const risky = t.symbol === "VEIL";
  const now = Date.now();
  const asOf = Math.floor(now / 60_000) * 60_000; // tick boundary, not the time of the first request
  const out: TokenSafety = {
    mint: t.mint,
    asOf,
    program: t.venue === "pumpfun" || risky ? "token-2022" : "spl-token",
    authorities: {
      mintRevoked: !risky,
      freezeRevoked: !risky && rnd() > 0.05,
      metadataImmutable: risky ? false : true,
      riskyExtensions: risky ? ["transferFee", "permanentDelegate"] : [],
    },
    holders: {
      top10Pct: pct(unzeen ? 8 + rnd() * 10 : 12 + rnd() * 38),
      devPct: unzeen ? null : pct(rnd() * (risky ? 18 : 6)),
      unzeenPoolPct: pct(0.4 + rnd() * 6),
      asOf: asOf - 4 * 60_000,
    },
    market: {
      venue: t.venue,
      status: t.status,
      ...(t.status === "curve" ? { curveProgressPct: pct(4 + rnd() * 90) } : { lpBurnedPct: t.venue === "pumpfun" ? "100" : pct(40 + rnd() * 60) }),
    },
  };
  const handle = t.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (rnd() < 0.8 || unzeen) {
    out.socials = { twitter: `https://x.com/${handle}` };
    if (rnd() < 0.6) out.socials.telegram = `https://t.me/${handle}`;
    if (rnd() < 0.5) out.socials.website = `https://${handle}.xyz`;
  }
  if (unzeen) out.unzeen = { launch: true, rules: ["creator_initial_buy_locked_24h", "initial_buy_cap_5pct", "authorities_revoked"] };
  if (FULL_FEED) {
    if (!unzeen) out.dev = { address: mintFor(t.venue, "dev:" + t.symbol), launchesSeen: 1 + Math.floor(rnd() * 9), rugsSeen: Math.floor(rnd() * 3), since: Date.UTC(2026, 9, 10) };
    const snipers = unzeen ? 0 : Math.floor(rnd() * 7);
    const same = unzeen ? 0 : Math.floor(rnd() * 3);
    out.firstBlocks = { snipers, sniperPct: pct(snipers * rnd() * 1.5), sameSlotBuyers: same, sameSlotPct: pct(same * rnd() * 2), unzeenLaunchBuy: unzeen };
  }
  return out;
}

const WHALE_LAMPORTS = BigInt(1_000_000_000); // >= 1 SOL (the draft's floor)

/** Public (non-unzeen) trades of a mint, deterministic per mint and minute. Only with the full feed. */
function publicTrades(s: MockTokenState): TokenTrade[] {
  const t = s.token;
  const rnd = seeded("public:" + t.mint);
  const dev = unzeenLaunches.has(t.mint) || t.symbol === "GHOST" ? null : mintFor(t.venue, "dev:" + t.symbol);
  const traders = Array.from({ length: 9 }, (_, i) => mintFor(t.venue, `trader:${t.symbol}:${i}`));
  const out: TokenTrade[] = [];
  let ts = Date.now() - 45 * 60_000;
  for (let i = 0; i < 40; i++) {
    ts += 20_000 + rnd() * 60_000;
    const isDev = dev !== null && rnd() < 0.12;
    const sol = Number(trimDecimals(logRand(0.03, 9) * (rnd() < 0.1 ? 3 : 1), 2));
    const kind: FeedEvent["kind"] = rnd() < (isDev ? 0.4 : 0.65) ? "buy" : "sell";
    const lamports = toLamports(sol);
    const tags: TradeTag[] = [];
    if (BigInt(lamports) >= WHALE_LAMPORTS) tags.push("whale");
    if (isDev) tags.push("dev");
    out.push({
      id: `pub-${t.mint.slice(0, 6)}-${i}`,
      kind,
      venue: t.venue,
      mint: t.mint,
      symbol: t.symbol,
      tokenAmount: toBaseUnits(sol / s.price, t.decimals),
      solAmount: lamports,
      decimals: t.decimals,
      solanaTx: mintFor(t.venue, `tx:${t.mint}:${i}`) + mintFor(t.venue, `tx2:${i}`).slice(0, 44),
      ts: Math.min(ts, Date.now() - 1_000),
      trader: isDev && dev ? dev : traders[Math.floor(rnd() * traders.length)],
      tags,
    });
  }
  return out;
}

function tokenTrades(s: MockTokenState, filter: string, before: string | null, limit: number): TokenTrade[] {
  if (!["all", "unzeen", "whales", "dev"].includes(filter)) throw new ApiError("bad_request", "filter: all | unzeen | whales | dev", 400);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError("bad_request", "limit must be 1..200", 400);
  const f = filter as TradeFilter;
  if (!FULL_FEED && (f === "whales" || f === "dev")) throw new ApiError("feature_disabled", "filter needs the full trade feed", 400);
  const ours: TokenTrade[] = history
    .filter((e) => e.mint === s.token.mint)
    .map((e) => ({ ...e, trader: "unzeen", tags: BigInt(e.solAmount) >= WHALE_LAMPORTS ? (["whale"] as TradeTag[]) : [] }));
  let list = f === "unzeen" || !FULL_FEED ? ours : [...ours, ...publicTrades(s)].sort((a, b) => b.ts - a.ts);
  if (f === "whales") list = list.filter((x) => x.tags.includes("whale"));
  if (f === "dev") list = list.filter((x) => x.tags.includes("dev"));
  if (before) {
    const i = list.findIndex((x) => x.id === before);
    if (i < 0) throw new ApiError("not_found", "unknown trade id", 404);
    list = list.slice(i + 1);
  }
  return list.slice(0, limit);
}

// ---- WS /ws/feed[?mint=] (simulated) ----

const feedSubs = new Set<(e: FeedEvent) => void>();

/** A trade made by the mock relayer: into history and out to every open socket. */
function publish(ev: FeedEvent) {
  accrueCreatorFee(ev);
  history.unshift(ev);
  if (history.length > 1000) history.length = 1000;
  feedSubs.forEach((f) => f(ev));
}

export function subscribeFeed(onEvent: (e: FeedEvent) => void, mint?: string): () => void {
  init(Date.now());
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const own = (e: FeedEvent) => {
    if (!stopped && (!mint || e.mint === mint)) onEvent(e);
  };
  feedSubs.add(own);
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
    feedSubs.delete(own);
    clearTimeout(timer);
  };
}

// ---- fair-launch (v0.6), only in builds with NEXT_PUBLIC_MOCK_FAIR_LAUNCH=1 ----
// The flag is inlined at build time: without it the import below is dead code and lib/api/mock-fair.ts
// (and everything it pulls in) is not part of the bundle at all.

let fair: FairMock | null = null;
let fairLoading: Promise<void> | null = null;

function loadFair(): Promise<void> | void {
  if (process.env.NEXT_PUBLIC_MOCK_FAIR_LAUNCH !== "1") return;
  return (fairLoading ??= import("./mock-fair").then((m) => {
    fair = m.createFairMock(fairHost);
  }));
}

const FAIR_TOKEN_PRICE = 2.8e-8;

const fairHost: FairHost = {
  pool: (network) => mockPool(network),
  balance: (network, pubkey) => account(network, pubkey),
  buyRate: () => mockRate(true),
  creatorMaxLamports: MOCK_MAX_INITIAL_BUY_LAMPORTS.toString(),
  createFeeZat: CREATE_FEE_ZAT,
  b58: (len) => b58(len),
  launch(network, x) {
    void network;
    const now = Date.now();
    const venue: Venue = "pumpfun";
    const s: MockTokenState = {
      token: { mint: mintFor(venue, x.symbol + ":" + hex16()), symbol: x.symbol, name: x.name, image: x.image, venue, status: "curve", decimals: DECIMALS[venue], priceSol: "0", marketCapSol: "0", createdAt: now },
      price: FAIR_TOKEN_PRICE,
      supply: SUPPLY,
      heat: 3,
    };
    state!.push(s);
    unzeenLaunches.add(s.token.mint);
    const out = BigInt(toBaseUnits(Number(x.lamports) / 1e9 / FAIR_TOKEN_PRICE, s.token.decimals));
    s.price *= 1 + Number(x.lamports) / 1e9 / 60;
    syncTokenFields();
    const tx = b58(88);
    // One signature: create and the pooled buy land in the same transaction.
    publish({ id: b58(16), kind: "create", venue, mint: s.token.mint, symbol: s.token.symbol, tokenAmount: "0", solAmount: "0", decimals: s.token.decimals, solanaTx: tx, ts: now });
    publish({ id: b58(16), kind: "buy", venue, mint: s.token.mint, symbol: s.token.symbol, tokenAmount: out.toString(), solAmount: x.lamports.toString(), decimals: s.token.decimals, solanaTx: tx, ts: now });
    const price = out > N0 ? Number(x.lamports) / 1e9 / (Number(out) / 10 ** s.token.decimals) : FAIR_TOKEN_PRICE;
    return { mint: s.token.mint, tokenAmount: out, decimals: s.token.decimals, solanaTx: tx, priceSol: plain(price, 6) };
  },
  creditTokens(network, pubkey, mint, amount) {
    if (amount <= N0) return;
    const h = holdingOf(account(network, pubkey), mint);
    h.amount = (BigInt(h.amount) + amount).toString();
  },
};

// ---- Verify (v0.7): lazy chunk, real Merkle-sum trees over the mock accounts ----

let verifyMock: Promise<VerifyMock> | null = null;

function loadVerify(): Promise<VerifyMock> {
  return (verifyMock ??= import("./mock-verify").then((m) =>
    m.createVerifyMock({
      chainId: (network) => mockPool(network).chainId as "0202" | "0101",
      rateSell: () => BigInt(mockRate(false).lamportsPerZec),
      accounts(network) {
        const out: { pubkey: string; zat: bigint; tokens: { mint: string; amount: bigint }[]; claimLamports: bigint }[] = [];
        for (const [key, a] of accounts) {
          const [net, pubkey] = key.split(":");
          if (net !== network) continue;
          const claimLamports = [...a.claimable.values()].reduce((x, y) => x + y, N0);
          out.push({ pubkey, zat: a.zecBalance + a.zecHeld, tokens: a.holdings.map((h) => ({ mint: h.mint, amount: BigInt(h.amount) + BigInt(h.held) })), claimLamports });
        }
        return out;
      },
      tokens: () => (state ?? []).map((s) => ({ mint: s.token.mint, decimals: s.token.decimals })),
      authorize: (network, method, path, body, headers) => authorize(network, method, path, body, headers),
    }),
  ));
}

/** Mock of the devnet operator command `unzeen-api verify-snapshot`. Returns the new snapshot id. */
export async function mockTakeSnapshot(network: Network): Promise<number> {
  init(Date.now());
  return (await loadVerify()).takeSnapshot(network);
}
