import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { DBC_PROGRAM_ID } from "../meteora";

/**
 * Full trade feed of the WARM SET (INTEL.md `market_trades`, behind UNZEEN_INTEL_FULL_TRADES=1).
 *
 * Source: Helius Parsed Streams (`parsedTransactionSubscribe`, WS, 1 credit per delivered tx),
 * available on our current plan (checked live 13.10; `transactionSubscribe` is not: "Method not
 * available on your current plan"). The notification carries the decoded venue EVENT (executed
 * amounts), not only the instruction:
 * - pump.fun: `TradeEvent` (user, mint, sol_amount, token_amount, is_buy, quote_mint, timestamp);
 * - Meteora DBC: `EvtSwap2` (pool, trade_direction, swap_result) + `swap2` accounts (payer, base_mint, quote_mint);
 * - Raydium LaunchLab: `TradeEvent` (trade_direction, amount_in/out) + accounts (payer, base_token_mint, quote_token_mint).
 * Filter: those three programs, their trade instructions (CPI included: aggregator routes), and
 * `accounts.include` = the MINTS of the subscription set (every trade instruction of the three
 * venues carries the mint), failed tx excluded server-side. SOL pairs only (market_trades has no
 * quote columns).
 *
 * Privacy (INTEL.md): the mint list changes only on the indexer tick, by the SubscriptionPlanner
 * (hot warm mints + decoys, fixed number of changes); trades are kept in memory until the tick
 * transaction; decoy trades are dropped. Budget guard: at most `maxPerHour` notifications per hour,
 * then the stream is closed until the hour ends. The URL carries the API key: never logged.
 */

export const LAUNCHLAB_PROGRAM_ID = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const WSOL = "So11111111111111111111111111111111111111112";
const SYSTEM = "11111111111111111111111111111111";

/** Trade instructions (Helius catalog names) of the three venues. */
export const TRADE_IX = [
  // pump.fun (IDL 4.0.0)
  "buy", "buy_v2", "buy_v3", "buy_exact_sol_in", "buy_exact_quote_in_v2", "buy_exact_quote_in_v3", "sell", "sell_v2", "sell_v3",
  // Meteora DBC
  "swap", "swap2", "swap2_with_transfer_hook",
  // Raydium LaunchLab
  "buy_exact_in", "buy_exact_out", "sell_exact_in", "sell_exact_out",
] as const;

export type TradeVenue = "pumpfun" | "meteora-dbc" | "raydium-launchlab";

/** One executed trade, public chain data. */
export interface MarketTrade {
  mint: string;
  kind: "buy" | "sell";
  venue: TradeVenue;
  /** Signer of the trade (pump: TradeEvent.user; DBC / LaunchLab: the instruction's payer). */
  trader: string;
  tokenAmount: bigint;
  /** Lamports paid (buy) / received (sell), venue fees included. */
  solAmount: bigint;
  signature: string;
  /** Position of the event in the tx (`market_trades.ix`, UNIQUE with the signature). */
  ix: number;
  slot: number;
  /** unix ms (event timestamp; LaunchLab has none -> receipt time). */
  ts: number;
}

export function tradeStreamRequest(mints: readonly string[], id = 1): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "parsedTransactionSubscribe",
    params: [
      {
        programs: [PUMP_PROGRAM_ID.toBase58(), DBC_PROGRAM_ID.toBase58(), LAUNCHLAB_PROGRAM_ID],
        instructionNames: [...TRADE_IX],
        accounts: { include: [...mints] },
        includeFailed: false,
        includeCpi: true,
      },
      { commitment: "confirmed", details: "full" },
    ],
  };
}

interface ParsedIx {
  programId?: string;
  instructionName?: string;
  instructionIndex?: number;
  innerInstructionIndex?: number | null;
  decoded?: { args?: Record<string, unknown>; accounts?: Array<{ name?: string; pubkey?: string }> };
}
interface ParsedValue {
  transaction?: { signature?: string; slot?: number; blockTime?: number | null; status?: string; error?: unknown };
  instructions?: ParsedIx[];
}

const big = (v: unknown): bigint | null => {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
};
const acct = (ix: ParsedIx | undefined, name: string): string | undefined => ix?.decoded?.accounts?.find((a) => a.name === name)?.pubkey;
const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A Parsed Streams `value` -> SOL-pair trades of the three venues. Each event is paired with the
 * closest PRECEDING trade instruction of the same program in the same top-level instruction
 * (the event is its emit_cpi). Anything incomplete is skipped (never guessed).
 */
