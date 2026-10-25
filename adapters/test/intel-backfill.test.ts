import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { bondingCurvePda } from "@pump-fun/pump-sdk";
import { describe, expect, it } from "vitest";
import {
  DAMM_V2_POOL_AUTHORITY,
  TradeBackfill,
  WSOL,
  pickDiscoveryBackfill,
  poolSides,
  tradeFromRawTx,
  type BackfillRpc,
  type CursorState,
  type RawTx,
  type SigInfo,
} from "../src/intel/backfill";
import { IntelIndexer } from "../src/intel/indexer";
import { MemoryIntelStore } from "../src/intel/memory-store";
import type { LargestAccount } from "../src/intel/metrics";
import type { ChainReader } from "../src/intel/reader";
import type { TradeSource } from "../src/intel/trades";
import { seededRng } from "../src/relayer/random";

/** Real mainnet txs (getTransactionsForAddress, 24.10), trimmed to the fields we read. */
const FX = JSON.parse(readFileSync(join(__dirname, "fixtures/backfill-mainnet-txs.json"), "utf8")) as Record<string, RawTx[]>;
const DAMM_MINT = "6zGP5S1jXv8SjPURRjWQaqeme7Jg9g7eA9gbMVnhN1Fe"; // graduated, Meteora DAMM v2
const DAMM_MINT2 = "6pc39BBBucYSeuPsiwVPKAxFRPvC8489xE1ngXiMnSoj";
const DBC_MINT = "8Q44Ap6DjsvsSMPucu9EGb5egRHCUeMuzrtUCxPZTP73"; // DBC curve
const PUMP_MINT = "MoPLfgYyWtSCXWyhpqoCZDYsww8DH5mEnYz9kCQpump"; // pump.fun curve

const keyS = () => Keypair.generate().publicKey.toBase58();

/** Pool side deltas of a fixture tx computed independently (owner -> sum of post - pre). */
function ownerDelta(tx: RawTx, mint: string, owner: string): bigint {
  let d = 0n;
  for (const b of tx.meta!.preTokenBalances ?? []) if (b.mint === mint && b.owner === owner) d -= BigInt(b.uiTokenAmount.amount);
  for (const b of tx.meta!.postTokenBalances ?? []) if (b.mint === mint && b.owner === owner) d += BigInt(b.uiTokenAmount.amount);
  return d;
}

