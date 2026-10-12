import fs from "node:fs";
import path from "node:path";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import { NATIVE_MINT } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { DynamicBondingCurveClient, validateConfigParameters } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  DBC_PROGRAM_ID,
  DEFAULT_DBC_CONFIG,
  PARTNER_PATH,
  UNZEEN_DBC_CURVE,
  dbcConfigAddress,
  dbcInitEvents,
  dbcPriceAndCap,
  dbcProgressPct,
  dbcStatus,
  dbcSwap2Events,
  dbcSwapAmounts,
  dbcSwapEvents,
  derivePartnerKeypair,
  unzeenDbcConfigParameters,
  MeteoraDbcAdapter,
} from "../src/meteora";
import { deriveCreatorKeypair, CreatorKeyring, MemoryCreatorIndexCounter } from "../src/keys";
import { lamportDelta, tokenDelta } from "../src/events";

/*
 * Meteora DBC adapter. Real numbers come from devnet 2026-10-12 (config
 * 5MHT8F…, pnpm relayer:devnet --venue meteora-dbc):
 *   create + first buy 0.01 SOL -> 353 960 441 764 base units (142k CU)
 *   buy 0.005 SOL              -> 176 892 663 314 (53k CU)
 *   sell 442 407 105 078       -> 12 253 076 lamports (51k CU)
 * Fixtures: test/fixtures/dbc-devnet-txs.json (public on-chain data).
 */

const offline = new Connection("http://127.0.0.1:1");
const client = new DynamicBondingCurveClient(offline, "confirmed");

interface FxTx {
  signature: string;
  slot: number;
  blockTime: number;
  accountKeys: string[];
  meta: {
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances: unknown[];
    postTokenBalances: unknown[];
    logMessages: string[];
    innerInstructions: { index: number; instructions: { programIdIndex: number; data: string; accounts: number[] }[] }[];
  };
}
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "dbc-devnet-txs.json"), "utf8")) as Record<"create" | "buy" | "sell", FxTx>;

/** Enough of a VersionedTransactionResponse for event / delta extraction. */
function txOf(f: FxTx): VersionedTransactionResponse {
  const keys = f.accountKeys.map((k) => new PublicKey(k));
  return {
    slot: f.slot,
    blockTime: f.blockTime,
    meta: { ...f.meta, err: null, loadedAddresses: undefined },
    transaction: { message: { getAccountKeys: () => ({ get: (i: number) => keys[i], length: keys.length }) }, signatures: [f.signature] },
  } as unknown as VersionedTransactionResponse;
}

const CONFIG_DEVNET = "5MHT8FPocqaLBrz9nHAyCuXSFPRbQxrXvG9E8y1eTZpK";
const VAULT2 = new PublicKey("8BHAT7qX7bgLFoPABSE8poBiuqLBDC8a8Ji8BvWA6ZSx");
const MINT = new PublicKey("55JhCAf4F6rNnXDq2WiU9z96RZ6YM9KHEckBkYEh8CtY");

describe("Unzeen DBC config (curve parameters)", () => {
  const params = unzeenDbcConfigParameters();

  it("passes the SDK validator", () => {
    expect(() =>
      validateConfigParameters({ ...params, leftoverReceiver: Keypair.generate().publicKey, quoteMint: NATIVE_MINT } as Parameters<typeof validateConfigParameters>[0]),
    ).not.toThrow();
  });

  it("pump.fun-equivalent: ~85 SOL raised to graduate, 1e9 tokens x 6 decimals, Token-2022, immutable, SOL fees", () => {
    const thr = BigInt(params.migrationQuoteThreshold.toString());
    expect(thr).toBeGreaterThan(84_000_000_000n);
    expect(thr).toBeLessThan(86_000_000_000n);
    expect(params.tokenSupply?.preMigrationTokenSupply.toString()).toBe((10n ** 15n).toString());
    expect(params.tokenDecimal).toBe(6);
    expect(params.tokenType).toBe(1); // Token2022
    expect(params.tokenUpdateAuthority).toBe(1); // Immutable
    expect(params.collectFeeMode).toBe(0); // QuoteToken
    expect(params.poolFees.baseFee.cliffFeeNumerator.toString()).toBe("10000000"); // 1 %
    expect(params.creatorTradingFeePercentage).toBe(UNZEEN_DBC_CURVE.creatorTradingFeePercentage);
    expect(params.poolCreationFee.toString()).toBe("0");
    expect(params.enableFirstSwapWithMinFee).toBe(false);
  });

  it("100 % of the graduated LP is permanently locked (nobody can pull liquidity)", () => {
    expect(params.partnerPermanentLockedLiquidityPercentage + params.creatorPermanentLockedLiquidityPercentage).toBe(100);
    expect(params.partnerLiquidityPercentage + params.creatorLiquidityPercentage).toBe(0);
  });

  it("start market cap ~27.96 SOL, like a fresh pump.fun curve", () => {
    const { marketCapSol } = dbcPriceAndCap(params.sqrtStartPrice, 10n ** 15n, 6);
    expect(Number(marketCapSol)).toBeGreaterThan(27.9);
    expect(Number(marketCapSol)).toBeLessThan(28.0);
  });

  it("first buy 0.01 SOL quotes exactly what devnet executed", () => {
    const q = client.pool.getQuoteFromInputAmount({ config: params, swapBaseForQuote: false, amountIn: new BN(10_000_000) });
    expect(q.outputAmount.toString()).toBe("353960441764");
  });
});

