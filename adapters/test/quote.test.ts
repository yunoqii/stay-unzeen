import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { getBuyTokenAmountFromSolAmount, newBondingCurve, type BondingCurve } from "@pump-fun/pump-sdk";
import { curveStatus, priceAndCap, quoteBuy, quoteSell, tradeLamports } from "../src/pumpfun";
import { toBig } from "../src/math";
import { loadParams } from "./helpers";

const { global, feeConfig } = loadParams();
const SOL = 1_000_000_000n;

// Real curves always have a creator; with the zero key no creator fee is charged.
const CREATOR = Keypair.generate().publicKey;

function freshCurve(): { curve: BondingCurve; base: bigint } {
  const curve = { ...newBondingCurve(global), creator: CREATOR };
  return { curve, base: toBig(curve.tokenTotalSupply) };
}

/** Applies a buy to virtual/real reserves like the program does (fees aside). */
function afterBuy(curve: BondingCurve, tokensOut: bigint, solIn: bigint): BondingCurve {
  return {
    ...curve,
    virtualTokenReserves: curve.virtualTokenReserves.sub(new BN(tokensOut.toString())),
    realTokenReserves: curve.realTokenReserves.sub(new BN(tokensOut.toString())),
    virtualQuoteReserves: curve.virtualQuoteReserves.add(new BN(solIn.toString())),
    realQuoteReserves: curve.realQuoteReserves.add(new BN(solIn.toString())),
  };
}

describe("fixture", () => {
  it("decodes real devnet params", () => {
    expect(global.initialized).toBe(true);
    expect(global.initialVirtualTokenReserves.gtn(0)).toBe(true);
    expect(feeConfig.feeTiers.length).toBeGreaterThan(0);
  });
  it("devnet fee schedule: 0.95% protocol + 0.30% creator at the lowest tier", () => {
    const t0 = feeConfig.feeTiers[0]!;
    expect(t0.fees.protocolFeeBps.toNumber()).toBe(95);
    expect(t0.fees.creatorFeeBps.toNumber()).toBe(30);
  });
});

describe("quoteBuy", () => {
  it("is positive and monotonic in lamports", () => {
    const { curve, base } = freshCurve();
    const a = quoteBuy(global, feeConfig, curve, base, SOL / 100n);
    const b = quoteBuy(global, feeConfig, curve, base, SOL / 10n);
    expect(a).toBeGreaterThan(0n);
    expect(b).toBeGreaterThan(a);
    // concave: 10x SOL buys < 10x tokens on a constant-product curve
    expect(b).toBeLessThan(a * 10n);
  });

  it("matches the create-time quote within rounding", () => {
    const { curve, base } = freshCurve();
    const lamports = SOL / 20n;
    const v3 = quoteBuy(global, feeConfig, curve, base, lamports);
    const create = toBig(
      getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: null,
        bondingCurve: null,
        amount: new BN(lamports.toString()),
        quoteMint: NATIVE_MINT,
      }),
    );
    const diff = v3 > create ? v3 - create : create - v3;
    expect(Number(diff) / Number(create)).toBeLessThan(1e-6);
  });

  it("charges fees: price paid is above spot", () => {
    const { curve, base } = freshCurve();
    const lamports = SOL / 1000n; // tiny buy, almost no price impact
    const out = quoteBuy(global, feeConfig, curve, base, lamports);
    const spotOut = (lamports * toBig(curve.virtualTokenReserves)) / toBig(curve.virtualQuoteReserves);
    expect(out).toBeLessThan(spotOut);
    // 1.25% fees (+ tiny price impact)
    const ratio = Number(out) / Number(spotOut);
    expect(ratio).toBeGreaterThan(0.985);
    expect(ratio).toBeLessThan(0.99);
  });

  it("returns 0 on a complete curve", () => {
    const { curve, base } = freshCurve();
    expect(quoteBuy(global, feeConfig, { ...curve, complete: true }, base, SOL)).toBe(0n);
  });
});

describe("quoteSell", () => {
  it("buy then sell loses only fees (round trip < input, > 90%)", () => {
    const { curve, base } = freshCurve();
    const lamports = SOL / 10n;
    const tokens = quoteBuy(global, feeConfig, curve, base, lamports);
    const after = afterBuy(curve, tokens, lamports);
    const back = quoteSell(global, feeConfig, after, tokens);
    expect(back).toBeLessThan(lamports);
    expect(Number(back) / Number(lamports)).toBeGreaterThan(0.9);
  });

  it("is monotonic in tokens", () => {
    const { curve, base } = freshCurve();
    const tokens = quoteBuy(global, feeConfig, curve, base, SOL);
    const after = afterBuy(curve, tokens, SOL);
    expect(quoteSell(global, feeConfig, after, tokens / 2n)).toBeLessThan(quoteSell(global, feeConfig, after, tokens));
  });
});

describe("status / price", () => {
  it("fresh curve is on the curve, complete or migrated is graduated", () => {
    const { curve } = freshCurve();
    expect(curveStatus(curve)).toBe("curve");
    expect(curveStatus({ ...curve, complete: true })).toBe("graduated");
    const zero = new BN(0);
    expect(
      curveStatus({
        ...curve,
        virtualQuoteReserves: zero,
        virtualTokenReserves: zero,
        realQuoteReserves: zero,
        realTokenReserves: zero,
      }),
    ).toBe("graduated");
  });

  it("price and market cap of a fresh curve", () => {
    const { curve } = freshCurve();
    const { priceSol, marketCapSol } = priceAndCap(curve, 6);
    const vq = Number(curve.virtualQuoteReserves.toString()) / 1e9;
    const vt = Number(curve.virtualTokenReserves.toString()) / 1e6;
    const supply = Number(curve.tokenTotalSupply.toString()) / 1e6;
    expect(Number(priceSol)).toBeCloseTo(vq / vt, 12);
    expect(Number(marketCapSol)).toBeCloseTo((vq / vt) * supply, 3);
  });
});

describe("tradeLamports", () => {
  const bn = (n: number) => new BN(n);
  it("buy adds fees, sell subtracts them", () => {
    expect(tradeLamports({ isBuy: true, solAmount: bn(1_000_000), fee: bn(9_500), creatorFee: bn(3_000) })).toBe(
      1_012_500n,
    );
    expect(tradeLamports({ isBuy: false, solAmount: bn(1_000_000), fee: bn(9_500), creatorFee: bn(3_000) })).toBe(
      987_500n,
    );
  });
});
