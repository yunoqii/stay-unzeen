import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { applyMargin, dbcPriceAndCap, dbcPriceAndCapQuote, quoteToSolPriceAndCap, unzeenDbcConfigParameters, CU_CREATE_QUOTE, CU_TRADE_QUOTE } from "../src/meteora";
import { QUOTE_DEFAULTS, poolASwapLegs, quoteAssets } from "../src/pool-a";
import { stockAction, stockPolicy } from "../src/relayer/quote-stock";
import { rowToSpec, type JobRow } from "../src/relayer/postgres-queue";
import { Relayer } from "../src/relayer/engine";
import { InMemoryJobQueue } from "../src/relayer/memory-queue";
import { seededRng } from "../src/relayer/random";
import { VaultPool } from "../src/relayer/vaults";
import { FakeChain, FakeExecutor, FakeInventory, vaults } from "./relayer/fakes";

/* Devnet 13.10 (public): pnpm quote:devnet — leg buy (pool A ExactOut in the same tx) and a stock buy. */
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "pool-a-devnet-txs.json"), "utf8")) as Record<"legBuy" | "stockBuy", { signature: string; result: unknown }>;
const POOL_A = new PublicKey(QUOTE_DEFAULTS.devnet.USDC!.poolA!);

function conn(result: unknown): Connection {
  const f = (async (_u: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { id: string };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return new Connection("http://rpc.invalid", { fetch: f });
}

describe("pool A legs (DAMM v2 EvtSwap2)", () => {
  it("leg buy: SOL in / exact USDC out of the same-tx leg", async () => {
    const tx = await conn(FX.legBuy.result).getTransaction(FX.legBuy.signature, { maxSupportedTransactionVersion: 1 });
    const legs = poolASwapLegs(tx!, POOL_A);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.inputAmount).toBe(19_896_365n); // what the ledger booked in the e2e
    expect(legs[0]!.outputAmount).toBe(2_237_514n); // exactly the units the curve used (ExactOut, no dust)
    expect(poolASwapLegs(tx!, Keypair.generate().publicKey)).toEqual([]);
  });
  it("stock buy: 1 USDC exact out", async () => {
    const tx = await conn(FX.stockBuy.result).getTransaction(FX.stockBuy.signature, { maxSupportedTransactionVersion: 1 });
    expect(poolASwapLegs(tx!, POOL_A)[0]!.outputAmount).toBe(1_000_000n);
  });
});

describe("quote pricing", () => {
  it("quote helper with 9 decimals == the SOL helper", () => {
    const sq = 1_234_567_890_123_456_789n;
    const a = dbcPriceAndCap(sq, 10n ** 15n, 6);
    const b = dbcPriceAndCapQuote(sq, 10n ** 15n, 6, 9);
    expect(b.price).toBe(a.priceSol);
    expect(b.marketCap).toBe(a.marketCapSol);
  });
  it("USDC -> SOL conversion at the pool A rate", () => {
    // 3000 USDC cap, 1 USDC = 0.01 SOL -> 30 SOL
    const r = quoteToSolPriceAndCap({ capUnits: 3_000_000_000n, price18: 3n * 10n ** 12n }, 6, 10_000_000n);
    expect(r.marketCapSol).toBe("30");
    expect(r.priceSol).toBe("0.00000003");
  });
  it("leg margin 50 bps, floor", () => {
    expect(applyMargin(10_000n)).toBe(9_950n);
    expect(applyMargin(1n)).toBe(0n);
  });
  it("USD configs: same curve shape and fee as SOL (one creator fee rate for all launches)", () => {
    const solP = unzeenDbcConfigParameters();
    const usd = unzeenDbcConfigParameters({ decimals: 6 });
    expect(usd.curve).not.toEqual(solP.curve); // quote-unit curve (6 decimals), same shape
    expect(usd.creatorTradingFeePercentage).toBe(solP.creatorTradingFeePercentage);
    expect(JSON.stringify(usd.poolFees)).toBe(JSON.stringify(solP.poolFees));
    expect(BigInt(usd.migrationQuoteThreshold.toString())).toBeGreaterThan(750_000_000n); // > 750 USDC keeper threshold
  });
  it("fixed CU per class (stock or leg path: same limit)", () => {
    expect(CU_TRADE_QUOTE).toBe(250_000);
    expect(CU_CREATE_QUOTE).toBe(400_000);
  });
});

describe("quote assets / stock policy", () => {
  it("defaults per network; env overrides; USD1 has no pool A yet", () => {
    const m = quoteAssets("mainnet-beta", {});
    expect(m.find((a) => a.symbol === "USDC")!.poolA!.toBase58()).toBe("8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie");
    expect(m.find((a) => a.symbol === "USD1")!.poolA).toBeNull();
    const d = quoteAssets("devnet", {});
    expect(d[0]!.mint.toBase58()).toBe("USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT"); // Raydium's devnet USDC, not pump's 4zMMC9…
    const k = Keypair.generate().publicKey.toBase58();
    expect(quoteAssets("devnet", { POOL_A_USDC_DEVNET: k })[0]!.poolA!.toBase58()).toBe(k);
    expect(quoteAssets("devnet", { POOL_A_USDC_DEVNET: "none" })[0]!.poolA).toBeNull();
    expect(quoteAssets("localnet", {})).toEqual([]);
  });
  it("stock action: below low -> buy to target, above high -> sell to target", () => {
    const p = { target: 100n, low: 50n, high: 300n };
    expect(stockAction(10n, p)).toEqual({ kind: "buy", units: 90n });
    expect(stockAction(50n, p)).toBeNull();
    expect(stockAction(301n, p)).toEqual({ kind: "sell", units: 201n });
    expect(() => stockAction(1n, { target: 1n, low: 2n, high: 3n })).toThrow();
    expect(stockPolicy({ symbol: "USDC", decimals: 6 }, "mainnet-beta", {})).toEqual({ target: 50_000_000n, low: 25_000_000n, high: 150_000_000n });
    expect(stockPolicy({ symbol: "USDC", decimals: 6 }, "devnet", { QUOTE_STOCK_USDC_TARGET: "0.5" }).target).toBe(500_000n);
  });
});

describe("contract (proposed): create meta.quote, op fund_quote", () => {
  const row = (o: Partial<JobRow>): JobRow => ({
    id: "1", part: 0, op: "create", venue: "meteora-dbc", mint: null, lamports_in: "5", token_amount: null, min_out: "1", meta: null, dest: null,
    gas_lamports: null, network: "devnet", attempts: 1, status: "claimed", signature: null, last_valid_block_height: null, vault: null,
    sent_at_ms: null, not_before_ms: "0", ...o,
  });
  it("create with meta.quote", () => {
    expect(rowToSpec(row({ meta: { name: "N", symbol: "S", quote: "USDC" } }), "devnet")).toMatchObject({ kind: "create", quote: "USDC" });
    expect(rowToSpec(row({ meta: { name: "N", symbol: "S", quote: "SOL" } }), "devnet")).not.toHaveProperty("quote");
    expect(() => rowToSpec(row({ meta: { name: "N", symbol: "S", quote: "usd c" } }), "devnet")).toThrow();
  });
  it("fund_quote", () => {
    const v = Keypair.generate().publicKey.toBase58();
    expect(rowToSpec(row({ op: "fund_quote", venue: null, meta: { quote: "USDC", vault: v } }), "devnet")).toEqual({ kind: "fund_quote", quote: "USDC", vault: v });
    expect(() => rowToSpec(row({ op: "fund_quote", venue: null, meta: { quote: "USDC", vault: "x" } }), "devnet")).toThrow();
  });
  it("engine: fund_quote runs on exactly meta.vault", async () => {
    const chain = new FakeChain();
    const inv = new FakeInventory();
    const vs = vaults(3, inv);
    const queue = new InMemoryJobQueue(seededRng(1));
    const ex = new FakeExecutor(chain);
    const r = new Relayer({ queue, pool: new VaultPool(vs, inv, seededRng(1)), executors: { trade: {}, withdraw: ex, quoteStock: ex }, probe: chain });
    const target = vs[2]!.publicKey.toBase58();
    const j = queue.enqueue({ kind: "fund_quote", quote: "USDC", vault: target }, { notBefore: 0 });
    await r.tick();
    expect(queue.get(j.id)!.attempts[0]!.vault).toBe(target);
    expect(queue.get(j.id)!.result).toMatchObject({ status: "executed", execution: { kind: "fund_quote" } });
  });
});

import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { extractTradeEvents, tokenDelta } from "../src/events";
import { PUMP_QUOTE_DEFAULTS } from "../src/pool-a";
import { pumpMargin, priceAndCapIn, CU_CREATE_PUMP_QUOTE, CU_TRADE_PUMP_QUOTE } from "../src/pumpfun";

describe("pump.fun quote pairs", () => {
  const FX2 = FX as unknown as Record<"pumpLegBuy" | "pumpSell", { signature: string; result: unknown }>;
  const PUMP_POOL_A = new PublicKey(PUMP_QUOTE_DEFAULTS.devnet.USDC!.poolA!);
  const USDC_PUMP = new PublicKey(PUMP_QUOTE_DEFAULTS.devnet.USDC!.mint);

  it("leg buy: units = leg out - net quote change; TradeEvent carries the quote mint", async () => {
    const tx = await conn(FX2.pumpLegBuy.result).getTransaction(FX2.pumpLegBuy.signature, { maxSupportedTransactionVersion: 1 });
    const ev = extractTradeEvents(tx!, PUMP_PROGRAM_ID)[0]!;
    expect(ev.quoteMint.equals(USDC_PUMP)).toBe(true);
    const leg = poolASwapLegs(tx!, PUMP_POOL_A)[0]!;
    const vault = ev.user;
    const spent = leg.outputAmount - tokenDelta(tx!, vault, USDC_PUMP);
    expect(spent).toBe(349_043n); // what the e2e booked as quoteAmount
    expect(leg.inputAmount).toBe(29_849_554n); // = ledger lamports (ExactOut: no dust)
  });

  it("sell: proceeds are the vault's quote increase", async () => {
    const tx = await conn(FX2.pumpSell.result).getTransaction(FX2.pumpSell.signature, { maxSupportedTransactionVersion: 1 });
    const ev = extractTradeEvents(tx!, PUMP_PROGRAM_ID)[0]!;
    expect(tokenDelta(tx!, ev.user, USDC_PUMP)).toBe(207_519n);
    expect(poolASwapLegs(tx!, PUMP_POOL_A)).toEqual([]); // no swap back after a sell
  });

  it("helpers and fixed CU", () => {
    expect(pumpMargin(10_000n)).toBe(9_950n);
    const c = { virtualQuoteReserves: { toString: () => "2000000000" }, virtualTokenReserves: { toString: () => "1000000000000000" }, tokenTotalSupply: { toString: () => "1000000000000000" } };
    const r = priceAndCapIn(c as never, 6, 6);
    expect(r.capUnits).toBe(2_000_000_000n); // 2000 USDC
    expect(r.price18).toBe(2_000_000_000_000n); // 0.000002 USDC per token
    expect([CU_CREATE_PUMP_QUOTE, CU_TRADE_PUMP_QUOTE]).toEqual([600_000, 400_000]);
  });

  it("quote sets per venue: pump devnet USDC != DBC devnet USDC; ZEC only behind PUMP_QUOTE_ZEC=1", () => {
    const p = quoteAssets("devnet", {}, "pumpfun")[0]!;
    const d = quoteAssets("devnet", {}, "meteora-dbc")[0]!;
    expect(p.mint.equals(d.mint)).toBe(false);
    expect(p.dbcConfig).toBeNull();
    expect(quoteAssets("mainnet-beta", {}, "pumpfun").map((a) => a.symbol)).toEqual(["USDC"]);
    const z = quoteAssets("mainnet-beta", { PUMP_QUOTE_ZEC: "1" }, "pumpfun").find((a) => a.symbol === "ZEC")!;
    expect(z.mint.toBase58()).toBe("A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS");
    expect(z.decimals).toBe(8);
    expect(z.poolA).toBeNull(); // no liquid SOL/ZEC DAMM v2 pool: ZEC trades refused until one is pinned
  });
});
