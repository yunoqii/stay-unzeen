// In-browser mock of a Robinhood Chain origin (API v0.18: chainId 0111, PoolInfo.chain hood, venue "pons").
// Loaded only in builds with NEXT_PUBLIC_HOOD=1. Same shapes as the Solana mock, but EVM-shaped values:
// 0x mints (EIP-55), 18-decimal tokens with a 1e9 supply (1e27 base units — far past 2^53, so every amount
// here is a BigInt string), ETH amounts in wei in the *Lamports / solAmount fields, 0x tx hashes.
// Balances, deposits and shielded payouts stay with the main mock's accounts (network "hood").

import { toChecksumAddress } from "@/lib/evm";
import { isEvmAddress } from "@/lib/evm";
import { ApiError } from "./errors";
import type {
  ActionReceipt,
  ActionStatus,
  Candle,
  CandleTimeframe,
  FeedEvent,
  PlatformStats,
  PoolInfo,
  SignedAction,
  SolRateUsed,
  TokenListItem,
  TokenSafety,
  TokenTrade,
  TokenWithTrades,
} from "./types";

export interface HoodAccount {
  zecBalance: bigint;
  zecHeld: bigint;
  holdings: { mint: string; amount: string; held: string }[];
}

export interface HoodHost {
  account(pubkey: string): HoodAccount;
  /** The rest of PoolInfo (minimums, fees shape, address on Zcash mainnet). */
  basePool(): PoolInfo;
  /** USD prices for the ETH rate. */
  zecPerEth(): number;
}

const ZAT = BigInt(100_000_000);
const N0 = BigInt(0);
const DEC = 18;
const SUPPLY = 1_000_000_000;
const SPREAD_BPS = BigInt(50);
const TF_SEC: Record<CandleTimeframe, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };
const CREATE_FEE_ZAT = BigInt(100_000);
/** v0.22: PoolInfo.chain.priceMaxAgeSecs (server default). */
const PRICE_MAX_AGE_S = 300;
/** Gas dropped with every withdrawn part on Robinhood Chain (≈ $0.25), wei. */
const WITHDRAW_GAS_WEI = BigInt("90000000000000");

const SEED: [string, string, number, number][] = [
  ["HOODIE", "Hoodie", 4.1e-9, 3],
  ["PLUME", "Plume", 1.6e-8, 2],
  ["TENDIE", "Tendies", 7.4e-10, 3],
  ["QUILL", "Quill", 2.2e-9, 1],
  ["STONKY", "Stonky", 5.5e-8, 2],
  ["GLINT", "Glint", 9.8e-10, 1],
];

