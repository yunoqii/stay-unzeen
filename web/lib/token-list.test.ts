import { describe, expect, it } from "vitest";
import type { ListedToken } from "./token-list";
import { DEFAULT_FILTERS, filterTokens, isNearGraduation, matchesQuery } from "./token-list";

const t = (symbol: string, extra: Partial<ListedToken> = {}): ListedToken => ({
  mint: `Mint${symbol}111111111111111111111111111`,
  symbol,
  name: `${symbol} name`,
  venue: "pumpfun",
  status: "curve",
  decimals: 6,
  priceSol: "0.000001",
  marketCapSol: "100",
  createdAt: 1000,
  ...extra,
});

const list = [
  t("PEPE", { volume24hSol: "50", unzeenTrades24h: 9, marketCapSol: "300", createdAt: 3000, curveProgressPct: "85" }),
  t("GHOST", { unzeenLaunch: true, volume24hSol: "5", unzeenTrades24h: 30, createdAt: 5000, curveProgressPct: "20" }),
  t("UMBRA", { venue: "meteora-dbc", volume24hSol: "12", marketCapSol: "900", createdAt: 1000, status: "graduated" }),
  t("NOX", { mint: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", volume24hSol: undefined, marketCapSol: "50", createdAt: 9000 }),
];
const ids = (f: Partial<typeof DEFAULT_FILTERS>) => filterTokens(list, { ...DEFAULT_FILTERS, ...f }).map((x) => x.symbol);

describe("/tokens filters (local only)", () => {
  it("sorts by volume, market cap, age and unzeen trades", () => {
    expect(ids({})).toEqual(["PEPE", "UMBRA", "GHOST", "NOX"]);
    expect(ids({ sort: "mcap" })).toEqual(["UMBRA", "PEPE", "GHOST", "NOX"]);
    expect(ids({ sort: "age" })).toEqual(["NOX", "GHOST", "PEPE", "UMBRA"]);
    expect(ids({ sort: "trades" })).toEqual(["GHOST", "PEPE", "NOX", "UMBRA"]);
  });
  it("filters by Unzeen launch, venue and status", () => {
    expect(ids({ unzeenOnly: true })).toEqual(["GHOST"]);
    expect(ids({ venue: "meteora-dbc" })).toEqual(["UMBRA"]);
    expect(ids({ status: "graduated" })).toEqual(["UMBRA"]);
    expect(ids({ status: "near" })).toEqual(["PEPE"]);
    expect(ids({ status: "curve" })).toEqual(["PEPE", "GHOST", "NOX"]);
    expect(isNearGraduation(list[0])).toBe(true);
  });
  it("searches ticker, $ticker, name and contract address", () => {
    expect(ids({ query: "$gho" })).toEqual(["GHOST"]);
    expect(ids({ query: "umbra name" })).toEqual(["UMBRA"]);
    expect(matchesQuery(list[3], "DXwBbmkg8Z")).toBe(true);
    expect(ids({ query: "nothing" })).toEqual([]);
  });
});
