import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { newBondingCurve, type BondingCurve } from "@pump-fun/pump-sdk";
import type { PoolConfig, VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { swapQuoteExactIn } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { dbcCoder } from "../src/meteora";
import { quoteBuy, quoteSell } from "../src/pumpfun";
import { freshPool, swapOut, UNZEEN_PLATFORM, fundRaisingFor } from "../src/launchlab";
import { toBig } from "../src/math";
import { NATIVE_MINT } from "@solana/spl-token";
import { curveJson, dbcCurveState, dbcProgress, estimateBuy, estimateSell, launchLabCurveState, launchLabProgress, pct2, pumpCurveState } from "../src/intel/curves";
import { loadParams } from "./helpers";

/**
 * API v0.28 `TokenCurve`: the one formula (estimateBuy / estimateSell) against the
 * venues' own SDK math, on real devnet accounts (pump Global + FeeConfig, Unzeen's
 * DBC config + a live pool) and the LaunchLab curve of our launch parameters.
 */

const { global, feeConfig } = loadParams();
const CREATOR = Keypair.generate().publicKey;
const SOL = 1_000_000_000n;

/** |a − b| ≤ b · bps / 10⁴ (+1 for rounding). */
function near(a: bigint, b: bigint, bps: bigint) {
  const d = a > b ? a - b : b - a;
  expect(d * 10_000n <= b * bps + 10_000n, `${a} vs ${b}`).toBe(true);
}

function afterBuy(curve: BondingCurve, tokensOut: bigint, solIn: bigint): BondingCurve {
  return {
    ...curve,
    virtualTokenReserves: curve.virtualTokenReserves.sub(new BN(tokensOut.toString())),
    realTokenReserves: curve.realTokenReserves.sub(new BN(tokensOut.toString())),
    virtualQuoteReserves: curve.virtualQuoteReserves.add(new BN(solIn.toString())),
    realQuoteReserves: curve.realQuoteReserves.add(new BN(solIn.toString())),
  };
}

describe("pump.fun curve state", () => {
  const fresh = { ...newBondingCurve(global), creator: CREATOR };
  const base = toBig(fresh.tokenTotalSupply);

  it("S, T = virtual reserves; fee added on top; limit = SOL to empty the real reserves", () => {
    const c = pumpCurveState(fresh)!;
    expect(c.virtualSol).toBe(toBig(fresh.virtualQuoteReserves));
    expect(c.virtualTokens).toBe(toBig(fresh.virtualTokenReserves));
    expect(c.buyFee).toBe("added");
    expect(c.feeBps).toBeNull(); // core fills in the FeeConfig tier
    // buying exactly the limit (net) takes every real token
    const r = toBig(fresh.realTokenReserves);
    const out = (c.virtualTokens * c.buyLimitLamports!) / (c.virtualSol + c.buyLimitLamports!);
    near(out, r, 1n);
    expect(curveJson(c)).toEqual({ virtualSol: c.virtualSol.toString(), virtualTokens: c.virtualTokens.toString(), buyFee: "added", buyLimitLamports: c.buyLimitLamports!.toString() });
  });

  it("formula == pump SDK quotes (125 bps devnet tier) on a fresh and a traded curve", () => {
    let curve: BondingCurve = fresh;
    for (const step of [0n, SOL / 3n, SOL]) {
      if (step > 0n) curve = afterBuy(curve, quoteBuy(global, feeConfig, curve, base, step), (step * 10_000n) / 10_125n);
      const c = { ...pumpCurveState(curve)!, feeBps: 125 };
      for (const x of [10_000_000n, SOL / 10n, SOL]) {
        if ((x * 10_000n) / 10_125n >= c.buyLimitLamports!) continue; // the SDK caps at the real reserves (partial fill)
        near(estimateBuy(c, x), quoteBuy(global, feeConfig, curve, base, x), 2n);
      }
      for (const a of [10n ** 9n, 10n ** 12n, 5n * 10n ** 13n]) near(estimateSell(c, a), quoteSell(global, feeConfig, curve, a), 2n);
    }
  });
});

interface FxAcc { address: string; owner: string; lamports: number; data: string }
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "dbc-devnet-accounts.json"), "utf8")) as Record<"config" | "pool" | "mint", FxAcc>;
const acc = (f: FxAcc): AccountInfo<Buffer> => ({ data: Buffer.from(f.data, "base64"), owner: new PublicKey(f.owner), lamports: f.lamports, executable: false });

