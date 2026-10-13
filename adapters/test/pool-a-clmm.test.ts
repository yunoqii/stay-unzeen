import { createHash } from "node:crypto";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";
import { QUOTE_DEFAULTS, makeQuotePool, quoteAssets } from "../src/pool-a";
import { ClmmPoolA, type ClmmState } from "../src/pool-a-clmm";
import { FakeRpc, launchLabAccounts, launchLabTxs } from "./rpc-fake";

/*
 * Pool A for USD1 = Raydium CLMM AQAGYQ… (mainnet). State: snapshot of 13.10
 * (scripts/snapshot-launchlab.ts), quoted fully offline. Swap fixture: a real mainnet
 * swap through the pool (any user), checked against the pool vaults' balance changes.
 */
const USD1 = new PublicKey(QUOTE_DEFAULTS["mainnet-beta"].USD1!.mint);
const POOL = new PublicKey(QUOTE_DEFAULTS["mainnet-beta"].USD1!.poolA!);
const CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const SWAP_V2 = createHash("sha256").update("global:swap_v2").digest().subarray(0, 8);
const ASSET = { mint: USD1, decimals: 6, tokenProgram: TOKEN_PROGRAM_ID };

function pool(rpc = new FakeRpc(launchLabAccounts())): ClmmPoolA {
  return new ClmmPoolA(rpc.connection(), POOL, ASSET);
}

describe("pool A (Raydium CLMM, USD1)", () => {
  let pa: ClmmPoolA;
  let s: ClmmState;
  beforeAll(async () => {
    pa = pool();
    s = await pa.load();
  });

  it("is chosen by poolAType, SOL side known without a read", () => {
    const usd1 = quoteAssets("mainnet-beta", {}).find((a) => a.symbol === "USD1")!;
    expect(makeQuotePool(new FakeRpc().connection(), usd1)).toBeInstanceOf(ClmmPoolA);
    expect(pa.solIsA).toBe(true); // So111… < USD1tt… (bytes)
    expect(s.solIsA).toBe(true);
  });

  it("refuses a pool that is not SOL/quote, and an unreadable one", async () => {
    await expect(new ClmmPoolA(new FakeRpc(launchLabAccounts()).connection(), POOL, { ...ASSET, mint: Keypair.generate().publicKey }).load()).rejects.toMatchObject({ code: "internal" });
    await expect(new ClmmPoolA(new FakeRpc().connection(), POOL, ASSET).load()).rejects.toMatchObject({ code: "venue_unavailable" });
  });

  it("price is sane (snapshot: ~107 USD1 per SOL)", () => {
    const perSol = pa.quoteForSol(s, 1_000_000_000n);
    expect(perSol).toBeGreaterThan(80_000_000n);
    expect(perSol).toBeLessThan(140_000_000n);
    expect(pa.quoteForSol(s, 0n)).toBe(0n);
    expect(pa.solForExactQuote(s, 0n)).toBe(0n);
  });

  it("ExactOut inverts ExactIn; buying costs more than selling returns (fee + spread)", () => {
    for (const lamports of [10_000_000n, 1_000_000_000n, 50_000_000_000n]) {
      const units = pa.quoteForSol(s, lamports);
      const back = pa.solForExactQuote(s, units);
      expect(back).toBeLessThanOrEqual(lamports + 1n);
      expect(back).toBeGreaterThanOrEqual((lamports * 9_990n) / 10_000n);
      expect(pa.solForQuote(s, units)).toBeLessThan(back);
    }
  });

  it("buy leg: wSOL filled with the cap, swap_v2 base-out for exactly `units`, wSOL closed", async () => {
    const payer = Keypair.generate().publicKey;
    const units = 5_000_000n;
    const max = (pa.solForExactQuote(s, units) * 10_100n) / 10_000n;
    const ixs = await pa.buyQuoteExactOut(payer, s, units, max);
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, payer, true);
    const q = getAssociatedTokenAddressSync(USD1, payer, true);
    expect(ixs.map((i) => i.programId.toBase58().slice(0, 6))).toEqual(["ATokenG", "111111", "Tokenk", "ATokenG", "CAMMCz", "Tokenk"].map((x) => x.slice(0, 6)));
    expect(SystemProgram.programId.equals(ixs[1]!.programId)).toBe(true);
    expect(ixs[1]!.data.readBigUInt64LE(4)).toBe(max);
    const swap = ixs[4]!;
    expect(swap.programId.equals(CLMM)).toBe(true);
    expect(swap.data.subarray(0, 8).equals(SWAP_V2)).toBe(true);
    expect(swap.data.readBigUInt64LE(8)).toBe(units); // amount = exact out
    expect(swap.data.readBigUInt64LE(16)).toBe(max); // other_amount_threshold = max in
    expect(swap.data.readUInt8(40)).toBe(0); // is_base_input = false
    const keys = swap.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toContain(POOL.toBase58());
    expect(keys.indexOf(wsol.toBase58())).toBeLessThan(keys.indexOf(q.toBase58())); // input (SOL) account first
    expect(swap.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([payer.toBase58()]);
    expect(swap.keys.length).toBeGreaterThan(13); // + tick arrays
  });

  it("sell leg: swap_v2 base-in for `units` with a lamport floor", async () => {
    const payer = Keypair.generate().publicKey;
    const ixs = await pa.sellQuoteExactIn(payer, s, 3_000_000n, 12_345n);
    const swap = ixs.find((i) => i.programId.equals(CLMM))!;
    expect(swap.data.readBigUInt64LE(8)).toBe(3_000_000n);
    expect(swap.data.readBigUInt64LE(16)).toBe(12_345n);
    expect(swap.data.readUInt8(40)).toBe(1);
    expect(ixs.at(-1)!.programId.equals(TOKEN_PROGRAM_ID)).toBe(true); // close wSOL
  });

  it("SwapEvent of a real mainnet swap == the pool vaults' balance changes", async () => {
    const { poolASwap } = launchLabTxs();
    const rpc = new FakeRpc();
    rpc.txs.set(poolASwap.signature, poolASwap.result);
    const tx = (await rpc.connection().getTransaction(poolASwap.signature, { maxSupportedTransactionVersion: 0 }))!;
    const legs = pool().legs(tx);
    expect(legs).toHaveLength(1);
    const leg = legs[0]!;
    const delta = (mint: PublicKey) => {
      const pre = tx.meta!.preTokenBalances!;
      const post = tx.meta!.postTokenBalances!.find((b) => b.owner === POOL.toBase58() && b.mint === mint.toBase58())!;
      const before = pre.find((b) => b.accountIndex === post.accountIndex)!;
      return BigInt(post.uiTokenAmount.amount) - BigInt(before.uiTokenAmount.amount);
    };
    const sol = delta(NATIVE_MINT);
    const usd = delta(USD1);
    if (leg.buy) {
      expect(sol).toBe(leg.inputAmount);
      expect(-usd).toBe(leg.outputAmount);
    } else {
      expect(usd).toBe(leg.inputAmount);
      expect(-sol).toBe(leg.outputAmount);
    }
    expect(new ClmmPoolA(rpc.connection(), Keypair.generate().publicKey, ASSET).legs(tx)).toEqual([]);
  });
});