describe("tradeFromRawTx (pool balance deltas)", () => {
  it("DAMM v2 (graduated): every swap of the fixture, amounts = the pool vault deltas, trader = fee payer", () => {
    for (const mint of [DAMM_MINT, DAMM_MINT2]) {
      const txs = FX[mint]!;
      const trades = txs.map((tx) => tradeFromRawTx(tx, mint, poolSides(mint), 0));
      expect(trades.filter(Boolean).length).toBeGreaterThanOrEqual(6);
      txs.forEach((tx, i) => {
        const t = trades[i];
        if (!t) return;
        const base = ownerDelta(tx, mint, DAMM_V2_POOL_AUTHORITY);
        const quote = ownerDelta(tx, WSOL, DAMM_V2_POOL_AUTHORITY);
        expect(t.kind).toBe(base < 0n ? "buy" : "sell");
        expect(t.tokenAmount).toBe(base < 0n ? -base : base);
        expect(t.solAmount).toBe(quote < 0n ? -quote : quote);
        expect(t.venue).toBe("meteora-dbc");
        expect(t.trader).toBe(tx.transaction.message.accountKeys[0]);
        expect(t.signature).toBe(tx.transaction.signatures[0]);
        expect(t.ts).toBe(tx.blockTime! * 1000);
        expect(t.decimals).toBe(6);
      });
    }
  });

  it("first fixture tx of the graduated example is a buy of 6 464 489.516281 tokens for 0.0001 SOL", () => {
    const t = tradeFromRawTx(FX[DAMM_MINT]![0]!, DAMM_MINT, poolSides(DAMM_MINT), 0)!;
    expect(t).toMatchObject({ kind: "buy", tokenAmount: 6_464_489_516_281n, solAmount: 100_000n });
  });

  it("DBC curve: swaps parsed; txs without a token move (fee claims) are skipped", () => {
    const txs = FX[DBC_MINT]!;
    const trades = txs.map((tx) => tradeFromRawTx(tx, DBC_MINT, poolSides(DBC_MINT), 0));
    expect(trades[0]).toMatchObject({ kind: "sell", tokenAmount: 3_938_469_000_810n, solAmount: 4_989_777n, venue: "meteora-dbc" });
    expect(trades[1]).toBeNull(); // WSOL only
    expect(trades.filter(Boolean).length).toBeGreaterThanOrEqual(2);
  });

  it("pump.fun curve: token side = the curve's token account, SOL side = the curve's lamports", () => {
    const txs = FX[PUMP_MINT]!;
    const curve = bondingCurvePda(new PublicKey(PUMP_MINT)).toBase58();
    let n = 0;
    for (const tx of txs) {
      const t = tradeFromRawTx(tx, PUMP_MINT, poolSides(PUMP_MINT), 0);
      if (!t) continue;
      n++;
      const keys = [...tx.transaction.message.accountKeys, ...(tx.meta!.loadedAddresses?.writable ?? []), ...(tx.meta!.loadedAddresses?.readonly ?? [])] as string[];
      const i = keys.indexOf(curve);
      const lam = BigInt(tx.meta!.postBalances[i]!) - BigInt(tx.meta!.preBalances[i]!);
      const base = ownerDelta(tx, PUMP_MINT, curve);
      expect(t.venue).toBe("pumpfun");
      expect(t.kind).toBe(base < 0n ? "buy" : "sell");
      expect(t.solAmount).toBe(lam < 0n ? -lam : lam);
      expect(t.decimals).toBe(6);
    }
    expect(n).toBeGreaterThanOrEqual(5);
  });

  function synth(o: { base: [string, bigint][]; quote: [string, bigint][]; err?: unknown }): RawTx {
    const mint = DAMM_MINT;
    const keys = [keyS(), ...o.base.map(() => keyS()), ...o.quote.map(() => keyS())];
    const pre: NonNullable<NonNullable<RawTx["meta"]>["preTokenBalances"]> = [];
    const post: typeof pre = [];
    let i = 1;
    for (const [owner, d] of o.base) {
      pre.push({ accountIndex: i, mint, owner, uiTokenAmount: { amount: "1000000000", decimals: 6 } });
      post.push({ accountIndex: i++, mint, owner, uiTokenAmount: { amount: String(1_000_000_000n + d), decimals: 6 } });
    }
    for (const [owner, d] of o.quote) {
      pre.push({ accountIndex: i, mint: WSOL, owner, uiTokenAmount: { amount: "1000000000", decimals: 9 } });
      post.push({ accountIndex: i++, mint: WSOL, owner, uiTokenAmount: { amount: String(1_000_000_000n + d), decimals: 9 } });
    }
    return {
      slot: 1,
      blockTime: 1_700_000_000,
      transaction: { signatures: ["sig"], message: { accountKeys: keys } },
      meta: { err: o.err ?? null, preBalances: keys.map(() => 0), postBalances: keys.map(() => 0), preTokenBalances: pre, postTokenBalances: post, loadedAddresses: { writable: [], readonly: [] } },
    };
  }

  it("skips liquidity moves, failed txs and ambiguous vaults (never guesses)", () => {
    const A = DAMM_V2_POOL_AUTHORITY;
    const sides = poolSides(DAMM_MINT);
    expect(tradeFromRawTx(synth({ base: [[A, -5n]], quote: [[A, 7n]] }), DAMM_MINT, sides, 0)).toMatchObject({ kind: "buy", tokenAmount: 5n, solAmount: 7n });
    expect(tradeFromRawTx(synth({ base: [[A, 5n]], quote: [[A, -7n]] }), DAMM_MINT, sides, 0)).toMatchObject({ kind: "sell" });
    expect(tradeFromRawTx(synth({ base: [[A, 5n]], quote: [[A, 7n]] }), DAMM_MINT, sides, 0)).toBeNull(); // add liquidity
    expect(tradeFromRawTx(synth({ base: [[A, -5n]], quote: [[A, 7n]] , err: { x: 1 } }), DAMM_MINT, sides, 0)).toBeNull();
    expect(tradeFromRawTx(synth({ base: [[A, -5n]], quote: [[A, 7n], [A, -3n]] }), DAMM_MINT, sides, 0)).toBeNull(); // two WSOL vaults
    expect(tradeFromRawTx(synth({ base: [[keyS(), -5n]], quote: [[A, 7n]] }), DAMM_MINT, sides, 0)).toBeNull(); // not a pool
  });
});