export function tradesFromParsedTx(v: unknown, receivedAt: number): MarketTrade[] {
  const val = v as ParsedValue;
  const tx = val?.transaction;
  if (!tx?.signature || (tx.status && tx.status !== "ok") || tx.error) return [];
  const ixs = val.instructions ?? [];
  const out: MarketTrade[] = [];
  const base = { signature: tx.signature, slot: tx.slot ?? 0 };
  ixs.forEach((ix, k) => {
    const name = ix.instructionName ?? "";
    const a = ix.decoded?.args ?? {};
    // the trade instruction this event belongs to
    const owner = () => {
      for (let j = k - 1; j >= 0; j--) {
        const p = ixs[j]!;
        if (p.instructionIndex !== ix.instructionIndex) break;
        if (p.programId === ix.programId && TRADE_IX.some((t) => norm(t) === norm(p.instructionName))) return p;
      }
      return undefined;
    };
    if (ix.programId === PUMP_PROGRAM_ID.toBase58() && name === "TradeEvent") {
      const quote = String(a.quote_mint ?? SYSTEM);
      if (quote !== SYSTEM && quote !== WSOL) return; // non-SOL curve
      const sol = big(a.sol_amount);
      const tok = big(a.token_amount);
      const ts = Number(a.timestamp);
      if (sol === null || tok === null || typeof a.mint !== "string" || typeof a.user !== "string" || typeof a.is_buy !== "boolean") return;
      out.push({ ...base, ix: k, mint: a.mint, kind: a.is_buy ? "buy" : "sell", venue: "pumpfun", trader: a.user, tokenAmount: tok, solAmount: sol, ts: ts > 0 ? ts * 1000 : receivedAt });
      return;
    }
    if (ix.programId === DBC_PROGRAM_ID.toBase58() && name === "EvtSwap2") {
      const sw = owner();
      const mint = acct(sw, "base_mint");
      const trader = acct(sw, "payer");
      if (!sw || !mint || !trader || acct(sw, "quote_mint") !== WSOL) return;
      const r = (a.swap_result ?? {}) as Record<string, unknown>;
      const input = big(r.included_fee_input_amount);
      const output = big(r.output_amount);
      const dir = Number(a.trade_direction); // 1 = quote -> base (buy), 0 = base -> quote (sell)
      if (input === null || output === null || (dir !== 0 && dir !== 1)) return;
      const ts = Number(a.current_timestamp);
      const buy = dir === 1;
      out.push({ ...base, ix: k, mint, kind: buy ? "buy" : "sell", venue: "meteora-dbc", trader, tokenAmount: buy ? output : input, solAmount: buy ? input : output, ts: ts > 0 ? ts * 1000 : receivedAt });
      return;
    }
    if (ix.programId === LAUNCHLAB_PROGRAM_ID && name === "TradeEvent") {
      const sw = owner();
      const mint = acct(sw, "base_token_mint");
      const trader = acct(sw, "payer");
      if (!sw || !mint || !trader || acct(sw, "quote_token_mint") !== WSOL) return;
      const inp = big(a.amount_in);
      const outp = big(a.amount_out);
      const dir = String(a.trade_direction);
      if (inp === null || outp === null || (dir !== "Buy" && dir !== "Sell")) return;
      const buy = dir === "Buy";
      out.push({ ...base, ix: k, mint, kind: buy ? "buy" : "sell", venue: "raydium-launchlab", trader, tokenAmount: buy ? outp : inp, solAmount: buy ? inp : outp, ts: receivedAt });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// tags (pure)
// ---------------------------------------------------------------------------

export interface TagContext {
  /** Pool vaults: their trades are `unzeen` (API shows "unzeen"), never `dev`. */
  poolVaults: ReadonlySet<string>;
  /** Mints launched by Unzeen (T1): no `dev` tag at all. */
  unzeenLaunches: ReadonlySet<string>;
  /** mint -> dev (CreateEvent.user / pool creator); unknown = no dev tag. */
  devOf: (mint: string) => string | undefined;
  /** mint -> create slot; unknown = no sniper tag. */
  createSlotOf: (mint: string) => number | undefined;
  whaleLamports: bigint;
  sniperSlots: number;
}

export function tagTrade(t: MarketTrade, c: TagContext): { unzeen: boolean; tags: ("whale" | "dev" | "sniper")[] } {
  const unzeen = c.poolVaults.has(t.trader);
  const tags: ("whale" | "dev" | "sniper")[] = [];
  if (t.solAmount >= c.whaleLamports) tags.push("whale");
  const dev = c.unzeenLaunches.has(t.mint) ? undefined : c.devOf(t.mint);
  const isDev = !unzeen && dev !== undefined && dev === t.trader;
  if (isDev) tags.push("dev");
  const cs = c.createSlotOf(t.mint);
  if (!unzeen && !isDev && t.kind === "buy" && cs !== undefined && t.slot >= cs && t.slot <= cs + c.sniperSlots) tags.push("sniper");
  return { unzeen, tags };
}

// ---------------------------------------------------------------------------
// stream client
// ---------------------------------------------------------------------------

export interface TradeSource {
  /** Called on the indexer tick only: the full mint list of the subscription set. */
  setMints(mints: readonly string[]): void;
  drain(): MarketTrade[];
  stop(): void;
}

type WsLike = {
  send(d: string): void;
  close(): void;
  addEventListener(t: "open" | "message" | "close" | "error", f: (e: { data?: unknown }) => void): void;
};

export class ParsedTradeStream implements TradeSource {
  private ws: WsLike | null = null;
  private open = false;
  private mints: string[] = [];
  private subId: number | null = null;
  private reqId = 1;
  private buf: MarketTrade[] = [];
  private stopped = false;
  private hourStart = 0;
  private hourEvents = 0;
  private pausedUntil = 0;
  private backoffMs = 5_000;
  /** Diagnostics: counts only. */
  events = 0;
  dropped = 0;

  constructor(
    private readonly url: string,
    private readonly o: { maxPerHour?: number; maxBuffer?: number; now?: () => number; connect?: (url: string) => WsLike } = {},
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  setMints(mints: readonly string[]): void {
    const next = [...new Set(mints)].sort();
    if (next.join() === this.mints.join()) return;
    this.mints = next;
    if (this.mints.length === 0) {
      this.ws?.close();
      return;
    }
    if (!this.ws) this.connect();
    else if (this.open) this.resubscribe();
  }

  private connect(): void {
    if (this.stopped || this.mints.length === 0) return;
    if (this.now() < this.pausedUntil) {
      setTimeout(() => this.connect(), this.pausedUntil - this.now()).unref?.();
      return;
    }
    const ws = (this.o.connect ?? ((u: string) => new WebSocket(u) as unknown as WsLike))(this.url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.open = true;
      this.backoffMs = 5_000;
      this.subId = null;
      this.resubscribe();
    });
    ws.addEventListener("message", (e) => this.onMessage(e.data));
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.open = false;
      this.subId = null;
      if (this.stopped || this.mints.length === 0) return;
      const wait = Math.max(this.backoffMs, this.pausedUntil - this.now());
      this.backoffMs = Math.min(this.backoffMs * 2, 300_000);
      setTimeout(() => this.connect(), wait).unref?.();
    });
    ws.addEventListener("error", () => undefined);
  }

  private resubscribe(): void {
    if (!this.ws) return;
    if (this.subId !== null) this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++this.reqId, method: "parsedTransactionUnsubscribe", params: [this.subId] }));
    this.subId = null;
    this.ws.send(JSON.stringify(tradeStreamRequest(this.mints, ++this.reqId)));
  }

  /** Exposed for tests. */
  onMessage(data: unknown): void {
    let msg: { id?: number; result?: unknown; method?: string; params?: { result?: { value?: unknown } } };
    try {
      msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8"));
    } catch {
      return;
    }
    if (msg.id === this.reqId && typeof msg.result === "number") {
      this.subId = msg.result;
      return;
    }
    if (msg.method !== "parsedTransactionNotification") return;
    const now = this.now();
    if (now - this.hourStart >= 3_600_000) {
      this.hourStart = now;
      this.hourEvents = 0;
    }
    this.hourEvents++;
    this.events++;
    const keep = new Set(this.mints);
    for (const t of tradesFromParsedTx(msg.params?.result?.value, now)) if (keep.has(t.mint)) this.buf.push(t);
    const max = this.o.maxBuffer ?? 20_000;
    if (this.buf.length > max) {
      this.dropped += this.buf.length - max;
      this.buf.splice(0, this.buf.length - max);
    }
    if (this.hourEvents >= (this.o.maxPerHour ?? 600)) {
      this.pausedUntil = this.hourStart + 3_600_000;
      this.ws?.close();
    }
  }

  drain(): MarketTrade[] {
    const out = this.buf;
    this.buf = [];
    return out;
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }
}
