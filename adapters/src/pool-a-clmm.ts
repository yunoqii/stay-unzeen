import { createHash } from "node:crypto";
import BN from "bn.js";
import {
  ClmmConfigLayout,
  ClmmInstrument,
  PoolInfoLayout,
  PoolUtils,
  TickArrayBitmapExtensionLayout,
  getPdaExBitmapAccount,
} from "@raydium-io/raydium-sdk-v2";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, type Connection, type TransactionInstruction, type VersionedTransactionResponse } from "@solana/web3.js";
import { AdapterError } from "./errors";
import { anchorEventPayloads } from "./events";
import { toBN, toBig } from "./math";
import type { PoolLeg, QuoteAsset, QuotePool } from "./pool-a";

/**
 * Pool A on a Raydium CLMM pool (lead 13.10: USD1 has no liquid DAMM v2 pool;
 * the deepest SOL/USD1 pool on mainnet 13.10 is Raydium CLMM
 * `AQAGYQsdU853WAKhXM79CgNdoyhrRwXvYHX6qrDyC1FS`, ~16 600 SOL / ~2.95M USD1;
 * Orca's best had ~200 SOL). Everything is read over RPC: pool, amm config,
 * tick-array bitmap extension and the tick arrays around the current tick
 * (`PoolUtils.fetchMultiplePoolTickArrays`, RPC only, no Raydium API), then
 * quoted locally (`PoolUtils.get{Input,Output}AmountAndRemainAccounts`).
 * Swaps: `swap_v2` base-out (ExactOut) / base-in, SOL through a wSOL ATA that is
 * filled and closed in the same tx.
 */

export interface ClmmState {
  kind: "clmm";
  compute: Parameters<typeof PoolUtils.getInputAmountAndRemainAccounts>[0];
  exBitmap: Parameters<typeof PoolUtils.getInputAmountAndRemainAccounts>[1];
  ticks: Parameters<typeof PoolUtils.getInputAmountAndRemainAccounts>[2];
  vaultA: PublicKey;
  vaultB: PublicKey;
  observationId: PublicKey;
  solIsA: boolean;
  timestamp: number;
}

const SWAP_EVENT = createHash("sha256").update("event:SwapEvent").digest().subarray(0, 8);

export class ClmmPoolA implements QuotePool {
  /** CLMM pools keep mintA < mintB (bytes): the SOL side is known without a read. */
  readonly solIsA: boolean;
  constructor(
    private readonly connection: Connection,
    readonly address: PublicKey,
    readonly quote: Pick<QuoteAsset, "mint" | "decimals" | "tokenProgram">,
  ) {
    this.solIsA = Buffer.compare(NATIVE_MINT.toBuffer(), quote.mint.toBuffer()) < 0;
  }

  private programId: PublicKey | null = null;