describe("config address and partner key", () => {
  it("per-network env override, built-in devnet default, nothing on other clusters", () => {
    expect(dbcConfigAddress("devnet", {})?.toBase58()).toBe(CONFIG_DEVNET);
    expect(DEFAULT_DBC_CONFIG.devnet).toBe(CONFIG_DEVNET);
    const other = Keypair.generate().publicKey.toBase58();
    expect(dbcConfigAddress("devnet", { METEORA_DBC_CONFIG_DEVNET: other })?.toBase58()).toBe(other);
    expect(dbcConfigAddress("mainnet-beta", {})).toBeNull();
    expect(dbcConfigAddress("mainnet-beta", { METEORA_DBC_CONFIG_MAINNET: other })?.toBase58()).toBe(other);
    expect(dbcConfigAddress("localnet", { METEORA_DBC_CONFIG_DEVNET: other })).toBeNull();
    expect(() => dbcConfigAddress("devnet", { METEORA_DBC_CONFIG_DEVNET: "nope" })).toThrow(/METEORA_DBC_CONFIG_DEVNET/);
  });

  it("partner key: deterministic, never one of the creator addresses", () => {
    const seed = new Uint8Array(64).fill(7);
    const p = derivePartnerKeypair(seed).publicKey.toBase58();
    expect(derivePartnerKeypair(seed).publicKey.toBase58()).toBe(p);
    expect(PARTNER_PATH[3]).toBe(1); // creators end in /0'
    for (let i = 0; i < 50; i++) expect(deriveCreatorKeypair(seed, i).publicKey.toBase58()).not.toBe(p);
    expect(deriveCreatorKeypair(seed, PARTNER_PATH[2]).publicKey.toBase58()).not.toBe(p);
  });
});

describe("status, progress, price", () => {
  const thr = new BN("85010237679");
  it("graduated when migrated or the quote reserve reached the threshold", () => {
    expect(dbcStatus({ isMigrated: 0, quoteReserve: new BN(1) }, { migrationQuoteThreshold: thr })).toBe("curve");
    expect(dbcStatus({ isMigrated: 0, quoteReserve: thr }, { migrationQuoteThreshold: thr })).toBe("graduated");
    expect(dbcStatus({ isMigrated: 1, quoteReserve: new BN(0) }, { migrationQuoteThreshold: thr })).toBe("graduated");
  });
  it("progress: 2 decimals, capped at 100", () => {
    expect(dbcProgressPct({ quoteReserve: new BN(0) }, { migrationQuoteThreshold: thr })).toBe("0.00");
    expect(dbcProgressPct({ quoteReserve: thr.divn(2) }, { migrationQuoteThreshold: thr })).toBe("49.99");
    expect(dbcProgressPct({ quoteReserve: thr.muln(2) }, { migrationQuoteThreshold: thr })).toBe("100.00");
    expect(dbcProgressPct({ quoteReserve: new BN(1) }, { migrationQuoteThreshold: new BN(0) })).toBe("100.00");
  });
  it("price from the Q64.64 sqrt price: 2^64 = 1 lamport per base unit", () => {
    const one = 1n << 64n;
    // 1 lamport per base unit, 6 decimals: 1e6 lamports = 0.001 SOL per token; cap = supply lamports
    expect(dbcPriceAndCap(one, 10n ** 15n, 6)).toEqual({ priceSol: "0.001", marketCapSol: "1000000" });
    expect(dbcPriceAndCap(one * 2n, 10n ** 6n, 6)).toEqual({ priceSol: "0.004", marketCapSol: "0.004" });
  });
});

