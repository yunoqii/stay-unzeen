import BN from "bn.js";
import { CP_AMM_PROGRAM_ID, CpAmm, CpAmmIdl, SwapMode, getCurrentPoint, type PoolState } from "@meteora-ag/cp-amm-sdk";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type Connection, type TransactionInstruction, type VersionedTransactionResponse } from "@solana/web3.js";
import type { SolanaCluster } from "./config";
import { AdapterError } from "./errors";
import { anchorEventPayloads } from "./events";
import { toBN, toBig } from "./math";

/**
 * Non-SOL pairs (lead 13.10, docs/analysis/launchpads-b.md §7 + launchpads-a.md):
 * the ledger stays in LAMPORTS. Every vault keeps a small STOCK of each quote
 * token, refilled in batches on a schedule (`fund_quote`, never next to a
 * trade); a trade spends that stock. Only when the stock is short, the same
 * transaction carries a swap leg SOL -> quote (ExactOut, exactly what the
 * trade needs) through a PINNED pool ("pool A", Meteora DAMM v2). A separate
 * swap tx before a trade: never.
 *
 * Pool A, checked 13.10 (pnpm pool-a:probe, read-only simulateTransaction):
 * - mainnet SOL/USDC `8Pm2kZ…Pmie`: ~11 500 SOL / ~564 000 USDC, swap2
 *   ExactOut simulated OK (25k CU);
 * - mainnet SOL/USD1: no DAMM v2 pool with liquidity (largest 0.02 SOL) ->
 *   USD1 has no pool A (its venue path stays off until one is pinned, e.g.
 *   a Raydium CLMM leg);
 * - devnet SOL/USDC (Raydium's devnet USDC `USDCoct…`, the mint LaunchLab
 *   uses): `H9TBVi…` ~0.54 SOL / 65 USDC, ExactOut simulated OK.
 * Quotes are computed LOCALLY from the pool state (CpAmm.getQuote2), never
 * from Jupiter / a third party per request.
 */

export type QuoteSymbol = "USDC" | "USD1" | "ZEC";
/** Quote sets differ per venue (devnet USDC of pump.fun != Raydium/LaunchLab's, launchpads-a.md #6). */
export type QuoteVenue = "meteora-dbc" | "pumpfun";

export interface QuoteAsset {
  symbol: QuoteSymbol;
  mint: PublicKey;
  decimals: number;
  tokenProgram: PublicKey;
  /** Pinned SOL/quote pool (DAMM v2); null = no SOL<->quote route (trades with this quote are refused). */
  poolA: PublicKey | null;
  /** Unzeen's DBC config for this quote (one config = one quote mint); null = not created yet. */
  dbcConfig: PublicKey | null;
}

interface Defaults {
  mint: string;
  decimals: number;
  poolA: string | null;
  dbcConfig: string | null;
}

export const QUOTE_DEFAULTS: Record<"mainnet-beta" | "devnet", Partial<Record<QuoteSymbol, Defaults>>> = {
  "mainnet-beta": {
    USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, poolA: "8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie", dbcConfig: null },
    USD1: { mint: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", decimals: 6, poolA: null, dbcConfig: null },
  },
  devnet: {
    // Raydium's devnet USDC (LaunchLab's devnet quote), NOT pump.fun's devnet USDC 4zMMC9….
    // dbcConfig created 2026-10-13 by `pnpm meteora:config --quote USDC --send` (partner Anp6G3…).
    USDC: { mint: "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT", decimals: 6, poolA: "H9TBViXp3WZMuekHh4vwGWkDPEUx1kyFaR3mykpsF45Q", dbcConfig: "HikwxNE3Us5Uw3ydMbAbNH8o6fmJseMdu9WndmGhetDa" },
  },
};

/**
 * pump.fun quotes (launchpads-a.md §1): Global whitelists USDC; ZEC comes from
 * QuoteControl on mainnet only (owner decision pending: PUMP_QUOTE_ZEC=1).
 * Devnet: pump's own devnet USDC 4zMMC9… with its DAMM v2 pool A (14 SOL / 170 USDC, 13.10).
 */
export const PUMP_QUOTE_DEFAULTS: Record<"mainnet-beta" | "devnet", Partial<Record<QuoteSymbol, Defaults>>> = {
  "mainnet-beta": {
    USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, poolA: "8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie", dbcConfig: null },
    // ZEC (SPL, 8 decimals, no freeze authority): no DAMM v2 pool with liquidity (13.10) -> no pool A yet.
    ZEC: { mint: "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS", decimals: 8, poolA: null, dbcConfig: null },
  },
  devnet: {
    USDC: { mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, poolA: "A7sYJqmWsqyKzkyEZg8fQrMWFKdrFpQA4E1Msa9Pnvur", dbcConfig: null },
  },
};