  async load(): Promise<ClmmState> {
    const acc = await this.connection.getAccountInfo(this.address, "confirmed").catch(() => null);
    if (!acc) throw new AdapterError("venue_unavailable", "pool A (CLMM) not readable");
    this.programId = acc.owner;
    const p = PoolInfoLayout.decode(acc.data);
    const solIsA = p.mintA.equals(NATIVE_MINT);
    const other = solIsA ? p.mintB : p.mintA;
    if (!(solIsA || p.mintB.equals(NATIVE_MINT)) || !other.equals(this.quote.mint)) throw new AdapterError("internal", "pool A is not SOL/quote");
    const exId = getPdaExBitmapAccount(acc.owner, this.address).publicKey;
    const [cfg, ex] = await this.connection.getMultipleAccountsInfo([p.configId, exId], "confirmed");
    if (!cfg || !ex) throw new AdapterError("venue_unavailable", "pool A (CLMM) config not readable");
    const config = ClmmConfigLayout.decode(cfg.data);
    const exBitmap = TickArrayBitmapExtensionLayout.decode(ex.data);
    const tok = (mint: PublicKey, decimals: number) => ({ address: mint.toBase58(), decimals, programId: TOKEN_PROGRAM_ID.toBase58(), chainId: 101, logoURI: "", symbol: "", name: "", tags: [], extensions: {} });
    const compute = {
      accInfo: p,
      ...p,
      id: this.address,
      version: 6 as const,
      programId: acc.owner,
      mintA: tok(p.mintA, p.mintDecimalsA),
      mintB: tok(p.mintB, p.mintDecimalsB),
      ammConfig: { ...config, id: p.configId, fundOwner: "", description: "" },
      // currentPrice is only used by the SDK's UI helpers, not by get{Input,Output}AmountAndRemainAccounts.
      exBitmapAccount: exId,
      exBitmapInfo: exBitmap,
      startTime: p.startTime.toNumber(),
      rewardInfos: p.rewardInfos,
    } as unknown as ClmmState["compute"];
    const arrays = await PoolUtils.fetchMultiplePoolTickArrays({ connection: this.connection, poolKeys: [compute as never], batchRequest: false });
    const ticks = (arrays[this.address.toBase58()] ?? {}) as ClmmState["ticks"];
    return { kind: "clmm", compute, exBitmap, ticks, vaultA: p.vaultA, vaultB: p.vaultB, observationId: p.observationId, solIsA, timestamp: Math.floor(Date.now() / 1000) };
  }

  private st(s: unknown): ClmmState {
    const x = s as ClmmState;
    if (x?.kind !== "clmm") throw new AdapterError("internal", "not a CLMM pool state");
    return x;
  }

  private out(s: ClmmState, inputMint: PublicKey, amountIn: bigint): { out: bigint; remaining: PublicKey[] } {
    try {
      const r = PoolUtils.getOutputAmountAndRemainAccounts(s.compute, s.exBitmap, s.ticks as never, inputMint, toBN(amountIn), s.timestamp);
      return { out: toBig(r.expectedAmountOut), remaining: r.remainingAccounts };
    } catch (e) {
      throw new AdapterError("slippage", `pool A (CLMM) cannot quote: ${e instanceof Error ? e.message.slice(0, 80) : "error"}`, { cause: e });
    }
  }

  private inFor(s: ClmmState, outputMint: PublicKey, amountOut: bigint): { in: bigint; remaining: PublicKey[] } {
    try {
      // SDK 0.2.74-alpha: the ExactOut path reads the cache keyed by tick-array ADDRESS
      // (the ExactIn path and fetchMultiplePoolTickArrays key it by start index).
      const byAddress = Object.fromEntries(Object.values(s.ticks as unknown as Record<string, { address: PublicKey }>).map((t) => [t.address.toBase58(), t]));
      const r = PoolUtils.getInputAmountAndRemainAccounts(s.compute, s.exBitmap, byAddress as never, outputMint, toBN(amountOut), s.timestamp);
      return { in: toBig(r.expectedAmountIn), remaining: r.remainingAccounts };
    } catch (e) {
      throw new AdapterError("slippage", `pool A (CLMM) cannot quote: ${e instanceof Error ? e.message.slice(0, 80) : "error"}`, { cause: e });
    }
  }

  quoteForSol(s: unknown, lamports: bigint): bigint {
    return lamports <= 0n ? 0n : this.out(this.st(s), NATIVE_MINT, lamports).out;
  }
  solForExactQuote(s: unknown, units: bigint): bigint {
    return units <= 0n ? 0n : this.inFor(this.st(s), this.quote.mint, units).in;
  }
  solForQuote(s: unknown, units: bigint): bigint {
    return units <= 0n ? 0n : this.out(this.st(s), this.quote.mint, units).out;
  }

