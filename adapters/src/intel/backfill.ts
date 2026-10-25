import { bondingCurvePda, canonicalPumpPoolPda } from "@pump-fun/pump-sdk";
import { deriveDbcPoolAuthority } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { LAUNCHPAD_PROGRAM, getPdaLaunchpadAuth } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import { rateLimitedFetch } from "./reader";
import type { MarketTrade, TradeVenue } from "./trades";

/**
 * Recent-trade backfill (docs/INTEL.md "Бэкфилл сделок", 24.10).
 *
 * Token pages of mints outside the pool (discovery / Pulse, searched CAs) had no trade list and
 * sample-only candles: the live stream follows only hot pool mints. This lane reads the latest
 * public trades of a FIXED set of mints per main tick on the index provider (Helius):
 * - every mint of the main tick batch (<= 4 queued CAs + decoys, the exact 8 that provider
 *   already sees through getTokenLargestAccounts on the same tick), all treated identically;
 * - up to N discovery candidates chosen by the indexer itself (Pulse columns, on-chain activity),
 *   never by what anyone opens.
 * Per mint: getSignaturesForAddress(mint, until = last seen, limit 100) — 1 credit; new bodies by
 * getTransaction (1 credit each) when < 10, else ONE getTransactionsForAddress page (10 credits per
 * 100 txs). Body credits per tick are capped (`maxTxCredits`). Trades are parsed from the pool's
 * balance deltas (venue-agnostic: pump.fun curve, PumpSwap, Meteora DBC / DAMM v2, LaunchLab).
 * Decoy trades are stored like any other (public data; nothing records which mint was asked for).
 * Logs: counts only.
 */

export const WSOL = "So11111111111111111111111111111111111111112";
/** Meteora DAMM v2 (cp-amm) pool authority: owner of every DAMM v2 vault. */
export const DAMM_V2_POOL_AUTHORITY = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC";
const DBC_AUTHORITY = deriveDbcPoolAuthority().toBase58();
const LAUNCHLAB_AUTHORITY = getPdaLaunchpadAuth(LAUNCHPAD_PROGRAM).publicKey.toBase58();

export interface PoolSide {
  owner: string;
  venue: TradeVenue;
  /** Where the SOL side lives: native lamports of `owner` (pump.fun curve) or a WSOL vault it owns. */
  quote: "lamports" | "wsol";
}

/** Pool accounts that can be on the other side of a trade of `mint` (most specific first). */
export function poolSides(mint: string): PoolSide[] {
  const pk = new PublicKey(mint);
  return [
    { owner: bondingCurvePda(pk).toBase58(), venue: "pumpfun", quote: "lamports" },
    { owner: canonicalPumpPoolPda(pk).toBase58(), venue: "pumpfun", quote: "wsol" },
    { owner: DBC_AUTHORITY, venue: "meteora-dbc", quote: "wsol" },
    { owner: DAMM_V2_POOL_AUTHORITY, venue: "meteora-dbc", quote: "wsol" },
    { owner: LAUNCHLAB_AUTHORITY, venue: "raydium-launchlab", quote: "wsol" },
  ];
}

interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}
/** getTransaction / getTransactionsForAddress `encoding: "json"` shape (fields we read). */
export interface RawTx {
  slot: number;
  blockTime?: number | null;
  transaction: { signatures: string[]; message: { accountKeys: (string | { pubkey: string })[] } };
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RawTokenBalance[] | null;
    postTokenBalances?: RawTokenBalance[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
}

export type BackfillTrade = MarketTrade & { decimals: number };

/**
 * The net trade of `mint` in one landed tx, from the pool side's balance deltas: the pool gave
 * tokens and took SOL = buy, the reverse = sell. Trader = fee payer. Liquidity moves (both sides
 * the same sign), creates, migrations and anything ambiguous (several vaults of the side) -> null.
 */
export function tradeFromRawTx(tx: RawTx, mint: string, sides: readonly PoolSide[], receivedAt: number): BackfillTrade | null {
  const meta = tx.meta;
  const sig = tx.transaction?.signatures?.[0];
  if (!meta || meta.err || !sig) return null;
  const keys = [
    ...tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey)),
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ];
  const trader = keys[0];
  if (!trader) return null;
  let decimals: number | null = null;
  const deltas = (pred: (b: RawTokenBalance) => boolean): Map<number, bigint> => {
    const m = new Map<number, bigint>();
    for (const [arr, sign] of [[meta.preTokenBalances, -1n], [meta.postTokenBalances, 1n]] as const) {
      for (const b of arr ?? []) {
        if (!pred(b)) continue;
        if (b.mint === mint) decimals = b.uiTokenAmount.decimals;
        m.set(b.accountIndex, (m.get(b.accountIndex) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
      }
    }
    for (const [k, v] of m) if (v === 0n) m.delete(k);
    return m;
  };
  for (const s of sides) {
    const base = deltas((b) => b.mint === mint && b.owner === s.owner);
    if (base.size === 0) continue;
    if (base.size > 1) return null;
    const baseDelta = [...base.values()][0]!;
    let quoteDelta: bigint;
    if (s.quote === "lamports") {
      const i = keys.indexOf(s.owner);
      if (i < 0) return null;
      quoteDelta = BigInt(meta.postBalances[i] ?? 0) - BigInt(meta.preBalances[i] ?? 0);
    } else {
      const q = deltas((b) => b.mint === WSOL && b.owner === s.owner);
      if (q.size !== 1) return null;
      quoteDelta = [...q.values()][0]!;
    }
    if (quoteDelta === 0n || (baseDelta < 0n) === (quoteDelta < 0n)) return null;
    const buy = baseDelta < 0n;
    const abs = (v: bigint) => (v < 0n ? -v : v);
    const ts = typeof tx.blockTime === "number" && tx.blockTime > 0 ? tx.blockTime * 1000 : receivedAt;
    return {
      mint,
      kind: buy ? "buy" : "sell",
      venue: s.venue,
      trader,
      tokenAmount: abs(baseDelta),
      solAmount: abs(quoteDelta),
      signature: sig,
      ix: 0,
      slot: tx.slot,
      ts,
      decimals: decimals ?? 6,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// discovery picks (pure)
// ---------------------------------------------------------------------------

/** A discovery candidate as the indexer sees it (public stream; nothing user-driven). */
export interface BackfillCandidate {
  mint: string;
  priceSol: string;
  symbol?: string | null;
  venue?: TradeVenue;
}

export interface CursorState {
  /** Newest signature already read (getSignaturesForAddress `until`). */
  sig: string | null;
  /** Last backfill (unix ms). */
  at: number;
  /** Candidate price at the last backfill (activity signal). */
  price: string | null;
}

/**
 * Up to `k` candidates for this tick, in priority order: never read, price moved since the last
 * read (someone traded), read longer than `staleMs` ago. Nothing read within `minGapMs`. Input
 * order (Pulse columns, newest first) breaks ties.
 */
export function pickDiscoveryBackfill(
  cands: readonly BackfillCandidate[],
  state: ReadonlyMap<string, CursorState>,
  now: number,
  k: number,
  minGapMs = 90_000,
  staleMs = 10 * 60_000,
): BackfillCandidate[] {
  const scored: { c: BackfillCandidate; g: number; at: number; i: number }[] = [];
  cands.forEach((c, i) => {
    const s = state.get(c.mint);
    if (!s) return void scored.push({ c, g: 0, at: 0, i });
    if (now - s.at < minGapMs) return;
    if (s.price !== c.priceSol) return void scored.push({ c, g: 1, at: s.at, i });
    if (now - s.at >= staleMs) scored.push({ c, g: 2, at: s.at, i });
  });
  return scored
    .sort((a, b) => a.g - b.g || a.at - b.at || a.i - b.i)
    .slice(0, Math.max(0, k))
    .map((x) => x.c);
}

// ---------------------------------------------------------------------------
// RPC + lane
// ---------------------------------------------------------------------------

export interface SigInfo {
  signature: string;
  slot: number;
  err: unknown;
}

export interface BackfillRpc {
  signatures(address: string, o: { limit: number; until?: string }): Promise<SigInfo[]>;
  transaction(signature: string): Promise<RawTx | null>;
  /** Helius getTransactionsForAddress, full bodies, newest first, slot >= minSlot. */
  transactionsForAddress(address: string, o: { limit: number; minSlot: number }): Promise<RawTx[]>;
}

/** JSON-RPC over fetch (index provider). The URL carries the API key: never logged. */
export class JsonRpcBackfill implements BackfillRpc {
  private id = 0;
  private readonly f: typeof fetch;
  constructor(
    private readonly url: string,
    rps = 5,
    inner: typeof fetch = fetch,
  ) {
    this.f = rateLimitedFetch(rps, inner);
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const r = await this.f(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
    const j = (await r.json()) as { result?: T; error?: { code?: number } };
    if (j.error) throw new Error(`${method}: rpc error ${j.error.code ?? ""}`);
    return j.result as T;
  }

  signatures(address: string, o: { limit: number; until?: string }): Promise<SigInfo[]> {
    return this.call<SigInfo[]>("getSignaturesForAddress", [address, { limit: o.limit, commitment: "confirmed", ...(o.until ? { until: o.until } : {}) }]);
  }

  transaction(signature: string): Promise<RawTx | null> {
    return this.call<RawTx | null>("getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 }]);
  }

  async transactionsForAddress(address: string, o: { limit: number; minSlot: number }): Promise<RawTx[]> {
    const r = await this.call<{ data?: RawTx[] }>("getTransactionsForAddress", [
      address,
      {
        transactionDetails: "full",
        sortOrder: "desc",
        limit: o.limit,
        commitment: "confirmed",
        encoding: "json",
        maxSupportedTransactionVersion: 1,
        filters: { status: "succeeded", slot: { gte: o.minSlot } },
      },
    ]);
    return r?.data ?? [];
  }
}

/** Counts only (never mints). */
export interface BackfillReport {
  mints: number;
  sigCalls: number;
  txCalls: number;
  pageCalls: number;
  /** Helius credits of this pass (1 per sig / tx call, 10 per page). */
  credits: number;
  trades: number;
  errors: number;
  ms: number;
}

export interface BackfillOptions {
  rpc: BackfillRpc;
  /** Credits for transaction bodies per pass (getTransaction 1, a page of <= 100 = 10). */
  maxTxCredits: number;
  /** Signatures per mint per pass (getSignaturesForAddress limit). */
  sigLimit?: number;
  now?: () => number;
  /** Forget cursors not used for this long (default 6 h). */
  cursorTtlMs?: number;
}

const PAGE_CREDITS = 10;

export class TradeBackfill {
  readonly cursors = new Map<string, CursorState>();
  private pageOk = true;
  constructor(private readonly o: BackfillOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /**
   * One pass over `mints` (already shuffled by the caller; batch and discovery picks alike).
   * `price` = discovery price at the pick (activity cursor), if any. Never throws.
   */
  async run(mints: readonly string[], price: ReadonlyMap<string, string> = new Map()): Promise<{ trades: BackfillTrade[]; report: BackfillReport }> {
    const started = this.now();
    const rep: BackfillReport = { mints: 0, sigCalls: 0, txCalls: 0, pageCalls: 0, credits: 0, trades: 0, errors: 0, ms: 0 };
    const out: BackfillTrade[] = [];
    let budget = this.o.maxTxCredits;
    for (const mint of [...new Set(mints)]) {
      rep.mints++;
      const cur = this.cursors.get(mint);
      let sigs: SigInfo[];
      try {
        rep.sigCalls++;
        rep.credits++;
        sigs = await this.o.rpc.signatures(mint, { limit: this.o.sigLimit ?? 100, ...(cur?.sig ? { until: cur.sig } : {}) });
      } catch {
        rep.errors++;
        continue;
      }
      const fresh = sigs.filter((s) => s.err === null || s.err === undefined);
      const mark = (sig: string | null) => this.cursors.set(mint, { sig, at: started, price: price.get(mint) ?? cur?.price ?? null });
      if (fresh.length === 0) {
        mark(sigs[0]?.signature ?? cur?.sig ?? null);
        continue;
      }
      if (budget <= 0) continue; // cursor untouched: read on a later pass
      const sides = poolSides(mint);
      const txs: RawTx[] = [];
      // Newest signature whose body was read; the cursor (`until`) never moves past it (L6).
      let cursor = sigs[0]!.signature;
      try {
        if (fresh.length >= PAGE_CREDITS && this.pageOk && budget >= PAGE_CREDITS) {
          rep.pageCalls++;
          rep.credits += PAGE_CREDITS;
          budget -= PAGE_CREDITS;
          const minSlot = Math.min(...fresh.map((s) => s.slot));
          try {
            txs.push(...(await this.o.rpc.transactionsForAddress(mint, { limit: Math.min(100, fresh.length), minSlot })));
          } catch (e) {
            this.pageOk = false; // plan without getTransactionsForAddress: single bodies from now on
            throw e;
          }
        } else {
          // Over budget: read the OLDEST `budget` new signatures and set the cursor to the newest
          // of those, so the newer rest comes back (after the cursor) on the next pass instead of
          // being skipped forever.
          const take = fresh.length > budget ? fresh.slice(fresh.length - budget) : fresh;
          if (take.length < fresh.length) cursor = take[0]!.signature;
          for (const s of take) {
            rep.txCalls++;
            rep.credits++;
            budget--;
            const tx = await this.o.rpc.transaction(s.signature).catch(() => null);
            if (tx) txs.push(tx);
          }
        }
      } catch {
        rep.errors++;
        continue;
      }
      const want = new Set(fresh.map((s) => s.signature));
      for (const tx of txs) {
        if (!want.has(tx.transaction?.signatures?.[0] ?? "")) continue;
        const t = tradeFromRawTx(tx, mint, sides, started);
        if (t) out.push(t);
      }
      mark(cursor);
    }
    const ttl = this.o.cursorTtlMs ?? 6 * 3_600_000;
    for (const [m, s] of this.cursors) if (started - s.at > ttl) this.cursors.delete(m);
    rep.trades = out.length;
    rep.ms = this.now() - started;
    return { trades: out, report: rep };
  }
}