/** Back-compat for the probe script. */
export const QUOTE_MINTS = {
  "mainnet-beta": Object.fromEntries(Object.entries(QUOTE_DEFAULTS["mainnet-beta"]).map(([k, v]) => [k, { mint: v!.mint, decimals: v!.decimals }])),
  devnet: Object.fromEntries(Object.entries(QUOTE_DEFAULTS.devnet).map(([k, v]) => [k, { mint: v!.mint, decimals: v!.decimals }])),
} as Record<"mainnet-beta" | "devnet", Partial<Record<QuoteSymbol, { mint: string; decimals: number }>>>;

/**
 * Quote assets of a network. Env (per network, per symbol):
 * QUOTE_<SYM>_MINT_<NET>, POOL_A_<SYM>_<NET>, METEORA_DBC_CONFIG_<NET>_<SYM>
 * (NET = DEVNET | MAINNET). `POOL_A_…=none` disables a default pool.
 */
export function quoteAssets(cluster: SolanaCluster, env: NodeJS.ProcessEnv = process.env, venue: QuoteVenue = "meteora-dbc"): QuoteAsset[] {
  if (cluster !== "devnet" && cluster !== "mainnet-beta") return [];
  const net = cluster === "devnet" ? "DEVNET" : "MAINNET";
  const pre = venue === "pumpfun" ? "PUMP_" : "";
  const table = venue === "pumpfun" ? PUMP_QUOTE_DEFAULTS : QUOTE_DEFAULTS;
  const out: QuoteAsset[] = [];
  for (const [sym, d] of Object.entries(table[cluster]) as [QuoteSymbol, Defaults][]) {
    if (venue === "pumpfun" && sym === "ZEC" && env.PUMP_QUOTE_ZEC?.trim() !== "1") continue; // owner decision pending
    const pk = (name: string, fallback: string | null): PublicKey | null => {
      const v = env[name]?.trim();
      if (v === "none") return null;
      const s = v || fallback;
      if (!s) return null;
      try {
        return new PublicKey(s);
      } catch {
        throw new Error(`${name}: not a base58 address`);
      }
    };
    out.push({
      symbol: sym,
      mint: pk(`${pre}QUOTE_${sym}_MINT_${net}`, d.mint)!,
      decimals: d.decimals,
      tokenProgram: TOKEN_PROGRAM_ID, // USDC / USD1 / devnet USDC are SPL Token (checked 13.10)
      poolA: pk(`${pre}POOL_A_${sym}_${net}`, d.poolA),
      dbcConfig: venue === "pumpfun" ? null : pk(`METEORA_DBC_CONFIG_${net}_${sym}`, d.dbcConfig),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// pool A
// ---------------------------------------------------------------------------

export interface PoolAState {
  address: PublicKey;
  pool: PoolState;
  point: BN;
  solIsA: boolean;
}

/** SOL <-> quote on a pinned DAMM v2 pool: local quotes + swap2 instructions. */
export class PoolA {
  private readonly amm: CpAmm;
  constructor(
    private readonly connection: Connection,
    readonly address: PublicKey,
    readonly quote: Pick<QuoteAsset, "mint" | "decimals" | "tokenProgram">,
  ) {
    this.amm = new CpAmm(connection);
  }

  /** Current pool state (one read) and the activation point for fee math. */
  async load(): Promise<PoolAState> {
    let pool: PoolState;
    try {
      pool = await this.amm.fetchPoolState(this.address);
    } catch (e) {
      throw new AdapterError("venue_unavailable", "pool A not readable", { cause: e });
    }
    const solIsA = pool.tokenAMint.equals(NATIVE_MINT);
    const other = solIsA ? pool.tokenBMint : pool.tokenAMint;
    if (!(solIsA || pool.tokenBMint.equals(NATIVE_MINT)) || !other.equals(this.quote.mint)) {
      throw new AdapterError("internal", "pool A is not SOL/quote");
    }
    const point = await getCurrentPoint(this.connection, pool.activationType);
    return { address: this.address, pool, point, solIsA };
  }

  /** Quote units out for `lamports` SOL in (ExactIn, fees included). */
  quoteForSol(s: PoolAState, lamports: bigint): bigint {
    if (lamports <= 0n) return 0n;
    return toBig(this.q(s, NATIVE_MINT, { swapMode: SwapMode.ExactIn, amountIn: toBN(lamports) }).outputAmount);
  }

  /** Lamports in to get exactly `units` quote out (ExactOut, fees included). */
  solForExactQuote(s: PoolAState, units: bigint): bigint {
    if (units <= 0n) return 0n;
    return toBig(this.q(s, NATIVE_MINT, { swapMode: SwapMode.ExactOut, amountOut: toBN(units) }).includedFeeInputAmount);
  }

  /** Lamports out for `units` quote in (ExactIn): the value of quote in SOL. */
  solForQuote(s: PoolAState, units: bigint): bigint {
    if (units <= 0n) return 0n;
    return toBig(this.q(s, this.quote.mint, { swapMode: SwapMode.ExactIn, amountIn: toBN(units) }).outputAmount);
  }

  /** swap2 SOL -> quote, ExactOut `units`, paying at most `maxLamports`. */
  async buyQuoteExactOut(payer: PublicKey, s: PoolAState, units: bigint, maxLamports: bigint): Promise<TransactionInstruction[]> {
    return this.ixs(payer, s, NATIVE_MINT, this.quote.mint, { swapMode: SwapMode.ExactOut, amountOut: toBN(units), maximumAmountIn: toBN(maxLamports) });
  }

  /** swap2 quote -> SOL, ExactIn `units`, at least `minLamports`. */
  async sellQuoteExactIn(payer: PublicKey, s: PoolAState, units: bigint, minLamports: bigint): Promise<TransactionInstruction[]> {
    return this.ixs(payer, s, this.quote.mint, NATIVE_MINT, { swapMode: SwapMode.ExactIn, amountIn: toBN(units), minimumAmountOut: toBN(minLamports) });
  }

  private q(s: PoolAState, input: PublicKey, mode: { swapMode: SwapMode.ExactIn; amountIn: BN } | { swapMode: SwapMode.ExactOut; amountOut: BN }) {
    const [decA, decB] = s.solIsA ? [9, this.quote.decimals] : [this.quote.decimals, 9];
    try {
      return this.amm.getQuote2({ inputTokenMint: input, slippage: 0, currentPoint: s.point, poolState: s.pool, tokenADecimal: decA, tokenBDecimal: decB, hasReferral: false, ...mode });
    } catch (e) {
      throw new AdapterError("slippage", `pool A cannot quote: ${e instanceof Error ? e.message.slice(0, 80) : "error"}`, { cause: e });
    }
  }

  private async ixs(
    payer: PublicKey,
    s: PoolAState,
    input: PublicKey,
    output: PublicKey,
    mode:
      | { swapMode: SwapMode.ExactIn; amountIn: BN; minimumAmountOut: BN }
      | { swapMode: SwapMode.ExactOut; amountOut: BN; maximumAmountIn: BN },
  ): Promise<TransactionInstruction[]> {
    const p = s.pool;
    try {
      const tx = await this.amm.swap2({
        payer,
        pool: this.address,
        inputTokenMint: input,
        outputTokenMint: output,
        tokenAMint: p.tokenAMint,
        tokenBMint: p.tokenBMint,
        tokenAVault: p.tokenAVault,
        tokenBVault: p.tokenBVault,
        tokenAProgram: s.solIsA ? TOKEN_PROGRAM_ID : this.quote.tokenProgram,
        tokenBProgram: s.solIsA ? this.quote.tokenProgram : TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
        poolState: p,
        ...mode,
      });
      return tx.instructions;
    } catch (e) {
      throw new AdapterError("venue_unavailable", `pool A swap: ${e instanceof Error ? e.message.slice(0, 80) : "error"}`, { cause: e });
    }
  }
}

/** DAMM v2 EvtSwap2 of `pool` in a confirmed tx: SOL in / out of the pool A leg. */
export function poolASwapLegs(tx: VersionedTransactionResponse, pool: PublicKey): { tradeDirection: number; inputAmount: bigint; outputAmount: bigint }[] {
  const ev = (CpAmmIdl.events as ReadonlyArray<{ name: string; discriminator: number[] }>).find((e) => e.name === "EvtSwap2");
  if (!ev) return [];
  const out: { tradeDirection: number; inputAmount: bigint; outputAmount: bigint }[] = [];
  for (const p of anchorEventPayloads(tx, CP_AMM_PROGRAM_ID, Buffer.from(ev.discriminator))) {
    try {
      // EvtSwap2: pool (32) | trade_direction u8 | collect_fee_mode u8 | has_referral bool | params { amount_0 u64, amount_1 u64, swap_mode u8 }
      //           | swap_result { included_fee_input_amount u64, excluded_fee_input_amount u64, amount_left u64, output_amount u64, ... }
      if (!new PublicKey(p.subarray(0, 32)).equals(pool)) continue;
      const dir = p.readUInt8(32);
      const r = 32 + 3 + 17;
      out.push({ tradeDirection: dir, inputAmount: p.readBigUInt64LE(r), outputAmount: p.readBigUInt64LE(r + 24) });
    } catch {
      /* layout drift: caller falls back to balance deltas */
    }
  }
  return out;
}

export { CP_AMM_PROGRAM_ID };