describe("Meteora DBC curve state (Unzeen devnet config + live pool)", () => {
  const config = dbcCoder().accounts.decode("poolConfig", acc(FX.config).data) as PoolConfig;
  const vp = dbcCoder().accounts.decode("virtualPool", acc(FX.pool).data) as VirtualPool;
  const pool = (vp as unknown as { poolState?: VirtualPool["poolState"] }).poolState ?? (vp as unknown as VirtualPool["poolState"]);
  const point = new BN(10).pow(new BN(12)); // long after activation: scheduler over

  it("reserves reproduce the spot price; flat 1 % fee taken from the input", () => {
    const c = dbcCurveState(pool, config, point)!;
    expect(c).not.toBeNull();
    expect(c.feeBps).toBe(100);
    expect(c.buyFee).toBe("input");
    const sp = toBig(pool.sqrtPrice);
    // S/T = sqrtPrice² / 2^128 (lamports per base unit)
    near((c.virtualSol * (1n << 128n)) / c.virtualTokens, sp * sp, 1n);
    expect(c.buyLimitLamports! > 0n).toBe(true);
    expect(c.buyLimitLamports! <= toBig(config.migrationQuoteThreshold) - toBig(pool.quoteReserve)).toBe(true);
    expect(dbcProgress(pool, config)).toMatch(/^\d{1,3}\.\d{2}$/);
  });

  it("formula == SDK swapQuoteExactIn for buys and sells inside the segment", () => {
    const c = dbcCurveState(pool, config, point)!;
    const q = (dirSell: boolean, amount: bigint) => toBig(swapQuoteExactIn(vp as never, config as never, dirSell, new BN(amount.toString()), 0, false, point, false).outputAmount);
    for (const x of [10_000_000n, SOL / 10n, SOL, 10n * SOL]) {
      if (x >= c.buyLimitLamports!) continue;
      near(estimateBuy(c, x), q(false, x), 1n);
    }
    for (const a of [10n ** 9n, 10n ** 12n, 10n ** 13n]) {
      if (c.sellLimitTokens !== null && a >= c.sellLimitTokens) continue;
      near(estimateSell(c, a), q(true, a), 1n);
    }
  });

  it("no state without a fee point or past the last segment", () => {
    expect(dbcCurveState(pool, config, null)).toBeNull();
    expect(dbcCurveState({ ...pool, sqrtPrice: new BN(0) }, config, point)).toBeNull();
    expect(dbcCurveState({ ...pool, sqrtPrice: config.migrationSqrtPrice }, config, point)).toBeNull();
  });
});

describe("Raydium LaunchLab curve state (constant product, Unzeen platform fees)", () => {
  const cfg = { tradeFeeRate: new BN(2_500), curveType: 0 };
  const plat = { feeRate: new BN(UNZEEN_PLATFORM.feeRate), creatorFeeRate: new BN(UNZEEN_PLATFORM.creatorFeeRate) };
  const fresh = freshPool({ migrateFee: new BN(0) } as never, new BN(fundRaisingFor({ mint: NATIVE_MINT, decimals: 9 }).toString()));

  it("1 % total fee from the input; formula == SDK curve math", () => {
    let pool = fresh;
    for (const step of [0n, 3n * SOL, 20n * SOL]) {
      if (step > 0n) {
        const out = swapOut("buy", pool, cfg, plat, step, 0);
        const net = (step * 99n) / 100n;
        pool = { ...pool, realA: pool.realA.add(new BN(out.toString())), realB: pool.realB.add(new BN(net.toString())) } as typeof pool;
      }
      const c = launchLabCurveState(pool, cfg, plat)!;
      expect(c.feeBps).toBe(100);
      expect(c.buyFee).toBe("input");
      for (const x of [10_000_000n, SOL, 5n * SOL]) near(estimateBuy(c, x), swapOut("buy", pool, cfg, plat, x, 0), 2n);
      for (const a of [10n ** 9n, 10n ** 12n, 10n ** 13n]) near(estimateSell(c, a), swapOut("sell", pool, cfg, plat, a, 0), 2n);
    }
    expect(launchLabProgress(fresh)).toBe("0.00");
    expect(launchLabCurveState(fresh, { ...cfg, curveType: 1 }, plat)).toBeNull();
  });
});

describe("formula edge cases", () => {
  it("output-fee mode takes the fee from the tokens", () => {
    const c = { virtualSol: 30n * SOL, virtualTokens: 10n ** 15n, feeBps: 100, buyFee: "output" as const };
    const gross = (c.virtualTokens * SOL) / (c.virtualSol + SOL);
    expect(estimateBuy(c, SOL)).toBe((gross * 9_900n) / 10_000n);
  });
  it("pct2 floors and clamps", () => {
    expect(pct2(1n, 3n)).toBe("33.33");
    expect(pct2(5n, 3n)).toBe("100.00");
    expect(pct2(0n, 0n)).toBe("100.00");
  });
});