function seeded(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const hex = (n: number, rnd: () => number = Math.random) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join("");
const addr = (seed: string) => toChecksumAddress("0x" + hex(40, seeded(seed)));
const txHash = () => "0x" + hex(64);
const hex16 = () => hex(32);
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Whole units (float) -> base units, exact enough for 18 decimals (6 significant digits kept). */
function toBase(whole: number, decimals: number): bigint {
  if (!(whole > 0)) return N0;
  const e = Math.floor(Math.log10(whole));
  const scale = 5 - e; // ~6 significant digits as an integer mantissa
  const mant = BigInt(Math.round(whole * 10 ** scale));
  const shift = decimals - scale;
  return shift >= 0 ? mant * BigInt(10) ** BigInt(shift) : mant / BigInt(10) ** BigInt(-shift);
}
/** Base units -> whole units (float), display / simulation only. */
const toWhole = (v: bigint, decimals: number) => Number(v / BigInt(10) ** BigInt(Math.max(0, decimals - 6))) / 10 ** Math.min(6, decimals);

function plain(n: number, sig = 6): string {
  if (!(n > 0)) return "0";
  const d = Math.max(0, sig - 1 - Math.floor(Math.log10(n)));
  return n.toFixed(Math.min(20, d)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

interface HoodToken {
  token: TokenListItem;
  price: number; // ETH per whole token
  heat: number;
  progress: number;
  /** v0.22: when the pool last priced this token (unix ms); older than PRICE_MAX_AGE_S -> 503 stale_price. */
  priceAt: number;
  /** Mock only: after a stale_price answer the pool "reprices" the token here, inside the 60 s Retry-After. */
  refreshAt?: number;
}

interface HoodAction {
  id: string;
  pubkey: string;
  action: SignedAction;
  status: ActionStatus;
  holdZat: bigint;
  holdToken?: { mint: string; amount: bigint };
}

export interface HoodMock {
  pool(): PoolInfo;
  feed(limit: number): FeedEvent[];
  tokens(): TokenListItem[];
  token(mint: string): TokenWithTrades | null;
  trades(mint: string, filter: string | null, limit: number): TokenTrade[];
  candles(mint: string, tf: CandleTimeframe, from?: number, to?: number): Candle[];
  safety(mint: string): TokenSafety | null;
  stats(): PlatformStats;
  submit(pubkey: string, action: SignedAction): ActionReceipt;
  actions(pubkey: string): (ActionStatus & { id: string; kind: "buy" | "sell" | "create" | "withdraw_token" })[];
  action(pubkey: string, id: string): ActionStatus | null;
  subscribe(onEvent: (e: FeedEvent) => void, mint?: string): () => void;
}

export function createHoodMock(host: HoodHost): HoodMock {
  const now0 = Date.now();
  const tokens: HoodToken[] = SEED.map(([symbol, name, price, heat], i) => ({
    token: {
      mint: addr("hood-mint:" + symbol),
      symbol,
      name,
      venue: "pons",
      status: i === 4 ? "graduated" : "curve",
      decimals: DEC,
      priceSol: "0",
      marketCapSol: "0",
      createdAt: now0 - (i + 1) * 47 * 60_000,
      quote: "SOL",
      unzeenLaunch: i === 0,
      volume24hSol: "0",
      unzeenTrades24h: 0,
    },
    price,
    heat,
    progress: i === 4 ? 100 : 18 + i * 13,
    // The last seed token starts with a stale pool price (demo of 503 stale_price) until a trade reprices it.
    priceAt: i === SEED.length - 1 ? now0 - 2 * PRICE_MAX_AGE_S * 1000 : now0,
  }));
  const history: FeedEvent[] = [];
  const actions = new Map<string, HoodAction>();
  const subs = new Set<{ fn: (e: FeedEvent) => void; mint?: string }>();

  const sync = () => {
    for (const t of tokens) {
      t.token.priceSol = plain(t.price);
      t.token.marketCapSol = plain(t.price * SUPPLY, 4);
      const day = history.filter((e) => e.mint === t.token.mint && Date.now() - e.ts < 86_400_000 && e.kind !== "create");
      t.token.volume24hSol = plain(day.reduce((x, e) => x + toWhole(BigInt(e.solAmount), DEC), 0), 4);
      t.token.unzeenTrades24h = day.length;
      if (t.token.status === "curve") t.token.curveProgressPct = String(Math.min(99, Math.round(t.progress)));
    }
  };

  const weiPerZec = (buy: boolean) => {
    const mid = BigInt(Math.round(host.zecPerEth() * 1e9)) * BigInt(1e9);
    return buy ? (mid * (BigInt(10_000) - SPREAD_BPS)) / BigInt(10_000) : (mid * (BigInt(10_000) + SPREAD_BPS)) / BigInt(10_000);
  };
  const rate = (buy: boolean): SolRateUsed => ({ lamportsPerZec: weiPerZec(buy).toString(), source: "near-1click", ts: Math.floor(Date.now() / 60_000) * 60_000 });

  function event(t: HoodToken, kind: FeedEvent["kind"], wei: bigint, amount: bigint, ts = Date.now()): FeedEvent {
    return { id: hex16(), kind, venue: "pons", mint: t.token.mint, symbol: t.token.symbol, tokenAmount: amount.toString(), solAmount: wei.toString(), decimals: DEC, solanaTx: txHash(), ts };
  }

  function publish(e: FeedEvent) {
    history.unshift(e);
    if (history.length > 400) history.length = 400;
    for (const s of subs) if (!s.mint || s.mint === e.mint) s.fn(e);
  }

  function randomTrade(ts: number, mutate: boolean): FeedEvent {
    const live = tokens.filter((t) => t.token.status === "curve");
    const t = live[Math.floor(Math.random() * live.length)];
    const eth = Math.exp(rand(Math.log(0.002), Math.log(0.6)));
    const buy = Math.random() < 0.6;
    if (mutate) {
      t.price *= 1 + (buy ? 1 : -1) * eth * 0.004;
      t.progress = Math.min(99, t.progress + (buy ? eth : -eth) * 0.8);
      t.priceAt = ts;
    }
    return event(t, buy ? "buy" : "sell", toBase(eth, DEC), toBase(eth / t.price, DEC), ts);
  }

  // ~40 minutes of back-filled public activity.
  for (let ts = now0 - 40 * 60_000; ts < now0 - 4000; ts += rand(5000, 25_000)) history.unshift(randomTrade(ts, false));
  sync();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(() => {
      publish(randomTrade(Date.now(), true));
      sync();
      if (subs.size) schedule();
      else timer = undefined;
    }, rand(2500, 7000));
  };

  const find = (mint: string) => {
    if (!isEvmAddress(mint)) throw new ApiError("bad_request", "mint: not a 0x address", 400);
    return tokens.find((t) => t.token.mint.toLowerCase() === mint.toLowerCase()) ?? null;
  };

  function settle(a: HoodAction) {
    if (a.status.status !== "queued") return;
    const acc = host.account(a.pubkey);
    const x = a.action;
    const holding = (mint: string) => {
      let h = acc.holdings.find((y) => y.mint === mint);
      if (!h) acc.holdings.push((h = { mint, amount: "0", held: "0" }));
      return h;
    };
    const execAt = Math.floor(Date.now() / 60_000) * 60_000;
    if (x.op === "buy" || x.op === "create") {
      const t = x.op === "buy" ? find(x.mint)! : a.holdToken ? find(a.holdToken.mint)! : null;
      const zat = x.op === "buy" ? BigInt(x.zecIn) : a.holdZat - CREATE_FEE_ZAT;
      const wei = (zat * weiPerZec(true)) / ZAT;
      acc.zecHeld -= a.holdZat;
      if (!t) return;
      const out = zat > N0 ? toBase(toWhole(wei, DEC) / t.price, DEC) : N0;
      if (x.op === "buy" && out < BigInt(x.minOut)) {
        acc.zecBalance += a.holdZat;
        a.status = { status: "failed", error: "slippage", rate: a.status.rate };
        return;
      }
      if (out > N0) {
        const h = holding(t.token.mint);
        h.amount = (BigInt(h.amount) + out).toString();
        t.price *= 1 + toWhole(wei, DEC) * 0.004;
        t.priceAt = Date.now();
      }
      const e = event(t, x.op === "buy" ? "buy" : "create", wei, out);
      publish(e);
      sync();
      a.status = { status: "executed", solanaTx: e.solanaTx, executedAt: execAt, rate: a.status.rate, fill: { tokenAmount: out.toString(), solAmount: wei.toString(), zecSpent: zat.toString(), ...(x.op === "create" ? { mint: t.token.mint } : {}) } };
    } else if (x.op === "sell") {
      const t = find(x.mint)!;
      const amount = a.holdToken!.amount;
      const wei = toBase(toWhole(amount, DEC) * t.price, DEC);
      const zat = (wei * ZAT) / weiPerZec(false);
      const h = holding(t.token.mint);
      h.held = (BigInt(h.held) - amount).toString();
      if (zat < BigInt(x.minZecOut)) {
        h.amount = (BigInt(h.amount) + amount).toString();
        a.status = { status: "failed", error: "slippage", rate: a.status.rate };
        return;
      }
      acc.zecBalance += zat;
      t.price *= 1 - toWhole(wei, DEC) * 0.004;
      const e = event(t, "sell", wei, amount);
      publish(e);
      sync();
      a.status = { status: "executed", solanaTx: e.solanaTx, executedAt: execAt, rate: a.status.rate, fill: { tokenAmount: amount.toString(), solAmount: wei.toString(), zecCredited: zat.toString() } };
    } else if (x.op === "withdraw_token") {
      const h = holding(x.mint);
      h.held = (BigInt(h.held) - a.holdToken!.amount).toString();
      acc.zecHeld -= a.holdZat;
      // Transfers from another vault: not a trade, nothing in the feed.
      a.status = { status: "executed", solanaTx: txHash(), executedAt: execAt, rate: a.status.rate, fill: { tokenAmount: a.holdToken!.amount.toString() } };
    }
    acc.holdings = acc.holdings.filter((y) => y.amount !== "0" || y.held !== "0");
  }

  return {
    pool() {
      const base = host.basePool();
      return {
        ...base,
        chainId: "0111",
        network: "main",
        chain: { id: "hood", network: "hood", mainnet: true, native: { symbol: "ETH", decimals: 18 }, evmChainId: 4663, priceMaxAgeSecs: PRICE_MAX_AGE_S },
        venues: [{ venue: "pons", trade: true, create: true, quotes: ["SOL"], atomicFirstBuy: true, creatorFees: true, mainnetOnly: true }],
        quotes: [],
        fees: { ...base.fees, withdrawTokenGasLamports: WITHDRAW_GAS_WEI.toString(), withdrawTokenCostLamports: "0" },
        launchRules: { lockSecs: 86_400, capBps: 500, maxInitialBuyLamports: "500000000000000000", maxInitialBuyLamportsByVenue: { pons: "500000000000000000" } },
        rate: { lamportsPerZec: weiPerZec(true).toString(), lamportsPerZecBuy: weiPerZec(true).toString(), lamportsPerZecSell: weiPerZec(false).toString(), spreadBps: Number(SPREAD_BPS), source: "fixed", ts: Math.floor(Date.now() / 60_000) * 60_000 },
        // Orders, chat, scenarios and the sealed-bid launch are Solana-only for now.
        features: { fullTrades: false },
        orders: undefined,
        chat: undefined,
        scenarios: undefined,
        createEnabled: true,
      };
    },
    feed: (limit) => history.slice(0, Math.min(limit, 200)),
    tokens: () => tokens.filter((t) => t.heat > 0).map((t) => ({ ...t.token })),
    token(mint) {
      const t = find(mint);
      return t ? { ...t.token, trades: history.filter((e) => e.mint === t.token.mint).slice(0, 50) } : null;
    },
    trades(mint, filter, limit) {
      const t = find(mint);
      if (!t) throw new ApiError("not_found", "unknown token", 404);
      const rnd = seeded("traders:" + mint);
      return history
        .filter((e) => e.mint === t.token.mint)
        .slice(0, limit)
        .map((e) => ({ ...e, trader: rnd() < 0.5 ? "unzeen" : toChecksumAddress("0x" + hex(40, rnd)), tags: [] as TokenTrade["tags"] }))
        .filter((e) => filter !== "unzeen" || e.trader === "unzeen");
    },
    candles(mint, tf, from, to) {
      const t = find(mint);
      if (!t) throw new ApiError("not_found", "unknown token", 404);
      const step = TF_SEC[tf];
      const nowSec = Math.floor(Date.now() / 1000);
      const end = Math.floor(Math.min(to ?? nowSec, nowSec) / step) * step;
      const start = Math.max(from !== undefined ? Math.ceil(from / step) * step : end - 199 * step, Math.floor(t.token.createdAt / 1000 / step) * step);
      const rnd = seeded(`hood-candles:${mint}:${tf}`);
      const bars: Candle[] = [];
      let close = t.price;
      for (let s = end; s >= start; s -= step) {
        const v = 0.014 * Math.sqrt(step / 60);
        const open = close * Math.exp((rnd() - 0.52) * 2 * v);
        bars.push({
          time: s,
          open: plain(open),
          high: plain(Math.max(open, close) * (1 + rnd() * v)),
          low: plain(Math.min(open, close) * (1 - rnd() * v)),
          close: plain(close),
          volume: toBase(0.01 + rnd() * 0.4 * Math.sqrt(step / 60), DEC).toString(),
        });
        close = open;
      }
      return bars.reverse();
    },
    safety(mint) {
      const t = find(mint);
      if (!t) return null;
      const rnd = seeded("hood-safety:" + mint);
      const asOf = Math.floor(Date.now() / 60_000) * 60_000;
      return {
        mint: t.token.mint,
        asOf,
        program: "spl-token",
        // Pons V2 tokens have a fixed supply and no freeze: both read as revoked.
        authorities: { mintRevoked: true, freezeRevoked: true, metadataImmutable: true, riskyExtensions: [] },
        holders: { top10Pct: plain(14 + rnd() * 30, 3), devPct: t.token.unzeenLaunch ? null : plain(rnd() * 6, 2), unzeenPoolPct: plain(rnd() * 4, 2), asOf },
        market: { venue: "pons", status: t.token.status, ...(t.token.status === "curve" ? { curveProgressPct: String(Math.round(t.progress)) } : {}) },
        ...(t.token.unzeenLaunch ? { unzeen: { launch: true as const, rules: ["creator_initial_buy_locked_24h", "initial_buy_cap_5pct", "authorities_revoked"] } } : {}),
      };
    },
    stats() {
      const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
      const k = { volumeSol: "<5" as const, trades: "<5" as const, launches: "<5" as const };
      return {
        asOf: day,
        volumeSol: "<5",
        trades: "<5",
        launches: "<5",
        zecShielded: "<5",
        byVenue: { pumpfun: k, "meteora-dbc": k, jupiter: k, "raydium-launchlab": k, bags: k, pons: k },
        topTokens: [],
        topWindowDays: 7,
      };
    },
    submit(pubkey, x) {
      const acc = host.account(pubkey);
      const minAction = BigInt(host.basePool().minActionZat);
      const queued = (r: SolRateUsed | undefined) => ({ status: "queued" as const, ...(r ? { rate: r } : {}) });
      const amountOf = (v: unknown, field: string) => {
        if (typeof v !== "string" || !/^[1-9]\d{0,37}$/.test(v)) throw new ApiError("bad_request", `${field}: positive integer string, up to 38 digits`, 400);
        return BigInt(v);
      };
      let a: HoodAction;
      const id = hex16();
      if (x.op === "buy" || x.op === "sell") {
        if (x.venue !== "pons") throw new ApiError("venue_unavailable", "this origin trades on pons", 503);
        const t = find(x.mint);
        if (!t) throw new ApiError("not_found", "unknown token", 404);
        if (t.token.status === "graduated") throw new ApiError("graduated", "token left the bonding curve", 409);
        // v0.22: no zero price limit on this origin, and no trade on a stale pool price (both before any hold).
        amountOf(x.op === "buy" ? x.minOut : x.minZecOut, x.op === "buy" ? "minOut" : "minZecOut");
        if (t.refreshAt !== undefined && Date.now() >= t.refreshAt) [t.priceAt, t.refreshAt] = [t.refreshAt, undefined];
        if (!(t.price > 0) || Date.now() - t.priceAt > PRICE_MAX_AGE_S * 1000) {
          t.refreshAt ??= Date.now() + 45_000;
          throw new ApiError("stale_price", "no fresh pool price for this token", 503, undefined, 60);
        }
        if (x.op === "buy") {
          const zat = amountOf(x.zecIn, "zecIn");
          if (zat < minAction) throw new ApiError("below_minimum", "zecIn below minActionZat", 422);
          if (acc.zecBalance < zat) throw new ApiError("insufficient_balance", "not enough ZEC", 422);
          acc.zecBalance -= zat;
          acc.zecHeld += zat;
          a = { id, pubkey, action: x, holdZat: zat, status: queued(rate(true)) };
        } else {
          const amount = amountOf(x.amount, "amount");
          const h = acc.holdings.find((y) => y.mint === t.token.mint);
          if (!h || BigInt(h.amount) < amount) throw new ApiError("insufficient_balance", "not enough tokens", 422);
          h.amount = (BigInt(h.amount) - amount).toString();
          h.held = (BigInt(h.held) + amount).toString();
          a = { id, pubkey, action: x, holdZat: N0, holdToken: { mint: t.token.mint, amount }, status: queued(rate(false)) };
        }
      } else if (x.op === "create") {
        if (x.venue !== "pons") throw new ApiError("bad_request", "venue: pons on this origin", 400);
        if ((x.quote ?? "SOL") !== "SOL") throw new ApiError("bad_request", "pons: ETH pairs only", 400);
        const initial = x.initialBuyZec ? amountOf(x.initialBuyZec, "initialBuyZec") : N0;
        const total = initial + CREATE_FEE_ZAT;
        if (acc.zecBalance < total) throw new ApiError("insufficient_balance", "not enough ZEC", 422);
        acc.zecBalance -= total;
        acc.zecHeld += total;
        const t: HoodToken = {
          token: { mint: toChecksumAddress("0x" + hex(40)), symbol: x.meta.symbol, name: x.meta.name, image: x.meta.image, venue: "pons", status: "curve", decimals: DEC, priceSol: "0", marketCapSol: "0", createdAt: Date.now(), quote: "SOL", unzeenLaunch: true, volume24hSol: "0", unzeenTrades24h: 0 },
          price: 2.5e-9,
          heat: 3,
          progress: 1,
          priceAt: Date.now(),
        };
        tokens.push(t);
        a = { id, pubkey, action: x, holdZat: total, holdToken: { mint: t.token.mint, amount: N0 }, status: queued(rate(true)) };
      } else if (x.op === "withdraw_token") {
        const t = find(x.mint);
        if (!t) throw new ApiError("not_found", "unknown token", 404);
        const dests = Array.isArray(x.to) ? x.to : [x.to];
        if (dests.some((d) => typeof d !== "string" || !isEvmAddress(d))) throw new ApiError("bad_request", "to: not a 0x address (EIP-55)", 400);
        if (new Set(dests.map((d) => d.toLowerCase())).size !== dests.length) throw new ApiError("bad_request", "to: addresses must be distinct", 400);
        const amount = amountOf(x.amount, "amount");
        const h = acc.holdings.find((y) => y.mint === t.token.mint);
        if (!h || BigInt(h.amount) < amount) throw new ApiError("insufficient_balance", "not enough tokens", 422);
        const gasZat = (BigInt(dests.length) * WITHDRAW_GAS_WEI * ZAT + weiPerZec(true) - BigInt(1)) / weiPerZec(true);
        if (acc.zecBalance < gasZat) throw new ApiError("insufficient_balance", "not enough ZEC for gas", 422);
        // A1: never the exact amount — shaved 0.5–2 %, rounded down to 3 significant digits.
        const shaved = (amount * BigInt(10_000 - Math.round(rand(50, 200)))) / BigInt(10_000);
        const digits = shaved.toString().length;
        const unit = digits > 3 ? BigInt(10) ** BigInt(digits - 3) : BigInt(1);
        const sent = (shaved / unit) * unit;
        acc.zecBalance -= gasZat;
        acc.zecHeld += gasZat;
        h.amount = (BigInt(h.amount) - sent).toString();
        h.held = (BigInt(h.held) + sent).toString();
        a = { id, pubkey, action: { ...x, amount: sent.toString() }, holdZat: gasZat, holdToken: { mint: t.token.mint, amount: sent }, status: queued(rate(true)) };
      } else throw new ApiError("bad_request", `${x.op} is not available on this chain yet`, 400);
      actions.set(id, a);
      const exec = "exec" in x ? x.exec : undefined;
      setTimeout(() => settle(a), exec === "now" ? rand(1000, 3000) : exec === "max" ? rand(25_000, 45_000) : rand(8000, 15_000));
      return { id, status: "queued", ...(a.status.rate ? { rate: a.status.rate } : {}) };
    },
    actions: (pubkey) =>
      [...actions.values()].filter((a) => a.pubkey === pubkey).map((a) => ({ id: a.id, kind: a.action.op as "buy" | "sell" | "create" | "withdraw_token", ...a.status })),
    action(pubkey, id) {
      const a = actions.get(id);
      return a && a.pubkey === pubkey ? structuredClone(a.status) : null;
    },
    subscribe(fn, mint) {
      const s = { fn, mint };
      subs.add(s);
      if (!timer) schedule();
      return () => void subs.delete(s);
    },
  };
}
