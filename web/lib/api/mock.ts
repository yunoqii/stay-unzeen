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
import { isSolanaAddress, MIRROR_WINDOW_MS, PAYOUT_REVIEW_ABOVE_ZAT, sellMirrorsBuy } from "@/lib/trade";
import { checkWithdrawUa } from "@/lib/zcash/ua";
import { checkUnz1, decodeUnz1, type ChainId } from "@/lib/crypto/unz1";
import type { Network } from "@/lib/network";
import { memoText, parseZip321 } from "@/lib/zip321";
import { ApiError } from "./errors";
import { CHAT_OPS, createChatMock, mockChatParams } from "./mock-chat";
import type { FairHost, FairMock } from "./mock-fair";
import type { VerifyMock } from "./mock-verify";
import { ZEC_SPL_MINT } from "@/lib/quotes";
import type {
  ActionReceipt,
  ActionStatus,
  Candle,
  CreatorCabinet,
  CreatorToken,
  CandleTimeframe,
  DepositInfo,
  DiscoveryToken,
  ExecMode,
  FeedEvent,
  Order,
  OrderKind,
  WithdrawPart,
  OrdersParams,
  PlatformStats,
  PoolInfo,
  Portfolio,
  PendingResponse,
  LaunchPlatform,
  VenueInfo,
  Quote,
  QuoteAsset,
  RateUsed,
  SignedAction,
  SolRateUsed,
  Token,
  TokenListItem,
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
const DECIMALS: Record<Venue, number> = { pumpfun: 6, "meteora-dbc": 9, jupiter: 6, "raydium-launchlab": 6, bags: 6 };

// ---- non-SOL pairs (API v0.13–v0.14) ----

/** SOL per 1 unit of each quote in the mock market (ZEC = the pool's mid rate, dollars at $150/SOL). */
const SOL_PER_QUOTE: Record<Quote, number> = { SOL: 1, ZEC: 1.8, USDC: 1 / 150, USD1: 1 / 150 };
const Q_DECIMALS: Record<Quote, number> = { SOL: 9, ZEC: 8, USDC: 6, USD1: 6 };
/** ZEC SPL parity spread (core default UNZEEN_ZEC_SPL_SPREAD_BPS = 30). */
const ZEC_SPREAD_BPS = BigInt(30);
const USD1_MINT = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB";
/** devnet USDC: pump.fun and Raydium / Meteora use different mints (core known_quotes). */
const USDC_PUMP_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const USDC_DEVNET = "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT";
const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** NEXT_PUBLIC_MOCK_QUOTES=0: a server with only SOL pairs (PoolInfo.quotes empty). */
const QUOTES_ON = process.env.NEXT_PUBLIC_MOCK_QUOTES !== "0";

/** PoolInfo.quotes of the mock. Both networks get every pair so the UI can be exercised on devnet. */
/** v0.16 PoolInfo.venues: bags and jupiter are mainnet-only; bags takes SOL pairs, its first buy is not atomic. */
export function mockVenues(network: Network): VenueInfo[] {
  const main = network === "mainnet";
  const quotes = mockQuotes(network);
  const pairs = (v: Venue): Quote[] => ["SOL", ...(["ZEC", "USDC", "USD1"] as const).filter((q) => quotes.some((x) => x.quote === q && x.venues.includes(v)))];
  const pad = (v: Venue): VenueInfo => ({ venue: v, trade: true, create: CREATE_ENABLED, quotes: CREATE_ENABLED ? pairs(v) : [], atomicFirstBuy: true, creatorFees: true, mainnetOnly: false });
  return [
    pad("pumpfun"),
    pad("meteora-dbc"),
    pad("raydium-launchlab"),
    { venue: "bags", trade: main, create: main && CREATE_ENABLED, quotes: main && CREATE_ENABLED ? ["SOL"] : [], atomicFirstBuy: false, creatorFees: false, mainnetOnly: true },
    { venue: "jupiter", trade: main, create: false, quotes: [], atomicFirstBuy: true, creatorFees: false, mainnetOnly: true },
  ];
}

export function mockQuotes(network: Network): QuoteAsset[] {
  if (!QUOTES_ON) return [];
  const usdc: QuoteAsset[] =
    network === "mainnet"
      ? [{ quote: "USDC", mint: USDC_MAINNET, decimals: 6, bridged: false, venues: ["pumpfun", "meteora-dbc", "raydium-launchlab"] }]
      : [
          { quote: "USDC", mint: USDC_DEVNET, decimals: 6, bridged: false, venues: ["meteora-dbc", "raydium-launchlab"] },
          { quote: "USDC", mint: USDC_PUMP_DEVNET, decimals: 6, bridged: false, venues: ["pumpfun"] },
        ];
  return [
    { quote: "ZEC", mint: ZEC_SPL_MINT, decimals: 8, bridged: true, venues: ["pumpfun", "raydium-launchlab"], spreadBps: Number(ZEC_SPREAD_BPS) },
    ...usdc,
    { quote: "USD1", mint: USD1_MINT, decimals: 6, bridged: false, venues: ["meteora-dbc", "raydium-launchlab"] },
  ];
}

/** The quote mint a token of `venue` uses (mock state is shared by both networks: devnet mints for USDC). */
function quoteMintFor(quote: Quote, venue: Venue): string | undefined {
  if (quote === "ZEC") return ZEC_SPL_MINT;
  if (quote === "USD1") return USD1_MINT;
  if (quote === "USDC") return venue === "pumpfun" ? USDC_PUMP_DEVNET : USDC_DEVNET;
  return undefined;
}

/** SOL amount -> integer string of quote base units. */
const solToQuoteUnits = (sol: number, quote: Quote) => BigInt(Math.round((sol / SOL_PER_QUOTE[quote]) * 10 ** Q_DECIMALS[quote])).toString();

/** Whole tokens (2 dp precision) -> integer string in base units. */
function toBaseUnits(whole: number, decimals: number): string {
  const cents = BigInt(Math.round(whole * 100));
  return decimals >= 2 ? (cents * BigInt(10) ** BigInt(decimals - 2)).toString() : (cents / BigInt(10) ** BigInt(2 - decimals)).toString();
}

const toLamports = (sol: number) => BigInt(Math.round(sol * 1e9)).toString();

interface MockTokenState {
  token: Token;
  price: number; // SOL (equivalent) per whole token; the quote price is price / SOL_PER_QUOTE[quote]
  supply: number; // whole tokens
  heat: number; // relative trade frequency
  /** v0.14: the SOL equivalent of the market cap is not known yet ("0"). */
  mcapUnknown?: boolean;
}

const SEED: Array<{ symbol: string; name: string; venue: Venue; status: Token["status"]; price: number; heat: number; quote?: Quote; platform?: LaunchPlatform; mcapUnknown?: boolean }> = [
  { symbol: "PEPE", name: "Pepe in the Dark", venue: "pumpfun", status: "curve", price: 3.4e-7, heat: 5 },
  { symbol: "GHOST", name: "Ghost Protocol", venue: "pumpfun", status: "curve", price: 1.1e-6, heat: 4 },
  { symbol: "UMBRA", name: "Umbra", venue: "meteora-dbc", status: "curve", price: 8.2e-6, heat: 3 },
  { symbol: "NOX", name: "Nox", venue: "pumpfun", status: "graduated", price: 6.4e-5, heat: 3 },
  { symbol: "VEIL", name: "Veil Cat", venue: "meteora-dbc", status: "curve", price: 2.7e-7, heat: 2 },
  { symbol: "MOTH", name: "Moth to the Flame", venue: "pumpfun", status: "curve", price: 5.9e-7, heat: 2 },
  { symbol: "WRAITH", name: "Wraith", venue: "meteora-dbc", status: "graduated", price: 1.9e-5, heat: 1 },
  // v0.13 non-SOL pairs and LaunchLab platforms
  { symbol: "SHIELD", name: "Shielded Cat", venue: "pumpfun", status: "curve", price: 6.2e-7, heat: 4, quote: "ZEC" },
  { symbol: "DARK", name: "Dark Forest", venue: "raydium-launchlab", status: "curve", price: 2.1e-6, heat: 3, quote: "ZEC", platform: "unzeen", mcapUnknown: true },
  { symbol: "LANTERN", name: "Lantern", venue: "meteora-dbc", status: "curve", price: 4.5e-6, heat: 2, quote: "USDC" },
  { symbol: "BONKSHADE", name: "Bonk Shade", venue: "raydium-launchlab", status: "curve", price: 9.1e-7, heat: 2, platform: "bonk" },
  { symbol: "STILL", name: "Still Water", venue: "raydium-launchlab", status: "curve", price: 1.4e-6, heat: 1, quote: "USD1", platform: "stonk" },
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
      ...pairFields(s.quote ?? "SOL", s.venue),
      ...(s.platform ? { platform: s.platform } : {}),
    },
    price: s.price,
    supply: SUPPLY,
    heat: s.heat,
    ...(s.mcapUnknown ? { mcapUnknown: true } : {}),
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

/** Token.quote / quoteMint of a pair (SOL pairs carry only quote: "SOL"). */
function pairFields(quote: Quote, venue: Venue): Pick<Token, "quote" | "quoteMint"> {
  const mint = quoteMintFor(quote, venue);
  return mint ? { quote, quoteMint: mint } : { quote };
}

function syncTokenFields() {
  for (const s of state!) {
    s.token.priceSol = plain(s.price, 4);
    s.token.marketCapSol = s.mcapUnknown ? "0" : trimDecimals(s.price * s.supply, 2);
    if (s.token.quote !== "SOL") s.token.priceQuote = plain(s.price / SOL_PER_QUOTE[s.token.quote], 4);
  }
}

/** quoteMint / quoteAmount of a trade on a non-SOL pair (solAmount stays the SOL equivalent). */
function quoteOfTrade(t: Token, sol: number, units?: bigint): Pick<FeedEvent, "quoteMint" | "quoteAmount"> {
  if (t.quote === "SOL" || !t.quoteMint) return {};
  return { quoteMint: t.quoteMint, quoteAmount: units !== undefined ? units.toString() : solToQuoteUnits(sol, t.quote) };
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
  const q = s.token.quote;
  let sol: number;
  let units: bigint | undefined;
  if (q === "SOL") {
    const raw = logRand(0.05, 6);
    sol = Number(trimDecimals(raw, raw >= 1 ? 1 : 2));
  } else {
    // Round in the pair's own unit ("3.1 ZEC", "45 USDC"); the SOL equivalent follows.
    const raw = q === "ZEC" ? logRand(0.03, 3.5) : logRand(8, 900);
    const amount = Number(trimDecimals(raw, q === "ZEC" ? (raw >= 1 ? 1 : 2) : 0));
    units = BigInt(Math.round(amount * 10 ** Q_DECIMALS[q]));
    sol = amount * SOL_PER_QUOTE[q];
  }
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
    ...quoteOfTrade(s.token, sol, units),
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
      quote: "SOL",
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

function candles(s: MockTokenState, tf: CandleTimeframe, from: number | undefined, to: number | undefined, inQuote = false): Candle[] {
  // v0.17 quote=1: the pair's own units (SOL pairs: the same bars).
  const q = s.token.quote ?? "SOL";
  const unit = inQuote && q !== "SOL" ? SOL_PER_QUOTE[q] : 1;
  const volDec = inQuote && q !== "SOL" ? Q_DECIMALS[q] : 9;
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
        open: plain(open / unit, 6),
        high: plain(high / unit, 6),
        low: plain(low / unit, 6),
        close: plain(close / unit, 6),
        volume: BigInt(Math.round(((logRand(0.2, 40) * Math.sqrt(step / 60)) / unit) * 10 ** volDec)).toString(),
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

/** v0.11 PoolInfo.minClaimZat (core default MIN_CLAIM_ZAT = 10 000). */
const MIN_CLAIM_ZAT = BigInt(10_000);

/** Flat fee of exec "now" (field name pending in docs/API.md). Shown in quotes; the mock does not charge it. */
const NOW_FEE_ZAT = "5000";
const FEES = { nowFeeZat: NOW_FEE_ZAT, createFeeZat: "100000", withdrawZecFeeZat: "15000" };

/** Mock twin of UNZEEN_CREATE_ENABLED: NEXT_PUBLIC_MOCK_CREATE_DISABLED=1 shows the disabled launch state. */
const CREATE_ENABLED = process.env.NEXT_PUBLIC_MOCK_CREATE_DISABLED !== "1";
/** v0.17 (A4): set to "1" to play a Bags pool whose curve the relayer has not recorded yet (create -> 503). */
const BAGS_NO_CURVE = process.env.NEXT_PUBLIC_MOCK_BAGS_NO_CURVE === "1";

// ---- v0.17 final audit: amounts that leave the pool never equal a public buy (A1, A5, A6) ----

/** core quantize_min_out: rounded down to 3 significant digits. */
export function sig3Down(v: bigint): bigint {
  let p = BigInt(1);
  while (v / p >= BigInt(1000)) p *= BigInt(10);
  return (v / p) * p;
}

/** core fuzz_token_amount: shave 0.5 % + u * 1.5 %, then round down to 3 significant digits (0 for dust). */
export function fuzzTokenAmount(amount: bigint, u: number = Math.random()): bigint {
  const ppm = BigInt(5_000 + Math.floor(15_000 * Math.min(1, Math.max(0, u))));
  let shave = (amount * ppm + BigInt(999_999)) / BigInt(1_000_000);
  if (shave < BigInt(1)) shave = BigInt(1);
  return amount > shave ? sig3Down(amount - shave) : N0;
}

/** core split_amount: `parts` uneven pieces (±20 % around the mean), at least 1 each. */
export function splitAmount(amount: bigint, parts: number, rnd: () => number = Math.random): bigint[] {
  const n = BigInt(Math.max(1, parts));
  const mean = amount / n;
  const out: bigint[] = [];
  let left = amount;
  for (let i = 0; i < parts; i++) {
    const remaining = BigInt(parts - i);
    if (remaining === BigInt(1)) {
      out.push(left);
      break;
    }
    const jitter = BigInt(Math.trunc(Number(mean) * 0.2 * (rnd() * 2 - 1)));
    let v = mean + jitter;
    if (v < BigInt(1)) v = BigInt(1);
    const cap = left - (remaining - BigInt(1));
    if (v > cap) v = cap;
    out.push(v);
    left -= v;
  }
  return out;
}

/** A6: this key's executed buys of `mint` in the last 48 h (token amounts). */
function publicBuysOf(network: Network, pubkey: string, mint: string, now: number): bigint[] {
  const out: bigint[] = [];
  for (const x of actions.values()) {
    if (x.network !== network || x.pubkey !== pubkey || x.status.status !== "executed" || !x.status.fill) continue;
    const m = x.action.op === "buy" ? x.action.mint : x.action.op === "create" ? x.status.fill.mint : undefined;
    if (m !== mint || (x.status.executedAt ?? 0) < now - MIRROR_WINDOW_MS) continue;
    out.push(BigInt(x.status.fill.tokenAmount));
  }
  return out;
}

/** A6: would selling `amount` mirror a public buy of this key (one, their sum, or the whole position)? */
function mirrorsPublicBuy(network: Network, pubkey: string, mint: string, amount: bigint, now: number): boolean {
  const h = account(network, pubkey).holdings.find((x) => x.mint === mint);
  const position = h ? BigInt(h.amount) + BigInt(h.held) : null;
  return sellMirrorsBuy(amount, publicBuysOf(network, pubkey, mint, now), position) !== null;
}

/** NEXT_PUBLIC_MOCK_CHAT=0 shows the server without chat; NEXT_PUBLIC_MOCK_NOOP=0 without cover traffic. */
const CHAT_ON = process.env.NEXT_PUBLIC_MOCK_CHAT !== "0";
const NOOP_ON = process.env.NEXT_PUBLIC_MOCK_NOOP !== "0";
/** NEXT_PUBLIC_MOCK_DISCOVERY=1: the Discovery source on /tokens (off by default, like the backend flag). */
const DISCOVERY_ON = process.env.NEXT_PUBLIC_MOCK_DISCOVERY === "1";
const CHAT_FEATURES = { ...(CHAT_ON ? { chat: true as const } : {}), ...(NOOP_ON ? { noop: true as const } : {}), ...(DISCOVERY_ON ? { discovery: true as const } : {}) };

export function mockPool(network: Network): PoolInfo {
  const extra = {
    createEnabled: CREATE_ENABLED,
    // v0.7: with the flag off the key is absent altogether (absent = off). The condition is written on
    // process.env directly so the build drops the whole branch, names included (review F3).
    ...(process.env.NEXT_PUBLIC_MOCK_FAIR_LAUNCH === "1"
      ? { features: { fullTrades: FULL_FEED, fairLaunch: true, ...CHAT_FEATURES }, ...(fair ? { fairLaunch: fair.params(network) } : {}) }
      : { features: { fullTrades: FULL_FEED, ...CHAT_FEATURES } }),
    ...(CHAT_ON ? { chat: mockChatParams(network) } : {}),
    orders: ORDER_PARAMS,
    quotes: mockQuotes(network),
    venues: mockVenues(network),
    launchRules: {
      lockSecs: 86_400,
      capBps: 500,
      maxInitialBuyLamports: MOCK_MAX_INITIAL_BUY_LAMPORTS.toString(),
      maxInitialBuyLamportsByVenue: {
        pumpfun: MOCK_MAX_INITIAL_BUY_LAMPORTS.toString(),
        "meteora-dbc": mockVenueCap("meteora-dbc").toString(),
        "raydium-launchlab": mockVenueCap("raydium-launchlab").toString(),
        ...(network === "mainnet" ? { bags: mockVenueCap("meteora-dbc").toString() } : {}),
      },
      // v0.17: ZEC-pair cap in ZEC SPL units (step 0.0001 ZEC), only venues with the ZEC pair on (core: `{}` without one).
      maxInitialBuyZecUnitsByVenue: Object.fromEntries(
        (mockQuotes(network).find((q) => q.quote === "ZEC")?.venues ?? []).map((v) => [v, (MOCK_MAX_INITIAL_BUY_ZEC_UNITS - (MOCK_MAX_INITIAL_BUY_ZEC_UNITS % ZEC_UNITS_STEP)).toString()]),
      ),
    },
  };
  const rate = { lamportsPerZec: MID_LAMPORTS_PER_ZEC.toString(), lamportsPerZecBuy: mockRate(true).lamportsPerZec, lamportsPerZecSell: mockRate(false).lamportsPerZec, spreadBps: Number(SPREAD_BPS), source: "fixed" as const, ts: Math.floor(Date.now() / 60_000) * 60_000 };
  return network === "mainnet"
    ? { address: poolAddress(network), network: "main", chainId: "0101", minDepositZat: "1000000", minActionZat: "100000", minClaimZat: MIN_CLAIM_ZAT.toString(), confirmations: 3, fees: FEES, rate, ...extra }
    : { address: poolAddress(network), network: "test", chainId: "0202", minDepositZat: "1000000", minActionZat: "100000", minClaimZat: MIN_CLAIM_ZAT.toString(), confirmations: 3, fees: FEES, rate, ...extra };
}

interface MockAccount {
  zecBalance: bigint;
  zecHeld: bigint;
  frozen: boolean;
  holdings: { mint: string; amount: string; held: string }[];
  deposits: DepositInfo[];
  /** v0.7 creator fees owed, lamports per mint this key launched. */
  claimable: Map<string, bigint>;
  /** v0.14 creator fees of ZEC pairs owed, zatoshis per mint (credited 1:1). */
  claimableZat: Map<string, bigint>;
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
      claimableZat: new Map(),
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
    claimable: [...new Set([...a.claimable.keys(), ...a.claimableZat.keys()])]
      .map((mint) => ({ mint, solAmount: (a.claimable.get(mint) ?? N0).toString(), zecAmount: (a.claimableZat.get(mint) ?? N0).toString() }))
      .filter((c) => c.solAmount !== "0" || c.zecAmount !== "0"),
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

function mockRate(buy: boolean): SolRateUsed {
  const v = (MID_LAMPORTS_PER_ZEC * (BigInt(10_000) + (buy ? -SPREAD_BPS : SPREAD_BPS))) / BigInt(10_000);
  return { lamportsPerZec: v.toString(), source: "fixed", ts: Date.now() };
}

const BPS = BigInt(10_000);
/** Max ZEC SPL of a ZEC-pair launch buy within the 5 % cap: 2.7189 ZEC virtual × cap / (1.073e9 − cap). */
/** core actions::ZEC_UNITS_STEP: 0.0001 ZEC SPL. */
const ZEC_UNITS_STEP = BigInt(10_000);
const MOCK_MAX_INITIAL_BUY_ZEC_UNITS = (BigInt(271_890_000) * BigInt(50_000_000)) / BigInt(1_073_000_000 - 50_000_000);

/** v0.13 ZEC SPL parity: buy 1e8·(1 − s), sell 1e8·(1 + s) ZEC SPL units per ZEC; no lamportsPerZec. */
function parityRate(buy: boolean): RateUsed {
  const v = (ZAT * (BPS + (buy ? -ZEC_SPREAD_BPS : ZEC_SPREAD_BPS))) / BPS;
  return { quote: "ZEC", quotePerZec: v.toString(), source: "parity", ts: Date.now() };
}

const rateFor = (s: MockTokenState, buy: boolean): RateUsed => (s.token.quote === "ZEC" ? parityRate(buy) : mockRate(buy));

/** Zatoshis a sell of `amount` credits at the current price: parity for ZEC pairs, the SOL rate otherwise. */
function sellZat(s: MockTokenState, amount: bigint, rate: RateUsed): bigint {
  const sol = formatUnitsNum(amount, s.token.decimals) * s.price;
  if (s.token.quote === "ZEC") {
    const spl = BigInt(Math.floor((sol / SOL_PER_QUOTE.ZEC) * 1e8));
    return (spl * ZAT) / BigInt(rate.quotePerZec!);
  }
  return (BigInt(Math.floor(sol * 1e9)) * ZAT) / BigInt(rate.lamportsPerZec!);
}

/** Demo of 503 pool_liquidity on a non-SOL pair: the pool's stock of the quote is short above 5 ZEC worth. */
function checkPairLiquidity(s: MockTokenState, zecIn: bigint) {
  if (s.token.quote !== "SOL" && zecIn > BigInt(5) * ZAT) throw new ApiError("pool_liquidity", `not enough ${s.token.quote} on the vaults`, 503);
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
  /** v0.17: withdraw_token parts (owner-only, GET /api/actions/:id; never in Portfolio.actions). */
  parts?: WithdrawPart[];
  /** v0.17 (A2): a large mainnet ZEC payout waiting for the operator. */
  review?: boolean;
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
  if (venue === "bags") throw new ApiError("venue_unavailable", "bags is mainnet only", 503); // mock tokens are never on bags
  if (!["pumpfun", "meteora-dbc", "jupiter", "raydium-launchlab"].includes(venue)) throw new ApiError("bad_request", "venue: expected pumpfun | meteora-dbc | raydium-launchlab | jupiter", 400);
  if (!isSolanaAddress(mint)) throw new ApiError("bad_request", "mint: not a Solana address", 400);
  const s = findToken(mint);
  if (venue !== "jupiter" && s.token.venue !== venue) throw new ApiError("bad_request", `token trades on ${s.token.venue}, not ${venue}`, 400);
  // v0.13: Jupiter does not route ZEC SPL pairs.
  if (venue === "jupiter" && s.token.quote === "ZEC") throw new ApiError("bad_request", "jupiter: not for ZEC pairs", 400);
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
      const s = tradeToken(action.mint, action.venue);
      checkPairLiquidity(s, zecIn);
      if (a.zecBalance < zecIn) throw new ApiError("insufficient_balance", "not enough ZEC", 422);
      a.zecBalance -= zecIn;
      a.zecHeld += zecIn;
      return { ...base, holdZat: zecIn, ...queued(rateFor(s, true)) };
    }
    case "sell": {
      const amount = amountOf(action.amount, "amount");
      const minZecOut = amountOf(action.minZecOut, "minZecOut", false);
      const s = tradeToken(action.mint, action.venue);
      const rate = rateFor(s, false);
      const est = sellZat(s, amount, rate);
      if (minZecOut < minAction && est < minAction)
        throw new ApiError("below_minimum", "sell value below PoolInfo.minActionZat (raise amount or minZecOut)", 422);
      const h = holdingOf(a, action.mint);
      if (BigInt(h.amount) < amount) throw new ApiError("insufficient_balance", "not enough tokens", 422);
      // v0.17 (A6): a sell mirroring a public buy is shaved and rounded; minZecOut shrinks in proportion.
      let sold = amount;
      let minOut = minZecOut;
      if (mirrorsPublicBuy(network, pubkey, action.mint, amount, Date.now())) {
        sold = fuzzTokenAmount(amount);
        if (sold === N0) throw new ApiError("bad_request", "amount too small to sell", 400);
        minOut = (minZecOut * sold) / amount;
      }
      h.amount = (BigInt(h.amount) - sold).toString();
      h.held = (BigInt(h.held) + sold).toString();
      const effective: SignedAction = { ...action, amount: sold.toString(), minZecOut: minOut.toString() };
      return { ...base, action: effective, holdToken: { mint: action.mint, amount: sold }, ...queued(rate) };
    }
    case "create": {
      const initial = action.initialBuyZec === undefined ? N0 : amountOf(action.initialBuyZec, "initialBuyZec", false);
      if (action.venue === "jupiter") throw new ApiError("bad_request", "create: jupiter is not a launchpad", 400);
      // v0.16: bags is mainnet-only and SOL-only.
      if (action.venue === "bags" && network !== "mainnet") throw new ApiError("venue_unavailable", "bags is mainnet only", 503);
      if (action.venue === "bags" && (action.quote ?? "SOL") !== "SOL") throw new ApiError("bad_request", "bags: SOL pairs only", 400);
      if (!["pumpfun", "meteora-dbc", "raydium-launchlab", "bags"].includes(action.venue)) throw new ApiError("bad_request", "venue: pumpfun | meteora-dbc | raydium-launchlab", 400);
      if (!CREATE_ENABLED) throw new ApiError("venue_unavailable", "create is not enabled", 503);
      if (action.venue === "bags" && BAGS_NO_CURVE) throw new ApiError("venue_unavailable", "bags: launch curve not recorded yet", 503);
      // v0.13 pair and LaunchLab platform.
      const quote = action.quote ?? "SOL";
      if (!["SOL", "USDC", "USD1", "ZEC"].includes(quote)) throw new ApiError("bad_request", "quote: SOL | USDC | USD1 | ZEC", 400);
      if (quote !== "SOL") {
        const listed = pool.quotes?.some((q) => q.quote === quote);
        if (!listed) throw new ApiError("venue_unavailable", `${quote} pairs are not enabled`, 503);
        if (!pool.quotes!.some((q) => q.quote === quote && q.venues.includes(action.venue))) throw new ApiError("bad_request", `${action.venue} has no ${quote} pair`, 400);
      }
      if (action.platform !== undefined && (action.venue !== "raydium-launchlab" || !["unzeen", "bonk", "stonk"].includes(action.platform)))
        throw new ApiError("bad_request", "platform: unzeen | bonk | stonk, raydium-launchlab only", 400);
      if (initial > N0 && initial < minAction) throw new ApiError("below_minimum", "initialBuyZec below PoolInfo.minActionZat", 422);
      if (quote === "ZEC") {
        // ZEC curve: same token reserves, ZEC virtual reserves (core: UNZEEN_LAUNCH_VIRTUAL_ZEC_UNITS).
        const full = (initial * (BPS - ZEC_SPREAD_BPS)) / BPS;
        if (initial > N0 && full - (full % ZEC_UNITS_STEP) > MOCK_MAX_INITIAL_BUY_ZEC_UNITS - (MOCK_MAX_INITIAL_BUY_ZEC_UNITS % ZEC_UNITS_STEP)) throw new ApiError("creator_cap", "initial buy above the ZEC curve cap", 422);
      } else if ((initial * BigInt(mockRate(true).lamportsPerZec)) / ZAT > mockVenueCap(action.venue)) throw new ApiError("creator_cap", "initial buy above launchRules.maxInitialBuyLamportsByVenue", 422);
      const total = initial + CREATE_FEE_ZAT;
      if (a.zecBalance < total) throw new ApiError("insufficient_balance", "not enough ZEC", 422);
      a.zecBalance -= total;
      a.zecHeld += total;
      return { ...base, holdZat: total, ...queued(quote === "ZEC" ? parityRate(true) : mockRate(true)) };
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
      // v0.17 (A2): above 1 ZEC on mainnet the payout waits for the operator (still queued).
      return { ...base, holdZat: total, ...(network === "mainnet" && amount > PAYOUT_REVIEW_ABOVE_ZAT ? { review: true } : {}), ...queued() };
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
      // v0.17 (A1): never the exact amount: shaved 0.5–2 %, split, every part rounded to 3 significant digits.
      const total = fuzzTokenAmount(amount);
      const split = splitAmount(total, parts).map(sig3Down);
      if (total < BigInt(parts) || split.some((x) => x === N0)) throw new ApiError("bad_request", "amount too small to withdraw", 400);
      const sent = split.reduce((x, y) => x + y, N0);
      a.zecBalance -= fee;
      a.zecHeld += fee;
      h.amount = (BigInt(h.amount) - sent).toString();
      h.held = (BigInt(h.held) + sent).toString();
      const [lo, hi] = execDelay(action);
      const t0 = Date.now();
      // notBefore: whole seconds, each part at its own random time (compressed like every mock delay).
      const partsOut: WithdrawPart[] = split.map((x) => ({ amount: x.toString(), notBefore: Math.floor((t0 + rand(lo, hi * (parts > 1 ? 1.6 : 1))) / 1000) * 1000, status: "queued" }));
      const effective: SignedAction = { ...action, amount: sent.toString() };
      return { ...base, action: effective, holdZat: fee, holdToken: { mint: action.mint, amount: sent }, parts: partsOut, ...queued(rate) };
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
    const zecPair = s.token.quote === "ZEC";
    // ZEC pair: zecIn × (1 − s) of ZEC SPL at parity (8 decimals = zat); others: lamports at the ZEC/SOL rate.
    const spl = zecPair ? (BigInt(x.zecIn) * BigInt(rate!.quotePerZec!)) / ZAT : N0;
    const lamports = zecPair ? BigInt(Math.round((Number(spl) / 1e8) * SOL_PER_QUOTE.ZEC * 1e9)) : (BigInt(x.zecIn) * BigInt(rate!.lamportsPerZec!)) / ZAT;
    const sol = Number(lamports) / 1e9;
    const out = BigInt(toBaseUnits(sol / s.price, s.token.decimals));
    if (out < BigInt(x.minOut)) return fail(act, a, "slippage");
    releaseZat(a, act, act.holdZat);
    const h = holdingOf(a, x.mint);
    h.amount = (BigInt(h.amount) + out).toString();
    s.heat = Math.max(s.heat, 1);
    s.price *= 1 + sol / Math.max(30, s.price * s.supply) / 2;
    syncTokenFields();
    const pair = quoteOfTrade(s.token, sol, zecPair ? spl : undefined);
    publish({ id: b58(16), kind: "buy", venue: s.token.venue, mint: s.token.mint, symbol: s.token.symbol, tokenAmount: out.toString(), solAmount: lamports.toString(), decimals: s.token.decimals, solanaTx: tx, ts: now, ...pair });
    const fill = zecPair ? { quoteAmount: spl.toString(), quoteMint: s.token.quoteMint } : { solAmount: lamports.toString() };
    act.status = { status: "executed", executedAt: Math.floor(now / 60_000) * 60_000, solanaTx: tx, rate, fill: { tokenAmount: out.toString(), ...fill, zecSpent: x.zecIn } };
  } else if (x.op === "sell") {
    const s = findToken(x.mint);
    const amount = BigInt(x.amount);
    const zecPair = s.token.quote === "ZEC";
    const sol = formatUnitsNum(amount, s.token.decimals) * s.price;
    const lamports = BigInt(Math.floor(sol * 1e9));
    const spl = zecPair ? BigInt(Math.floor((sol / SOL_PER_QUOTE.ZEC) * 1e8)) : N0;
    const zec = sellZat(s, amount, rate!);
    if (zec < BigInt(x.minZecOut)) return fail(act, a, "slippage");
    releaseTokens(a, act, amount);
    a.zecBalance += zec;
    s.price *= 1 - sol / Math.max(30, s.price * s.supply) / 2;
    syncTokenFields();
    const pair = quoteOfTrade(s.token, sol, zecPair ? spl : undefined);
    publish({ id: b58(16), kind: "sell", venue: s.token.venue, mint: s.token.mint, symbol: s.token.symbol, tokenAmount: amount.toString(), solAmount: lamports.toString(), decimals: s.token.decimals, solanaTx: tx, ts: now, ...pair });
    const fill = zecPair ? { quoteAmount: spl.toString(), quoteMint: s.token.quoteMint } : { solAmount: lamports.toString() };
    act.status = { status: "executed", executedAt: Math.floor(now / 60_000) * 60_000, solanaTx: tx, rate, fill: { tokenAmount: amount.toString(), ...fill, zecCredited: zec.toString() } };
  } else if (x.op === "create") {
    const initial = act.holdZat - CREATE_FEE_ZAT;
    const quote = x.quote ?? "SOL";
    const spl = quote === "ZEC" ? (initial * BigInt(rate!.quotePerZec!)) / ZAT : N0;
    const lamports = quote === "ZEC" ? BigInt(Math.round((Number(spl) / 1e8) * SOL_PER_QUOTE.ZEC * 1e9)) : (initial * BigInt(rate!.lamportsPerZec!)) / ZAT;
    const venue: Venue = x.venue;
    const price = 2.8e-8;
    const s: MockTokenState = {
      token: {
        mint: mintFor(venue, x.meta.symbol + ":" + act.id),
        symbol: x.meta.symbol,
        name: x.meta.name,
        image: x.meta.image,
        venue,
        status: "curve",
        decimals: DECIMALS[venue],
        priceSol: "0",
        marketCapSol: "0",
        createdAt: now,
        ...pairFields(quote, venue),
        ...(venue === "raydium-launchlab" ? { platform: x.platform ?? "unzeen" } : {}),
      },
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
    const pair = lamports > N0 ? quoteOfTrade(s.token, Number(lamports) / 1e9, quote === "ZEC" ? spl : undefined) : {};
    publish({ id: b58(16), kind: "create", venue, mint: s.token.mint, symbol: s.token.symbol, tokenAmount: out.toString(), solAmount: lamports.toString(), decimals: s.token.decimals, solanaTx: tx, ts: now, ...pair });
    const fill = quote === "ZEC" ? { quoteAmount: spl.toString(), quoteMint: s.token.quoteMint } : { solAmount: lamports.toString() };
    act.status = { status: "executed", executedAt: Math.floor(now / 60_000) * 60_000, solanaTx: tx, rate, fill: { tokenAmount: out.toString(), ...fill, zecSpent: initial.toString(), mint: s.token.mint } };
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
  if (CHAT_OPS.has(action.op) || action.op === "noop") {
    // Chat and cover traffic (chat.md §5.1, R8): exactly 1024 bytes, never in actions / Portfolio.actions.
    const bytes = new TextEncoder().encode(body ?? "").length;
    let receipt: ActionReceipt;
    if (action.op === "noop") {
      if (bytes !== 1024) throw new ApiError("bad_request", "noop bodies are exactly 1024 bytes", 400);
      receipt = { id: hex16(), status: "queued" };
    } else receipt = chat.submit(network, pubkey, action, bytes, now);
    seenNonces.set(nonceKey, now + 120_000);
    const act: MockAction = { id: receipt.id, network, pubkey, action, nonceKey, bodyHash: hash, receipt, status: { status: "queued" }, holdZat: N0, hidden: true };
    actions.set(`ledger:${nonceKey}`, act);
    byNonce.set(nonceKey, `ledger:${nonceKey}`);
    return receipt;
  }
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
  if (act.parts) schedulePartsOf(act);
  // A2: the operator approves a large payout after a while (compressed); it stays queued until then.
  else setTimeout(() => execute(act), act.review ? rand(60_000, 120_000) : rand(lo, hi));
  return act.receipt;
}

/** v0.17: each part leaves at its own notBefore, confirms a moment later; the action settles with the last. */
function schedulePartsOf(act: MockAction) {
  for (const p of act.parts!) {
    setTimeout(() => {
      p.status = "sent";
      setTimeout(() => {
        p.status = "confirmed";
        if (act.parts!.every((x) => x.status === "confirmed")) execute(act);
      }, rand(1_500, 3_000));
    }, Math.max(0, p.notBefore - Date.now()));
  }
}

// ---- private orders (v0.8) and creator fees (v0.7 claim) ----

const ORDER_PARAMS: OrdersParams = {
  kinds: ["limit_buy", "limit_sell", "take_profit", "stop_loss", "bracket"],
  venues: ["pumpfun"],
  maxOpenPerKey: 10,
  maxOpenPerMint: 4,
  maxTtlSecs: 259_200,
  defaultTtlSecs: 86_400,
  defaultSlippageBps: { limit_buy: 500, limit_sell: 500, take_profit: 500, stop_loss: 1500, bracket: 500 },
  maxRearms: 3,
  slConfirmTicks: 2,
  priceTick: { minSecs: 45, maxSecs: 75 },
};
const ORDER_KINDS = new Set<string>(ORDER_PARAMS.kinds);
const SELL_KINDS = new Set<OrderKind>(["limit_sell", "take_profit", "stop_loss", "bracket"]);
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
const creators = new Map<string, { network: Network; pubkey: string; lockedAmount: bigint; lockUntil: number; claimed: bigint; claimedZat?: bigint }>();
/** Fees earned since the last collector run, per mint: lamports (SOL / USDC / USD1 pairs) or zat (ZEC pairs). */
const pendingFees = new Map<string, bigint>();
const pendingFeesZat = new Map<string, bigint>();
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
  if (!ORDER_KINDS.has(x.kind)) throw new ApiError("bad_request", "kind: limit_buy | limit_sell | take_profit | stop_loss | bracket", 400);
  if (!isSolanaAddress(String(x.mint))) throw new ApiError("bad_request", "mint: not a Solana address", 400);
  const price = (v: unknown, field: string) => {
    const p = String(v ?? "");
    if (!DECIMAL_RE.test(p) || !(Number(p) > 0) || sigDigits(p) > 18) throw new ApiError("bad_request", `${field}: positive decimal, <= 18 significant digits`, 400);
    return p;
  };
  // v0.15 bracket: tpPriceSol + slPriceSol (tp > sl), never triggerPriceSol; the single kinds the other way round.
  const bracket = x.kind === "bracket";
  if (bracket && x.triggerPriceSol !== undefined) throw new ApiError("bad_request", "bracket: use tpPriceSol / slPriceSol, not triggerPriceSol", 400);
  if (!bracket && (x.tpPriceSol !== undefined || x.slPriceSol !== undefined || x.slSlippageBps !== undefined)) throw new ApiError("bad_request", "tpPriceSol / slPriceSol / slSlippageBps: bracket only", 400);
  const t = bracket ? price(x.tpPriceSol, "tpPriceSol") : price(x.triggerPriceSol, "triggerPriceSol");
  const sl = bracket ? price(x.slPriceSol, "slPriceSol") : null;
  if (sl !== null && !(Number(t) > Number(sl))) throw new ApiError("bad_request", "tpPriceSol must be above slPriceSol", 400);
  if (x.rearm !== undefined && typeof x.rearm !== "boolean") throw new ApiError("bad_request", "rearm: boolean", 400);
  const amount = amountOf(x.amount, "amount");
  const slippageBps = x.slippageBps ?? (bracket ? ORDER_PARAMS.defaultSlippageBps.bracket! : ORDER_PARAMS.defaultSlippageBps[x.kind as Exclude<OrderKind, "bracket">]);
  if (!Number.isInteger(slippageBps) || slippageBps < 50 || slippageBps > 5000) throw new ApiError("bad_request", "slippageBps: 50..5000", 400);
  const slSlippageBps = bracket ? (x.slSlippageBps ?? ORDER_PARAMS.defaultSlippageBps.stop_loss) : undefined;
  if (slSlippageBps !== undefined && (!Number.isInteger(slSlippageBps) || slSlippageBps < 50 || slSlippageBps > 5000)) throw new ApiError("bad_request", "slSlippageBps: 50..5000", 400);
  const ttl = x.ttlSecs ?? ORDER_PARAMS.defaultTtlSecs;
  if (!Number.isInteger(ttl) || ttl < 3600 || ttl > ORDER_PARAMS.maxTtlSecs) throw new ApiError("bad_request", `ttlSecs: 3600..${ORDER_PARAMS.maxTtlSecs}`, 400);
  const exec = x.exec ?? "delayed";
  if (exec !== "delayed" && exec !== "max") throw new ApiError("bad_request", 'exec: orders take "delayed" | "max"', 400);
  // Only mints the pool already trades (public GET /api/tokens), on the pump.fun curve.
  const s = state!.find((y) => y.token.mint === x.mint);
  if (!s || s.heat === 0 || s.token.venue !== "pumpfun" || s.token.status !== "curve" || s.token.quote !== "SOL") throw new ApiError("order_unsupported_mint", "mint not supported for orders", 422);
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
    // bracket: valued at its stop-loss price (the lower one).
    const value = (lamportsAt(amount, s.token.decimals, Number(sl ?? t)) * ZAT) / BigInt(mockRate(false).lamportsPerZec);
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
      ...(sl !== null ? { slPriceSol: sl, slSlippageBps } : {}),
      ...(x.rearm ? { rearm: true as const } : {}),
      rearms: 0,
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
    const mints = x.mint === undefined ? [...new Set([...a.claimable.keys(), ...a.claimableZat.keys()])] : [x.mint];
    const lamports = mints.reduce((sum, m) => sum + (a.claimable.get(m) ?? N0), N0);
    const zatOwed = mints.reduce((sum, m) => sum + (a.claimableZat.get(m) ?? N0), N0);
    const rate = mockRate(false);
    // v0.14: floor(lamports × 1e8 / sell rate) + zat; minClaimZat applies to the sum.
    const zat = (lamports * ZAT) / BigInt(rate.lamportsPerZec) + zatOwed;
    if (zat === N0 || zat < MIN_CLAIM_ZAT) throw new ApiError("below_minimum", "nothing to claim above PoolInfo.minClaimZat", 422);
    for (const m of mints) {
      const c = creators.get(m);
      if (c && c.network === network && c.pubkey === pubkey) {
        c.claimed += a.claimable.get(m) ?? N0;
        c.claimedZat = (c.claimedZat ?? N0) + (a.claimableZat.get(m) ?? N0);
      }
      a.claimable.delete(m);
      a.claimableZat.delete(m);
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
    if (o.pub.kind === "bracket") {
      // v0.15 OCO: TP (p ≥ tp) fires at once and resets the SL arming; SL (p ≤ sl) needs two ticks in a row.
      if (p >= trigger) {
        delete o.pub.armed;
        fireOrder(o, s, "tp");
        continue;
      }
      if (p > Number(o.pub.slPriceSol)) {
        delete o.pub.armed;
        continue;
      }
      if (!o.pub.armed) {
        o.pub.armed = true;
        continue;
      }
      fireOrder(o, s, "sl");
      continue;
    }
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
function fireOrder(o: MockOrder, s: MockTokenState, leg?: "tp" | "sl") {
  const slLeg = leg === "sl";
  const slip = (slLeg ? o.pub.slSlippageBps! : o.pub.slippageBps) / 10_000;
  const trigger = Number(slLeg ? o.pub.slPriceSol : o.pub.triggerPriceSol);
  let amount = BigInt(o.pub.amount);
  if (leg) o.pub.leg = leg;
  // Server guard of a stop-loss (and the SL leg): sells only while p ≥ trigger · (1 − slippage).
  if ((o.pub.kind === "stop_loss" || slLeg) && s.price < trigger * (1 - slip)) {
    delete o.pub.armed;
    return slippageMiss(o, Date.now());
  }
  let action: SignedAction;
  let rate: SolRateUsed;
  if (o.pub.kind === "limit_buy") {
    rate = mockRate(true);
    const lamports = (amount * BigInt(rate.lamportsPerZec)) / ZAT;
    const minOut = BigInt(Math.floor((Number(lamports) / 1e9 / (trigger * (1 + slip))) * 10 ** s.token.decimals));
    action = { op: "buy", venue: "pumpfun", mint: o.pub.mint, zecIn: o.pub.amount, minOut: minOut.toString(), exec: o.pub.exec };
  } else {
    // v0.17 (A5): after a re-arm, or when the size mirrors a public buy (A6), the sell is shaved and rounded
    // again; Order.amount shrinks to it and the rest of the hold goes back to the balance.
    if ((o.pub.rearms ?? 0) > 0 || mirrorsPublicBuy(o.network, o.pubkey, o.pub.mint, amount, Date.now())) {
      const next = fuzzTokenAmount(amount);
      if (next > N0 && next < amount) {
        const h = holdingOf(account(o.network, o.pubkey), o.pub.mint);
        h.held = (BigInt(h.held) - (amount - next)).toString();
        h.amount = (BigInt(h.amount) + (amount - next)).toString();
        o.pub.amount = next.toString();
        amount = next;
      }
    }
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
    else if (act.status.status === "failed" && act.status.error === "slippage") {
      // The failed trade already returned the hold to the balance: an order that re-arms takes it back.
      if (canRearm(o, Date.now())) holdOrder(o);
      slippageMiss(o, Date.now());
    } else if (act.status.status === "failed") closeOrder(o, "failed", Date.now(), act.status.error);
  }
}

const canRearm = (o: MockOrder, now: number) => !!o.pub.rearm && (o.pub.rearms ?? 0) < (ORDER_PARAMS.maxRearms ?? 3) && now < o.pub.expiresAt;

/** Re-take an order's hold (limit_buy: zat; sells: tokens). */
function holdOrder(o: MockOrder) {
  const a = account(o.network, o.pubkey);
  const v = BigInt(o.pub.amount);
  if (o.pub.kind === "limit_buy") {
    a.zecBalance -= v;
    a.zecHeld += v;
  } else {
    const h = holdingOf(a, o.pub.mint);
    h.amount = (BigInt(h.amount) - v).toString();
    h.held = (BigInt(h.held) + v).toString();
  }
}

/**
 * v0.15: a slippage miss (on-chain, or the stop-loss guard) sends a rearm order back to open with the same
 * hold, up to maxRearms times and before expiresAt; otherwise it fails and the hold returns. The caller
 * has made sure the hold is on the order.
 */
function slippageMiss(o: MockOrder, now: number) {
  if (canRearm(o, now)) {
    o.pub.status = "open";
    o.pub.rearms = (o.pub.rearms ?? 0) + 1;
    delete o.pub.actionId;
    delete o.pub.leg;
    delete o.pub.armed;
    return;
  }
  if (o.pub.status === "open") {
    // Guard miss before any trade: the hold is still on the order.
    releaseOrder(o);
    tidyHoldings(account(o.network, o.pubkey));
  }
  closeOrder(o, "failed", now, "slippage");
}

/** Creator fee of a trade on a token launched through the pool: pending until the collector runs. */
function accrueCreatorFee(ev: FeedEvent) {
  // v0.16: Bags creator fees are not collected (PoolInfo.venues[bags].creatorFees = false).
  if (ev.kind === "create" || !creators.has(ev.mint) || ev.venue === "bags") return;
  // v0.14: a ZEC pair's fee comes in ZEC SPL and is credited 1:1 in zat (8 decimals); others in lamports.
  if (ev.quoteMint === ZEC_SPL_MINT && ev.quoteAmount) {
    const fee = (BigInt(ev.quoteAmount) * CREATOR_FEE_BPS) / BigInt(10_000);
    if (fee > N0) pendingFeesZat.set(ev.mint, (pendingFeesZat.get(ev.mint) ?? N0) + fee);
    return;
  }
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
  for (const [mint, fee] of pendingFeesZat) {
    const c = creators.get(mint);
    if (!c) continue;
    const a = account(c.network, c.pubkey);
    a.claimableZat.set(mint, (a.claimableZat.get(mint) ?? N0) + fee);
  }
  pendingFeesZat.clear();
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
      fees: {
        claimableLamports: (a.claimable.get(mint) ?? N0).toString(),
        claimedLamports: c.claimed.toString(),
        claimableZat: (a.claimableZat.get(mint) ?? N0).toString(),
        claimedZat: (c.claimedZat ?? N0).toString(),
      },
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

/** TEST / DEMO: credit ZEC-pair creator fees (zat, v0.14) straight to a key's claimable balance. */
export function mockCreditCreatorFeesZat(network: Network, pubkey: string, mint: string, zat: bigint) {
  init(Date.now());
  const a = account(network, pubkey);
  a.claimableZat.set(mint, (a.claimableZat.get(mint) ?? N0) + zat);
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
  // Dev-only failure injection; the literal check keeps it out of every other build.
  if (process.env.NEXT_PUBLIC_MOCK_CHAOS === "1") await (await import("./chaos")).chaosGate(!!headers[HEADER_NONCE]);
  await delay(rand(120, 380));
  scan(Date.now());
  fair?.tick(Date.now());
  catchUpTicks(Date.now());
  chat.tick(Date.now());
  const url = new URL(pathWithQuery, "http://mock.local");
  const p = url.pathname;
  const q = url.searchParams;
  let m: RegExpMatchArray | null;

  if (method === "GET") {
    if (p === "/api/feed") return history.slice(0, Math.min(Number(q.get("limit") ?? 50), 200));
    // Cold mints from CA searches stay out of the public list until unzeen trades them: listing them
    // would tell everyone what someone searched for.
    if (p === "/api/tokens" && q.has("source")) {
      if (q.get("source") !== "discovery") throw new ApiError("bad_request", "source: discovery", 400);
      if (!DISCOVERY_ON) throw new ApiError("not_found", `${method} ${p}`, 404);
      return discoveryList(Date.now());
    }
    if (p === "/api/tokens") return state!.filter((s) => s.heat > 0).map((s) => withListFields(s, Date.now()));
    if (p === "/api/stats") return stats(Date.now());

    if ((m = p.match(/^\/api\/tokens\/([^/]+)$/))) {
      const s = resolveMint(decodeURIComponent(m[1]));
      if ("status" in s) return s;
      const out: TokenWithTrades = { ...s.token, trades: history.filter((e) => e.mint === s.token.mint).slice(0, 50) };
      return out;
    }
    if ((m = p.match(/^\/api\/tokens\/([^/]+)\/chat$/))) {
      if (!CHAT_ON) throw new ApiError("not_found", `${method} ${p}`, 404);
      return chat.get(network, decodeURIComponent(m[1]), q, Date.now());
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
      const quote = q.get("quote");
      if (quote !== null && quote !== "0" && quote !== "1") throw new ApiError("bad_request", "quote: 0 | 1", 400);
      return candles(s, tf, num("from"), num("to"), quote === "1");
    }
    if (p === "/api/pool") return mockPool(network);
    if (process.env.NEXT_PUBLIC_MOCK_FAIR_LAUNCH === "1" && fair && (p === "/api/launches" || p.startsWith("/api/launches/"))) return fair.get(network, p, q);
    if ((m = p.match(/^\/api\/actions\/([^/]+)$/))) {
      const pub = authorize(network, method, pathWithQuery, body, headers);
      const a = actions.get(decodeURIComponent(m[1]));
      if (!a || a.pubkey !== pub || a.network !== network) throw new ApiError("not_found", "unknown action", 404);
      // v0.17: parts only here, to the owner, never in Portfolio.actions.
      return structuredClone(a.parts ? { ...a.status, parts: a.parts } : a.status);
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
    token: { mint, symbol, name, venue: "pumpfun", status: "curve", decimals: 6, priceSol: "0", marketCapSol: "0", createdAt: at - Math.floor(rnd() * 6 * 3_600_000), quote: "SOL" },
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
      token: { mint: mintFor(venue, x.symbol + ":" + hex16()), symbol: x.symbol, name: x.name, image: x.image, venue, status: "curve", decimals: DECIMALS[venue], priceSol: "0", marketCapSol: "0", createdAt: now, quote: "SOL" },
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
      rateBuy: () => BigInt(mockRate(true).lamportsPerZec),
      accounts(network) {
        const out: { pubkey: string; zat: bigint; tokens: { mint: string; amount: bigint }[]; claimLamports: bigint; claimZat: bigint }[] = [];
        for (const [key, a] of accounts) {
          const [net, pubkey] = key.split(":");
          if (net !== network) continue;
          const claimLamports = [...a.claimable.values()].reduce((x, y) => x + y, N0);
          const claimZat = [...a.claimableZat.values()].reduce((x, y) => x + y, N0);
          out.push({ pubkey, zat: a.zecBalance + a.zecHeld, tokens: a.holdings.map((h) => ({ mint: h.mint, amount: BigInt(h.amount) + BigInt(h.held) })), claimLamports, claimZat });
        }
        return out;
      },
      tokens: () => (state ?? []).map((s) => ({ mint: s.token.mint, decimals: s.token.decimals })),
      quoteAssets: (network) => mockQuotes(network).map((q) => ({ mint: q.mint, quote: q.quote, decimals: q.decimals, bridged: q.bridged })),
      authorize: (network, method, path, body, headers) => authorize(network, method, path, body, headers),
    }),
  ));
}

/** Mock of the devnet operator command `unzeen-api verify-snapshot`. Returns the new snapshot id. */
export async function mockTakeSnapshot(network: Network): Promise<number> {
  init(Date.now());
  return (await loadVerify()).takeSnapshot(network);
}

// ---- token chat (API.md v0.12) ----

/** Account value for chat admission: ZEC available + held + tokens at the current price (chat.md §4.1). */
function accountValueZat(network: Network, pubkey: string): bigint {
  const a = account(network, pubkey);
  let lamports = N0;
  for (const h of a.holdings) {
    const s = state?.find((x) => x.token.mint === h.mint);
    if (!s) continue;
    const whole = Number(BigInt(h.amount) + BigInt(h.held)) / 10 ** s.token.decimals;
    lamports += BigInt(Math.floor(whole * s.price * 1e9));
  }
  return a.zecBalance + a.zecHeld + (lamports * ZAT) / BigInt(mockRate(false).lamportsPerZec);
}

const chat = createChatMock(
  {
    pool: (network) => mockPool(network),
    accountValueZat,
    frozen: (network, pubkey) => account(network, pubkey).frozen,
    isCreator: (network, pubkey, mint) => {
      const c = creators.get(mint);
      return !!c && c.network === network && c.pubkey === pubkey;
    },
    isPublicMint: (mint) => !!state?.some((s) => s.token.mint === mint && s.heat > 0),
    isUnzeenLaunch: (mint) => unzeenLaunches.has(mint) || !!state?.some((s) => s.token.mint === mint && s.token.symbol === "GHOST"),
  },
  { chatter: true },
);

// ---- /tokens list fields and Discovery (API.md v0.12) ----

const DAY = 24 * 3_600_000;

/** Curve progress from market cap: log scale, ~1500 SOL fills the curve (mock only). */
function mockCurvePct(s: MockTokenState): string | undefined {
  if (s.token.status !== "curve") return undefined;
  const mcap = s.price * s.supply;
  const p = ((Math.log10(Math.max(10, mcap)) - 1) / (Math.log10(1500) - 1)) * 100;
  return trimDecimals(Math.max(1, Math.min(99, p)), 1);
}

function withListFields(s: MockTokenState, now: number): TokenListItem {
  let vol = 0;
  let trades = 0;
  for (const e of history) {
    if (e.mint !== s.token.mint || now - e.ts > DAY || e.kind === "create") continue;
    vol += Number(e.solAmount) / 1e9;
    trades++;
  }
  const curve = mockCurvePct(s);
  return {
    ...s.token,
    unzeenLaunch: unzeenLaunches.has(s.token.mint) || s.token.symbol === "GHOST",
    volume24hSol: trimDecimals(vol, 3),
    unzeenTrades24h: trades,
    ...(curve ? { curveProgressPct: curve } : {}),
  };
}

let discovery: DiscoveryToken[] | null = null;
function discoveryList(now: number): DiscoveryToken[] {
  if (!discovery) {
    const rnd = seeded("discovery");
    const names: Array<[string, string]> = [["BLINK", "Blink"], ["MIRE", "Mire Frog"], ["FOG", "Fog Machine"], ["LURK", "Lurker"], ["HAZE", "Purple Haze"], ["SOOT", "Soot Sprite"], ["GLOOM", "Gloom"], ["UMBRA2", "Umbra Two"], ["MURK", "Murk"], ["DIM", "Dim Sum"], ["NIGHT", "Night Shift"], ["OWL", "Night Owl"], ["SHH", "Shh"], ["QUIET", "Quiet Part"], ["DRIFT", "Drift"], ["STEALTH", "Stealth Cat"], ["VAPOR", "Vapor"], ["ASH", "Ash"]];
    discovery = names.map(([symbol, name], i) => {
      const venue: DiscoveryToken["venue"] = rnd() < 0.7 ? "pumpfun" : "meteora-dbc";
      const price = logRand(1e-8, 2e-7);
      const graduated = rnd() < 0.1;
      const mcap = price * SUPPLY;
      return {
        mint: mintFor(venue, "disc:" + symbol),
        symbol,
        name,
        venue,
        status: graduated ? "graduated" : "curve",
        decimals: DECIMALS[venue],
        priceSol: plain(price, 4),
        marketCapSol: trimDecimals(mcap, 2),
        createdAt: now - Math.floor((i + rnd()) * 6 * 60_000),
        unzeenLaunch: false,
        ...(graduated ? {} : { curveProgressPct: trimDecimals(2 + rnd() * 95, 1) }),
        asOf: Math.floor(now / 60_000) * 60_000,
      } satisfies DiscoveryToken;
    });
  }
  return discovery.map((t) => ({ ...t }));
}
