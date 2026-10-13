import { PUMP_SDK } from "@pump-fun/pump-sdk";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  applyBuy,
  freshCurve,
  planFairLaunch,
  quoteFairLegs,
  quoteFreshBuy,
  scaleMinOut,
  splitMinOut,
  waterFill,
  type FairPlanConfig,
} from "../src/fair-bundle";
import { jitoTip } from "../src/jito";
import { toBig, toBN } from "../src/math";
import { signTx } from "../src/tx";
import { loadParams } from "./helpers";

const SOL = 1_000_000_000n;
const CFG: FairPlanConfig = { maxLegs: 5, maxPerVault: null, createReserve: 135_100_000n, legReserve: 105_200_000n, quantum: 1_000_000n, minLeg: 10_000_000n };
const v = (key: string, sol: bigint) => ({ key, sol });

describe("planFairLaunch", () => {
  it("one vault can carry it: v1 single tx, untouched amount", () => {
    const p = planFairLaunch(5n * SOL, [v("A", 2n * SOL), v("B", 9n * SOL)], CFG, { bundle: true });
    expect(p).toEqual({ mode: "single", vault: "B", lamports: 5n * SOL, capped: false });
  });

  it("splits over the fewest vaults, create leg first, totals exact, legs even-ish and quantized", () => {
    const vs = [v("A", 3n * SOL), v("B", 4n * SOL), v("C", 4n * SOL), v("D", 1n * SOL)];
    const p = planFairLaunch(9_123_456_789n, vs, CFG, { bundle: true });
    if (p.mode !== "bundle") throw new Error(p.mode);
    expect(p.capped).toBe(false);
    expect(p.legs.map((l) => l.vault)).toEqual(["B", "C", "A"]); // B richest (first in ties) = create
    expect(p.legs.reduce((s, l) => s + l.lamports, 0n)).toBe(9_123_456_789n);
    // all but the create leg are multiples of 0.001 SOL; none above its capacity
    for (const l of p.legs.slice(1)) expect(l.lamports % CFG.quantum).toBe(0n);
    const cap = (k: string, r: bigint) => vs.find((x) => x.key === k)!.sol - r;
    expect(p.legs[0]!.lamports).toBeLessThanOrEqual(cap("B", CFG.createReserve));
    for (const l of p.legs.slice(1)) expect(l.lamports).toBeLessThanOrEqual(cap(l.vault, CFG.legReserve));
    // A (smallest) is filled to its capacity, B and C split the rest evenly
    expect(p.legs[2]!.lamports).toBe(2_894_000_000n);
    const d = p.legs[0]!.lamports - p.legs[1]!.lamports;
    expect(d < 0n ? -d : d).toBeLessThanOrEqual(CFG.quantum * 2n);
  });

  it("pinned vault (earlier attempt) is always the create leg (D4)", () => {
    const p = planFairLaunch(6n * SOL, [v("A", 2n * SOL), v("B", 9n * SOL), v("C", 9n * SOL)], CFG, { bundle: true, pinned: "A" });
    if (p.mode !== "bundle") throw new Error(p.mode);
    expect(p.legs[0]!.vault).toBe("A");
    expect(p.legs.reduce((s, l) => s + l.lamports, 0n)).toBe(6n * SOL);
  });

  it("maxPerVault forces a split even when one vault could carry it", () => {
    const p = planFairLaunch(5n * SOL, [v("A", 9n * SOL), v("B", 9n * SOL)], { ...CFG, maxPerVault: 3n * SOL }, { bundle: true });
    if (p.mode !== "bundle") throw new Error(p.mode);
    expect(p.legs.every((l) => l.lamports <= 3n * SOL)).toBe(true);
    expect(p.legs.reduce((s, l) => s + l.lamports, 0n)).toBe(5n * SOL);
  });

  it("at most maxLegs; not enough capacity -> capped bundle (rest refunded by core)", () => {
    const vs = ["A", "B", "C", "D", "E", "F"].map((k) => v(k, 1n * SOL));
    const p = planFairLaunch(20n * SOL, vs, CFG, { bundle: true });
    if (p.mode !== "bundle") throw new Error(p.mode);
    expect(p.legs).toHaveLength(5);
    expect(p.capped).toBe(true);
    expect(p.legs.reduce((s, l) => s + l.lamports, 0n)).toBeLessThan(20n * SOL);
  });

  it("no bundle (Jito off / out of tries): ONE tx capped to the richest vault, quantized", () => {
    const p = planFairLaunch(9n * SOL, [v("A", 3n * SOL), v("B", 4n * SOL)], CFG, { bundle: false });
    expect(p).toEqual({ mode: "single", vault: "B", lamports: 3_864_000_000n, capped: true });
  });

  it("nothing usable -> insufficient", () => {
    expect(planFairLaunch(9n * SOL, [v("A", 100_000_000n)], CFG, { bundle: true })).toEqual({ mode: "insufficient" });
    expect(planFairLaunch(9n * SOL, [v("A", 100n * SOL)], CFG, { bundle: true, pinned: "Z" })).toEqual({ mode: "insufficient" });
    expect(planFairLaunch(9n * SOL, [], CFG, { bundle: true })).toEqual({ mode: "insufficient" });
  });

  it("leg amounts depend on the total and balances only (no per-bid fingerprint)", () => {
    const vs = [v("A", 4n * SOL), v("B", 4n * SOL), v("C", 4n * SOL)];
    const a = planFairLaunch(9n * SOL, vs, CFG, { bundle: true });
    const b = planFairLaunch(9n * SOL, vs, CFG, { bundle: true });
    expect(a).toEqual(b);
  });
});