  async buyQuoteExactOut(payer: PublicKey, s0: unknown, units: bigint, maxLamports: bigint): Promise<TransactionInstruction[]> {
    const s = this.st(s0);
    const { remaining } = this.inFor(s, this.quote.mint, units);
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, payer, true);
    const q = getAssociatedTokenAddressSync(this.quote.mint, payer, true, this.quote.tokenProgram);
    const swap = ClmmInstrument.makeSwapBaseOutInstructions({
      poolInfo: this.simple(s),
      poolKeys: { vault: { A: s.vaultA.toBase58(), B: s.vaultB.toBase58() } } as never,
      observationId: s.observationId,
      ownerInfo: { wallet: payer, tokenAccountA: s.solIsA ? wsol : q, tokenAccountB: s.solIsA ? q : wsol },
      outputMint: this.quote.mint,
      amountOut: toBN(units),
      amountInMax: toBN(maxLamports),
      sqrtPriceLimitX64: new BN(0),
      remainingAccounts: remaining,
    });
    return [
      createAssociatedTokenAccountIdempotentInstruction(payer, wsol, payer, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: wsol, lamports: maxLamports }),
      createSyncNativeInstruction(wsol),
      createAssociatedTokenAccountIdempotentInstruction(payer, q, payer, this.quote.mint, this.quote.tokenProgram),
      ...swap.instructions,
      createCloseAccountInstruction(wsol, payer, payer),
    ];
  }

  async sellQuoteExactIn(payer: PublicKey, s0: unknown, units: bigint, minLamports: bigint): Promise<TransactionInstruction[]> {
    const s = this.st(s0);
    const { remaining } = this.out(s, this.quote.mint, units);
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, payer, true);
    const q = getAssociatedTokenAddressSync(this.quote.mint, payer, true, this.quote.tokenProgram);
    const swap = ClmmInstrument.makeSwapBaseInInstructions({
      poolInfo: this.simple(s),
      poolKeys: { vault: { A: s.vaultA.toBase58(), B: s.vaultB.toBase58() } } as never,
      observationId: s.observationId,
      ownerInfo: { wallet: payer, tokenAccountA: s.solIsA ? wsol : q, tokenAccountB: s.solIsA ? q : wsol },
      inputMint: this.quote.mint,
      amountIn: toBN(units),
      amountOutMin: toBN(minLamports),
      sqrtPriceLimitX64: new BN(0),
      remainingAccounts: remaining,
    });
    return [createAssociatedTokenAccountIdempotentInstruction(payer, wsol, payer, NATIVE_MINT), ...swap.instructions, createCloseAccountInstruction(wsol, payer, payer)];
  }

  /**
   * CLMM SwapEvent (emit!, "Program data:"): pool | sender | token_account_0 | token_account_1 |
   * amount_0 u64 | transfer_fee_0 u64 | amount_1 u64 | transfer_fee_1 u64 | zero_for_one bool | ...
   */
  legs(tx: VersionedTransactionResponse): PoolLeg[] {
    const prog = this.programId ?? new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
    const out: PoolLeg[] = [];
    for (const p of anchorEventPayloads(tx, prog, SWAP_EVENT)) {
      if (p.length < 161) continue;
      if (!new PublicKey(p.subarray(0, 32)).equals(this.address)) continue;
      const a0 = p.readBigUInt64LE(128);
      const a1 = p.readBigUInt64LE(144);
      const zeroForOne = p.readUInt8(160) !== 0; // token0 (= mintA) in
      const [inp, outp] = zeroForOne ? [a0, a1] : [a1, a0];
      out.push({ buy: zeroForOne === this.solIsA, inputAmount: inp, outputAmount: outp });
    }
    return out;
  }

  private simple(s: ClmmState): never {
    const c = s.compute as unknown as { mintA: { address: string; decimals: number }; mintB: { address: string; decimals: number }; ammConfig: { id: PublicKey } };
    return {
      id: this.address.toBase58(),
      programId: (this.programId ?? new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK")).toBase58(),
      mintA: { address: c.mintA.address, programId: TOKEN_PROGRAM_ID.toBase58(), decimals: c.mintA.decimals },
      mintB: { address: c.mintB.address, programId: TOKEN_PROGRAM_ID.toBase58(), decimals: c.mintB.decimals },
      config: { id: c.ammConfig.id.toBase58() },
    } as never;
  }
}