describe("pickDiscoveryBackfill", () => {
  const c = (mint: string, priceSol = "1") => ({ mint, priceSol });
  it("never read first, then price moved, then stale; nothing inside the min gap", () => {
    const now = 10_000_000;
    const st = new Map<string, CursorState>([
      ["moved", { sig: "s", at: now - 200_000, price: "1" }],
      ["stale", { sig: "s", at: now - 11 * 60_000, price: "1" }],
      ["fresh", { sig: "s", at: now - 30_000, price: "1" }],
      ["quiet", { sig: "s", at: now - 200_000, price: "1" }],
    ]);
    const out = pickDiscoveryBackfill([c("quiet"), c("stale"), c("fresh", "9"), c("moved", "2"), c("new")], st, now, 10).map((x) => x.mint);
    expect(out).toEqual(["new", "moved", "stale"]);
    expect(pickDiscoveryBackfill([c("a"), c("b"), c("c")], new Map(), now, 2).map((x) => x.mint)).toEqual(["a", "b"]);
  });
});

class FakeRpc implements BackfillRpc {
  calls: { m: string; a: string; o?: unknown }[] = [];
  sigs = new Map<string, SigInfo[]>();
  txs = new Map<string, RawTx>();
  pageFails = false;
  async signatures(address: string, o: { limit: number; until?: string }): Promise<SigInfo[]> {
    this.calls.push({ m: "sigs", a: address, o });
    const all = this.sigs.get(address) ?? [];
    const cut = o.until ? all.findIndex((s) => s.signature === o.until) : -1;
    return (cut >= 0 ? all.slice(0, cut) : all).slice(0, o.limit);
  }
  async transaction(signature: string): Promise<RawTx | null> {
    this.calls.push({ m: "tx", a: signature });
    return this.txs.get(signature) ?? null;
  }
  async transactionsForAddress(address: string, o: { limit: number; minSlot: number }): Promise<RawTx[]> {
    this.calls.push({ m: "page", a: address, o });
    if (this.pageFails) throw new Error("plan");
    return (this.sigs.get(address) ?? []).filter((s) => s.slot >= o.minSlot).slice(0, o.limit).map((s) => this.txs.get(s.signature)!).filter(Boolean);
  }
  /** Load fixture txs of `mint` (newest first). */
  load(mint: string, txs: RawTx[]): void {
    this.sigs.set(mint, txs.map((t) => ({ signature: t.transaction.signatures[0]!, slot: t.slot, err: null })));
    for (const t of txs) this.txs.set(t.transaction.signatures[0]!, t);
  }
}