describe("waterFill", () => {
  it("sums to the target when capacity allows; respects caps", () => {
    expect(waterFill(10n, [100n, 100n], 1n)).toEqual([5n, 5n]);
    expect(waterFill(10n, [2n, 100n, 100n], 1n)).toEqual([2n, 4n, 4n]);
    const w = waterFill(1_000_003n, [600_000n, 600_000n], 1_000n);
    expect(w.reduce((s, x) => s + x, 0n)).toBe(1_000_003n);
    expect(w[0]! % 1_000n).toBe(3n); // remainder on the create leg
    expect(waterFill(10n, [3n, 3n], 1n)).toEqual([3n, 3n]); // short: capped
  });
});

describe("fresh-curve quotes (devnet Global/FeeConfig snapshot)", () => {
  const { global, feeConfig } = loadParams();
  const creator = Keypair.generate().publicKey;

  it("legs sum to the single-tx quote (constant product: splitting is NOT cheaper)", () => {
    for (const total of [300_000_000n, 870_000_000n]) {
      const single = quoteFreshBuy(global, feeConfig, total);
      for (const n of [2n, 3n, 5n]) {
        const q = quoteFairLegs(global, feeConfig, creator, Array.from({ length: Number(n) }, () => total / n));
        const sum = q.reduce((s, x) => s + x.tokens, 0n);
        // within 1e-6 of each other (rounding only)
        expect(Number(single - sum) / Number(single)).toBeLessThan(1e-6);
        expect(Number(single - sum) / Number(single)).toBeGreaterThan(-1e-6);
      }
    }
  });

  it("later legs get fewer tokens per lamport (price rises along the curve)", () => {
    const q = quoteFairLegs(global, feeConfig, creator, [100_000_000n, 100_000_000n, 100_000_000n]);
    expect(q[0]!.tokens).toBeGreaterThan(q[1]!.tokens);
    expect(q[1]!.tokens).toBeGreaterThan(q[2]!.tokens);
    expect(q[0]!.curveBefore.creator.equals(creator)).toBe(true);
    expect(q[0]!.curveBefore.isMayhemMode).toBe(false);
    expect(toBig(q[1]!.curveBefore.virtualTokenReserves)).toBe(toBig(global.initialVirtualTokenReserves) - q[0]!.tokens);
  });

  it("applyBuy keeps the constant product (k never decreases)", () => {
    const c0 = freshCurve(global, creator);
    const c1 = applyBuy(c0, 10n ** 13n);
    const k = (c: typeof c0) => toBig(c.virtualTokenReserves) * toBig(c.virtualQuoteReserves);
    expect(k(c1)).toBeGreaterThanOrEqual(k(c0));
    expect(() => applyBuy(c0, toBig(c0.virtualTokenReserves))).toThrow();
  });

  it("a leg is buildable offline and fits a legacy tx with CU price + Jito tip", async () => {
    const q = quoteFairLegs(global, feeConfig, creator, [500_000_000n, 300_000_000n]);
    const mint = Keypair.generate().publicKey;
    const vault = Keypair.generate();
    const ixs = await PUMP_SDK.buyExactQuoteInV3Instructions({
      bondingCurve: q[1]!.curveBefore,
      associatedUserAccountInfo: null,
      mint,
      user: vault.publicKey,
      amount: toBN(q[1]!.tokens),
      quoteAmount: toBN(300_000_000n),
      slippage: 0,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    });
    const recent = { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1 };
    const conn = { getLatestBlockhash: async () => { throw new Error("must use the shared blockhash"); } };
    const tx = await signTx(conn, ixs, vault, [], { computeUnits: 300_000, priorityMicroLamports: 1_000, tip: jitoTip(5_000n) }, recent);
    expect(tx.raw.length).toBeLessThanOrEqual(1232);
    expect(tx.blockhash).toBe(recent.blockhash);
  });
});

describe("min_out distribution", () => {
  it("splitMinOut: pro rata, sum <= min_out, throws when legs cannot reach it", () => {
    const m = splitMinOut(1_000n, [600n, 300n, 200n]);
    expect(m).toEqual([545n, 272n, 181n]);
    expect(m.reduce((s, x) => s + x, 0n)).toBeLessThanOrEqual(1_000n);
    expect(() => splitMinOut(2_000n, [600n, 300n])).toThrow();
    expect(() => splitMinOut(0n, [1n])).toThrow();
    expect(splitMinOut(1n, [10n, 1n])).toEqual([1n, 1n]);
  });
  it("scaleMinOut: same ratio for the capped part", () => {
    expect(scaleMinOut(990n, 500n, 1_000n)).toBe(495n);
    expect(scaleMinOut(1n, 1n, 1_000n)).toBe(1n);
  });
});
