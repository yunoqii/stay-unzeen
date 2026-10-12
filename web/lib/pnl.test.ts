import { describe, expect, it } from "vitest";
import { avgEntrySol, avgEntryZec, computePosition, unrealized, type Fill } from "./pnl";

const D = 6; // pump.fun decimals
const tok = (whole: number) => String(BigInt(Math.round(whole * 1e6)));
const zat = (zec: number) => String(BigInt(Math.round(zec * 1e8)));
const lam = (sol: number) => String(BigInt(Math.round(sol * 1e9)));

const buy = (ts: number, tokens: number, zec: number, sol: number): Fill => ({ kind: "buy", ts, tokenAmount: tok(tokens), zecSpent: zat(zec), solAmount: lam(sol) });
const sell = (ts: number, tokens: number, zec: number, sol: number): Fill => ({ kind: "sell", ts, tokenAmount: tok(tokens), zecCredited: zat(zec), solAmount: lam(sol) });

describe("pnl: weighted average entry", () => {
  it("averages two buys by size", () => {
    // 1000 @ 1 ZEC + 3000 @ 1.5 ZEC = 4000 tokens for 2.5 ZEC -> 0.000625 ZEC per token
    const p = computePosition([buy(1, 1000, 1, 1.8), buy(2, 3000, 1.5, 2.7)]);
    expect(p.qty).toBe(BigInt(tok(4000)));
    expect(p.costZat).toBe(BigInt(zat(2.5)));
    expect(avgEntryZec(p, D)).toBeCloseTo(0.000625, 12);
    expect(avgEntrySol(p, D)).toBeCloseTo(4.5 / 4000, 12);
    expect(p.buys).toBe(2);
    expect(p.incomplete).toBe(false);
  });

  it("order of fills does not matter (sorted by ts)", () => {
    const a = computePosition([buy(1, 1000, 1, 1), sell(3, 500, 0.8, 0.8), buy(2, 1000, 2, 2)]);
    const b = computePosition([buy(2, 1000, 2, 2), buy(1, 1000, 1, 1), sell(3, 500, 0.8, 0.8)]);
    expect(a).toEqual(b);
  });
});

describe("pnl: partial sell", () => {
  it("removes cost pro rata and books realized PnL", () => {
    // 2000 tokens for 2 ZEC (avg 0.001); sell 500 for 0.8 ZEC -> cost out 0.5, realized +0.3
    const p = computePosition([buy(1, 2000, 2, 3.6), sell(2, 500, 0.8, 1.44)]);
    expect(p.qty).toBe(BigInt(tok(1500)));
    expect(p.costZat).toBe(BigInt(zat(1.5)));
    expect(p.realizedZat).toBe(BigInt(zat(0.3)));
    // the average entry does not move on a sell
    expect(avgEntryZec(p, D)).toBeCloseTo(0.001, 12);
    expect(avgEntrySol(p, D)).toBeCloseTo(3.6 / 2000, 12);
  });

  it("a losing partial sell books a negative realized PnL", () => {
    const p = computePosition([buy(1, 1000, 1, 1), sell(2, 250, 0.1, 0.1)]);
    expect(p.realizedZat).toBe(BigInt(zat(0.1)) - BigInt(zat(0.25)));
  });

  it("selling everything clears the cost basis", () => {
    const p = computePosition([buy(1, 1000, 1, 1), sell(2, 400, 0.5, 0.5), sell(3, 600, 0.9, 0.9)]);
    expect(p.qty).toBe(BigInt(0));
    expect(p.costZat).toBe(BigInt(0));
    expect(p.costLamports).toBe(BigInt(0));
    expect(p.realizedZat).toBe(BigInt(zat(0.4)));
    expect(avgEntryZec(p, D)).toBeNull();
  });

  it("a token withdrawal lowers the position at cost, without realized PnL", () => {
    const p = computePosition([buy(1, 1000, 1, 1), { kind: "withdraw_token", ts: 2, tokenAmount: tok(250) }]);
    expect(p.qty).toBe(BigInt(tok(750)));
    expect(p.costZat).toBe(BigInt(zat(0.75)));
    expect(p.realizedZat).toBe(BigInt(0));
  });

  it("a sell larger than the tracked position is flagged incomplete and only the covered part counts", () => {
    // tracked 100 for 0.1; sold 200 for 0.4 -> covered half of proceeds 0.2 vs cost 0.1
    const p = computePosition([buy(1, 100, 0.1, 0.1), sell(2, 200, 0.4, 0.4)]);
    expect(p.incomplete).toBe(true);
    expect(p.qty).toBe(BigInt(0));
    expect(p.realizedZat).toBe(BigInt(zat(0.1)));
  });

  it("a launch without an initial buy adds nothing", () => {
    const p = computePosition([{ kind: "create", ts: 1, tokenAmount: "0", zecSpent: "0" }]);
    expect(p.buys).toBe(0);
    expect(p.qty).toBe(BigInt(0));
  });
});

describe("pnl: unrealized", () => {
  it("marks the remaining qty to price and the sell rate", () => {
    const p = computePosition([buy(1, 2000, 2, 3.6), sell(2, 500, 0.8, 1.44)]);
    // 1500 tokens at 0.002 SOL = 3 SOL; 2 SOL per ZEC -> 1.5 ZEC worth vs cost 1.5 -> 0
    const u = unrealized(p, "0.002", D, BigInt(2_000_000_000))!;
    expect(u.valueZat).toBe(BigInt(zat(1.5)));
    expect(u.pnlZat).toBe(BigInt(0));
    const up = unrealized(p, "0.004", D, BigInt(2_000_000_000))!;
    expect(up.pnlZat).toBe(BigInt(zat(1.5)));
    expect(up.pnlPct).toBeCloseTo(100, 6);
  });

  it("null without a position or a rate", () => {
    expect(unrealized(computePosition([]), "1", D, BigInt(1))).toBeNull();
    expect(unrealized(computePosition([buy(1, 1, 1, 1)]), "1", D, BigInt(0))).toBeNull();
  });
});