describe("TradeBackfill", () => {
  it("< 10 new: single getTransaction each; next pass only reads past the cursor", async () => {
    const rpc = new FakeRpc();
    rpc.load(DAMM_MINT, FX[DAMM_MINT]!);
    const bf = new TradeBackfill({ rpc, maxTxCredits: 30 });
    const r1 = await bf.run([DAMM_MINT]);
    expect(r1.report).toMatchObject({ mints: 1, sigCalls: 1, txCalls: 8, pageCalls: 0, credits: 9 });
    expect(r1.trades.length).toBeGreaterThanOrEqual(6);
    rpc.calls = [];
    const r2 = await bf.run([DAMM_MINT]);
    expect(r2.report).toMatchObject({ sigCalls: 1, txCalls: 0, credits: 1, trades: 0 });
    expect(rpc.calls[0]!.o).toMatchObject({ until: FX[DAMM_MINT]![0]!.transaction.signatures[0] });
  });

  it(">= 10 new: one getTransactionsForAddress page (10 credits); falls back to single bodies when the plan refuses it", async () => {
    const rpc = new FakeRpc();
    const all = [...FX[DAMM_MINT]!, ...FX[DAMM_MINT2]!].map((t, i) => ({ ...t, slot: 1000 - i }));
    rpc.load(DAMM_MINT, all);
    const bf = new TradeBackfill({ rpc, maxTxCredits: 30 });
    const r = await bf.run([DAMM_MINT]);
    expect(r.report).toMatchObject({ pageCalls: 1, txCalls: 0, credits: 11 });
    expect(r.trades.length).toBeGreaterThanOrEqual(6); // the other mint's txs are not trades of this one

    const rpc2 = new FakeRpc();
    rpc2.load(DAMM_MINT, all);
    rpc2.pageFails = true;
    const bf2 = new TradeBackfill({ rpc: rpc2, maxTxCredits: 30 });
    expect((await bf2.run([DAMM_MINT])).report.errors).toBe(1);
    const again = await bf2.run([DAMM_MINT]);
    expect(again.report.pageCalls).toBe(0);
    expect(again.report.txCalls).toBe(16);
  });

  it("body budget per pass: every mint still gets its signatures call; over budget the cursor stays", async () => {
    const rpc = new FakeRpc();
    rpc.load(DAMM_MINT, FX[DAMM_MINT]!);
    rpc.load(DBC_MINT, FX[DBC_MINT]!);
    rpc.load(PUMP_MINT, FX[PUMP_MINT]!);
    const bf = new TradeBackfill({ rpc, maxTxCredits: 8 });
    const r = await bf.run([DAMM_MINT, DBC_MINT, PUMP_MINT]);
    expect(r.report.sigCalls).toBe(3);
    expect(r.report.txCalls).toBe(8);
    expect(r.report.credits).toBe(11);
    expect(bf.cursors.has(DAMM_MINT)).toBe(true);
    expect(bf.cursors.has(PUMP_MINT)).toBe(false);
  });

  it("partial budget: reads the oldest new signatures, cursor only over those; the rest comes next pass", async () => {
    const rpc = new FakeRpc();
    const txs = FX[DAMM_MINT]!; // 8, newest first
    rpc.load(DAMM_MINT, txs);
    const sig = (i: number) => txs[i]!.transaction.signatures[0]!;
    const bodies = () => rpc.calls.filter((c) => c.m === "tx").map((c) => c.a);
    const bf = new TradeBackfill({ rpc, maxTxCredits: 3 });
    const trades: string[] = [];
    const read: string[] = [];

    const r1 = await bf.run([DAMM_MINT]);
    expect(r1.report).toMatchObject({ sigCalls: 1, txCalls: 3, pageCalls: 0 });
    expect(bodies()).toEqual([sig(5), sig(6), sig(7)]);
    expect(bf.cursors.get(DAMM_MINT)!.sig).toBe(sig(5));
    read.push(...bodies());
    trades.push(...r1.trades.map((t) => t.signature));

    rpc.calls = [];
    const r2 = await bf.run([DAMM_MINT]);
    expect(rpc.calls[0]!.o).toMatchObject({ until: sig(5) });
    expect(bodies()).toEqual([sig(2), sig(3), sig(4)]);
    expect(bf.cursors.get(DAMM_MINT)!.sig).toBe(sig(2));
    read.push(...bodies());
    trades.push(...r2.trades.map((t) => t.signature));

    rpc.calls = [];
    const r3 = await bf.run([DAMM_MINT]); // the last two fit: cursor = newest
    expect(bodies()).toEqual([sig(0), sig(1)]);
    expect(bf.cursors.get(DAMM_MINT)!.sig).toBe(sig(0));
    read.push(...bodies());
    trades.push(...r3.trades.map((t) => t.signature));

    rpc.calls = [];
    expect((await bf.run([DAMM_MINT])).report).toMatchObject({ txCalls: 0, trades: 0 });

    // Every signature read exactly once; together the passes give the same trades as one full pass.
    expect([...read].sort()).toEqual(txs.map((t) => t.transaction.signatures[0]!).sort());
    const once = new FakeRpc();
    once.load(DAMM_MINT, txs);
    const all = await new TradeBackfill({ rpc: once, maxTxCredits: 30 }).run([DAMM_MINT]);
    expect([...trades].sort()).toEqual(all.trades.map((t) => t.signature).sort());
  });
});