describe("executed amounts from devnet events", () => {
  it("create: EvtInitializePool (config, fresh creator, mint) + EvtSwap first buy", () => {
    const tx = txOf(FX.create);
    const init = dbcInitEvents(tx);
    expect(init).toHaveLength(1);
    expect(init[0]!.config.toBase58()).toBe(CONFIG_DEVNET);
    expect(init[0]!.baseMint.equals(MINT)).toBe(true);
    expect(init[0]!.creator.equals(VAULT2)).toBe(false);
    const sw = dbcSwapEvents(tx);
    expect(sw).toHaveLength(1);
    expect(dbcSwapAmounts({ kind: "swap", e: sw[0]! })).toEqual({ isBuy: true, tokenAmount: 353960441764n, solAmount: 10_000_000n });
    expect(tokenDelta(tx, VAULT2, MINT)).toBe(353960441764n);
  });

  it("buy (swap2 partial fill): lamports = included-fee input = vault balance delta", () => {
    const tx = txOf(FX.buy);
    const ev = dbcSwap2Events(tx);
    expect(ev).toHaveLength(1);
    const a = dbcSwapAmounts({ kind: "swap2", e: ev[0]! });
    expect(a).toEqual({ isBuy: true, tokenAmount: 176892663314n, solAmount: 5_000_000n });
    // first buy of the vault on this mint did not need an ATA (create made it): delta is the trade itself
    expect(-(lamportDelta(tx, VAULT2) + BigInt(FX.buy.meta.fee))).toBe(a.solAmount);
    expect(tokenDelta(tx, VAULT2, MINT)).toBe(a.tokenAmount);
  });

  it("sell (swap2 exact in): lamports net of the SOL fee = vault balance delta", () => {
    const tx = txOf(FX.sell);
    const ev = dbcSwap2Events(tx);
    expect(ev).toHaveLength(1);
    const a = dbcSwapAmounts({ kind: "swap2", e: ev[0]! });
    expect(a.isBuy).toBe(false);
    expect(a.solAmount).toBe(12_253_076n);
    expect(lamportDelta(tx, VAULT2) + BigInt(FX.sell.meta.fee)).toBe(a.solAmount);
    expect(-tokenDelta(tx, VAULT2, MINT)).toBe(a.tokenAmount);
  });

  it("events of another program are ignored", () => {
    const f = structuredClone(FX.buy);
    f.accountKeys = f.accountKeys.map((k) => (k === DBC_PROGRAM_ID.toBase58() ? Keypair.generate().publicKey.toBase58() : k));
    f.meta.logMessages = [];
    expect(dbcSwap2Events(txOf(f))).toEqual([]);
  });
});

describe("error classification (DBC IDL)", () => {
  const a = new MeteoraDbcAdapter({
    connection: offline,
    config: new PublicKey(CONFIG_DEVNET),
    defaultVault: Keypair.generate(),
    creators: new CreatorKeyring(new Uint8Array(64).fill(1), new MemoryCreatorIndexCounter(), null),
    stateDir: "/nonexistent",
  });
  it("ExceededSlippage -> slippage, PoolIsCompleted -> graduated", () => {
    expect(a.classify(new Error("x"), ["Program log: AnchorError occurred. Error Code: ExceededSlippage. Error Number: 6002. Error Message: Exceeded slippage tolerance."]).code).toBe("slippage");
    expect(a.classify(new Error("x"), ["Program log: AnchorError occurred. Error Code: PoolIsCompleted. Error Number: 6013."]).apiCode).toBe("graduated");
  });
  it("custom program error of the DBC program is resolved through its IDL", () => {
    const e = a.classify(new Error("x"), [`Program ${DBC_PROGRAM_ID.toBase58()} failed: custom program error: 0x177d`]);
    expect(e.programError).toEqual({ code: 6013, name: "PoolIsCompleted" });
    expect(e.code).toBe("graduated");
  });
  it("vault without SOL -> pool_liquidity, never the user's balance", () => {
    expect(a.classify(new Error("Transfer: insufficient lamports 1, need 2")).apiCode).toBe("pool_liquidity");
  });
  it("pool PDA is derived from Unzeen's config + mint (SOL quote)", () => {
    expect(a.poolAddress(MINT).toBase58()).toBe(dbcInitEvents(txOf(FX.create))[0]!.pool.toBase58());
  });
});
