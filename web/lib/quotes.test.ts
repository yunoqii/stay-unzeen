import { maxInitialBuyZat } from "./launch-rules";
import { describe, expect, it } from "vitest";
import type { PoolInfo } from "@/lib/api/types";
import { canClaim, claimAmount, minClaimZat } from "./claim";
import { checkInitialBuy } from "./launch";
import { orderSupport } from "./orders";
import { eventQuote, formatQuote, launchQuotes, pairLabel, quoteOfMint, quotePerSol, tokenQuote, venueLabel, ZEC_SPL_MINT, zecSpreadBps } from "./quotes";
import { DEFAULT_FILTERS, filterTokens, type ListedToken } from "./token-list";
import { quoteBuyZecPair, quoteSellZecPair, zecPairValueZat } from "./trade";

const pool: Pick<PoolInfo, "quotes" | "orders" | "minActionZat" | "minClaimZat" | "launchRules" | "rate"> = {
  minActionZat: "100000",
  minClaimZat: "10000",
  quotes: [
    { quote: "ZEC", mint: ZEC_SPL_MINT, decimals: 8, bridged: true, venues: ["pumpfun", "raydium-launchlab"], spreadBps: 30 },
    { quote: "USDC", mint: "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT", decimals: 6, bridged: false, venues: ["meteora-dbc", "raydium-launchlab"] },
    { quote: "USD1", mint: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", decimals: 6, bridged: false, venues: ["meteora-dbc", "raydium-launchlab"] },
  ],
  launchRules: { lockSecs: 86_400, capBps: 500, maxInitialBuyLamports: "1500000000" },
  rate: { lamportsPerZec: "1800000000", lamportsPerZecBuy: "1791000000", lamportsPerZecSell: "1809000000", spreadBps: 50, source: "fixed", ts: 0 },
  orders: {
    kinds: ["limit_buy"],
    venues: ["pumpfun"],
    maxOpenPerKey: 10,
    maxOpenPerMint: 4,
    maxTtlSecs: 259_200,
    defaultTtlSecs: 86_400,
    defaultSlippageBps: { limit_buy: 500, limit_sell: 500, take_profit: 500, stop_loss: 1500 },
    slConfirmTicks: 2,
    priceTick: { minSecs: 45, maxSecs: 75 },
  },
};

describe("pairs: helpers", () => {
  it("names the quote of a mint (pool first, then the known registry) and of a feed event", () => {
    expect(quoteOfMint(ZEC_SPL_MINT, null)).toEqual({ quote: "ZEC", decimals: 8, bridged: true });
    expect(quoteOfMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")?.quote).toBe("USDC");
    expect(quoteOfMint("11111111111111111111111111111111")).toBeNull();
    expect(eventQuote({ quoteMint: ZEC_SPL_MINT, quoteAmount: "310000000" })).toEqual({ quote: "ZEC", amount: 3.1 });
    expect(eventQuote({ quoteMint: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", quoteAmount: "45000000" })).toEqual({ quote: "USD1", amount: 45 });
    expect(eventQuote({})).toBeNull();
  });

  it("formats amounts per quote", () => {
    expect(formatQuote(3.1, "ZEC")).toBe("3.1");
    expect(formatQuote(0.123456, "ZEC")).toBe("0.1235");
    expect(formatQuote(45, "USDC")).toBe("45");
    expect(formatQuote(0.004, "USDC")).toBe("<0.01");
    expect(pairLabel("PEPE", "ZEC")).toBe("$PEPE/ZEC");
    expect(venueLabel("raydium-launchlab", "bonk")).toBe("bonk.fun · LaunchLab");
    expect(venueLabel("pumpfun")).toBe("pump.fun");
  });

  it("offers launch pairs per venue from PoolInfo.quotes, SOL always", () => {
    expect(launchQuotes(pool, "pumpfun")).toEqual(["SOL", "ZEC"]);
    expect(launchQuotes(pool, "meteora-dbc")).toEqual(["SOL", "USDC", "USD1"]);
    expect(launchQuotes(pool, "raydium-launchlab")).toEqual(["SOL", "ZEC", "USDC", "USD1"]);
    expect(launchQuotes({ quotes: [] }, "raydium-launchlab")).toEqual(["SOL"]);
    expect(zecSpreadBps(pool)).toBe(30);
    expect(zecSpreadBps({ quotes: [] })).toBeNull();
  });

  it("treats a token without quote as SOL; quote per SOL needs both prices", () => {
    expect(tokenQuote({})).toBe("SOL");
    expect(quotePerSol({ priceSol: "0.000002", priceQuote: "0.000001" })).toBeCloseTo(0.5);
    expect(quotePerSol({ priceSol: "0", priceQuote: "0.000001" })).toBeNull();
  });
});

describe("pairs: ZEC SPL parity quotes (no SOL rate)", () => {
  it("buy: zecIn × (1 − s) of ZEC SPL at priceQuote; sell: proceeds / (1 + s)", () => {
    // 0.1 ZEC at 30 bps -> 0.0997 ZEC SPL; price 0.000001 ZEC per token (6 decimals) -> 99 700 tokens
    const b = quoteBuyZecPair(BigInt(10_000_000), 30, "0.000001", 6, 8, 100)!;
    expect(b.quoteUnits).toBe(BigInt(9_970_000));
    expect(b.tokensOut).toBe(BigInt(99_700_000_000));
    expect(b.minOut).toBe(BigInt(98_703_000_000));
    const s = quoteSellZecPair(BigInt(100_000_000_000), 30, "0.000001", 6, 8, 0)!;
    expect(s.quoteUnits).toBe(BigInt(10_000_000));
    expect(s.zecOut).toBe((BigInt(10_000_000) * BigInt(10_000)) / BigInt(10_030));
    expect(zecPairValueZat(BigInt(100_000_000_000), 30, "0.000001", 6)).toBe(s.zecOut);
    expect(quoteBuyZecPair(BigInt(1), 30, undefined, 6, 8, 100)).toBeNull();
  });
});

describe("pairs: launch and orders", () => {
  it("ZEC launches skip the lamport cap (the server checks the ZEC curve); others keep it", () => {
    expect(checkInitialBuy("1", pool, "pumpfun", "ZEC")).toEqual({ ok: true, zat: BigInt(100_000_000) });
    expect(checkInitialBuy("1", pool, "pumpfun", "SOL").ok).toBe(false);
    expect(checkInitialBuy("1", pool, "meteora-dbc", "USDC").ok).toBe(false);
    expect(checkInitialBuy("0.0001", pool, "pumpfun", "ZEC").ok).toBe(false); // the minimum still applies
  });

  it("v0.17: ZEC launches respect maxInitialBuyZecUnitsByVenue (ZEC SPL units after the parity spread, like core)", () => {
    const capped = {
      ...pool,
      quotes: [{ quote: "ZEC" as const, mint: "Z", decimals: 8, bridged: true, venues: ["pumpfun" as const], spreadBps: 30 }],
      launchRules: { lockSecs: 86_400, capBps: 500, maxInitialBuyLamports: "0", maxInitialBuyZecUnitsByVenue: { pumpfun: "1300000000" } },
    };
    // 13 ZEC SPL / 0.997 = 13.03911735 ZEC max.
    expect(maxInitialBuyZat(capped, "pumpfun", "ZEC")).toBe(BigInt(1_303_911_735));
    expect(checkInitialBuy("13.039", capped, "pumpfun", "ZEC").ok).toBe(true);
    const over = checkInitialBuy("13.05", capped, "pumpfun", "ZEC");
    expect(over.ok).toBe(false);
    expect(!over.ok && over.error).toMatch(/Up to 13\.039/);
    // Not published for this venue (devnet {}): the server checks it.
    expect(maxInitialBuyZat(capped, "raydium-launchlab", "ZEC")).toBeNull();
    expect(checkInitialBuy("99", capped, "raydium-launchlab", "ZEC").ok).toBe(true);
  });

  it("orders exist only on SOL pairs, with a reason that names the pair", () => {
    const t = { mint: "M", venue: "pumpfun" as const, status: "curve" as const };
    expect(orderSupport({ ...t, quote: "SOL" }, pool, [{ mint: "M" }]).ok).toBe(true);
    const z = orderSupport({ ...t, quote: "ZEC" }, pool, [{ mint: "M" }]);
    expect(z.ok).toBe(false);
    expect(!z.ok && z.reason).toContain("ZEC");
  });
});

describe("claim (v0.14): lamports at the sell rate + zat, minClaimZat on the sum", () => {
  const rate = BigInt(1_809_000_000);
  it("sums both parts", () => {
    const a = claimAmount("9000000", "6000", rate);
    expect(a.totalZat).toBe((BigInt(9_000_000) * BigInt(100_000_000)) / rate + BigInt(6_000));
    expect(canClaim(a, minClaimZat(pool))).toBe(true);
  });
  it("is off below the minimum, nothing owed, and judges zat alone without a rate", () => {
    expect(canClaim(claimAmount("0", "6000", rate), BigInt(10_000))).toBe(false);
    expect(canClaim(claimAmount("0", "12000", null), BigInt(10_000))).toBe(true);
    expect(canClaim(claimAmount("0", "0", rate), BigInt(10_000))).toBe(false);
    expect(minClaimZat({ minActionZat: "100000" })).toBe(BigInt(100_000));
  });
});

describe("/tokens pair filter", () => {
  const row = (symbol: string, extra: Partial<ListedToken>): ListedToken => ({
    mint: `Mint${symbol}`,
    symbol,
    name: symbol,
    venue: "pumpfun",
    status: "curve",
    decimals: 6,
    priceSol: "0.000001",
    marketCapSol: "10",
    createdAt: 1,
    ...extra,
  });
  const list = [row("A", { quote: "SOL" }), row("B", { quote: "ZEC" }), row("C", { quote: "USDC" }), row("D", {})];
  const ids = (quote: (typeof DEFAULT_FILTERS)["quote"]) => filterTokens(list, { ...DEFAULT_FILTERS, quote }).map((t) => t.symbol).sort();
  it("matches the pair; rows without a known pair (Discovery) only under Any pair", () => {
    expect(ids("all")).toEqual(["A", "B", "C", "D"]);
    expect(ids("ZEC")).toEqual(["B"]);
    expect(ids("SOL")).toEqual(["A"]);
    expect(ids("USD1")).toEqual([]);
  });
});

describe("orders v0.15: bracket and rearm helpers", async () => {
  const { checkBracket, defaultSlippage, firedAs, rearmNote } = await import("./orders");
  it("checks both legs and TP above SL", () => {
    expect(checkBracket("0.000002", "0.000001")).toBeNull();
    expect(checkBracket("0.000001", "0.000002")).toMatch(/above the stop-loss/);
    expect(checkBracket("0.000001", "0.000001")).not.toBeNull();
    expect(checkBracket("abc", "0.000001")).not.toBeNull();
  });
  it("maps a fired leg to the kind it behaved like; bracket default slippage falls back to 500", () => {
    expect(firedAs({ kind: "bracket", leg: "sl" })).toBe("stop_loss");
    expect(firedAs({ kind: "bracket", leg: "tp" })).toBe("take_profit");
    expect(firedAs({ kind: "limit_buy" })).toBe("limit_buy");
    expect(defaultSlippage(pool.orders!, "bracket")).toBe(500);
    expect(defaultSlippage({ defaultSlippageBps: { ...pool.orders!.defaultSlippageBps, bracket: 700 } }, "bracket")).toBe(700);
  });
  it("says the honest retry line", () => {
    expect(rearmNote(3)).toBe("Retries after slippage up to 3 times. A stop-loss with retry may still not exit in a crash.");
  });
});

describe("v0.16 venues drive launch pairs", () => {
  it("uses PoolInfo.venues[].quotes when present", async () => {
    const { launchQuotes } = await import("./quotes");
    const venues = [{ venue: "bags" as const, trade: true, create: true, quotes: ["SOL" as const], atomicFirstBuy: false, creatorFees: false, mainnetOnly: true }];
    expect(launchQuotes({ ...pool, venues }, "bags")).toEqual(["SOL"]);
    expect(launchQuotes({ ...pool, venues: [] }, "pumpfun")).toEqual(["SOL", "ZEC"]);
  });
});