// ---------------------------------------------------------------------------
// indexer integration
// ---------------------------------------------------------------------------

function mintAccount(supply: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    { mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default },
    data,
  );
  return { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
}

class Reader implements ChainReader {
  readonly hasIndex = true;
  readonly largest: string[] = [];
  readonly mints = new Set<string>();
  recent: string[] = [];
  async getMultipleAccounts(keys: readonly PublicKey[]) {
    return keys.map((k) => (this.mints.has(k.toBase58()) ? mintAccount(1_000_000n) : null));
  }
  async getTokenLargestAccounts(mint: PublicKey): Promise<LargestAccount[]> {
    this.largest.push(mint.toBase58());
    return [];
  }
  async recentPumpMints() {
    return this.recent;
  }
}

const noSource: TradeSource = { setMints: () => undefined, drain: () => [], stop: () => undefined };

describe("indexer: backfill lane", () => {
  it("backfills exactly the main batch (queued CA and decoys alike) + indexer-picked discovery candidates", async () => {
    const reader = new Reader();
    reader.recent = Array.from({ length: 40 }, keyS);
    reader.recent.forEach((m) => reader.mints.add(m));
    reader.mints.add(DAMM_MINT);
    const store = new MemoryIntelStore();
    store.enqueue(DAMM_MINT);
    const rpc = new FakeRpc();
    rpc.load(DAMM_MINT, FX[DAMM_MINT]!);
    const disc = [{ mint: DBC_MINT, priceSol: "0.1" }, { mint: PUMP_MINT, priceSol: "0.2" }, { mint: keyS(), priceSol: "0.3" }];
    rpc.load(DBC_MINT, FX[DBC_MINT]!);
    const lane = new TradeBackfill({ rpc, maxTxCredits: 100 });
    const idx = new IntelIndexer({
      store,
      reader,
      rng: seededRng(5),
      sleep: async () => undefined,
      trades: { source: noSource, whaleLamports: 1_000_000_000n, sniperSlots: 4 },
      backfill: { lane, discoveryPerTick: 2, candidates: () => disc },
    });
    const r = await idx.tick();
    await idx.backfillIdle();
    expect(r.batch).toBe(8);
    const batch = store.commits[0]!.batch;
    expect(batch).toContain(DAMM_MINT);
    const asked = rpc.calls.filter((c) => c.m === "sigs").map((c) => c.a);
    // the same calls for every batch mint, nothing else from the batch side
    expect(new Set(asked)).toEqual(new Set([...batch, DBC_MINT, PUMP_MINT]));
    expect(asked).toHaveLength(10);
    // index provider: the batch it already saw this tick (getTokenLargestAccounts)
    for (const m of batch) expect(reader.largest).toContain(m);
    const rows = [...store.marketTrades.values()];
    expect(rows.filter((t) => t.mint === DAMM_MINT).length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((t) => t.mint === DBC_MINT).length).toBeGreaterThanOrEqual(2);
    // replays of the same tx are not stored twice
    const n = store.marketTrades.size;
    expect(await store.commitMarketTrades(rows.map((x) => ({ ...x, ix: 3 })))).toBe(0);
    expect(store.marketTrades.size).toBe(n);
  });
});
