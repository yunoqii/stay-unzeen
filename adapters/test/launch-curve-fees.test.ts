import BN from "bn.js";
import { describe, expect, it } from "vitest";
import { feeTiersJson, LaunchCurveWriter, pumpFeeTiers, pumpLaunchCurve } from "../src/relayer/launch-curves";

const bn = (n: number | string) => new BN(n);
const fees = (protocol: number, creator: number, lp = 0) => ({ lpFeeBps: bn(lp), protocolFeeBps: bn(protocol), creatorFeeBps: bn(creator) });
// pump.fun devnet on 15.10 (read live): Global 95 + 5, FeeConfig one tier 95 + 30.
const GLOBAL = {
  initialVirtualSolReserves: bn(300_000_000),
  initialVirtualTokenReserves: bn("1073000000000000"),
  initialRealTokenReserves: bn("793100000000000"),
  tokenTotalSupply: bn("1000000000000000"),
  feeBasisPoints: bn(95),
  creatorFeeBasisPoints: bn(5),
};
const DEVNET_FEE_CONFIG = { feeTiers: [{ marketCapLamportsThreshold: bn(0), fees: fees(95, 30) }] };

describe("pump.fun trade fee from chain (API v0.27)", () => {
  it("FeeConfig tiers win over Global: devnet 15.10 = 125 bps, as the TradeEvent charged", () => {
    expect(pumpFeeTiers(GLOBAL, DEVNET_FEE_CONFIG)).toEqual([{ marketCapLamports: 0n, bps: 125 }]);
    expect(pumpLaunchCurve(GLOBAL, DEVNET_FEE_CONFIG).feeTiers).toEqual([{ marketCapLamports: 0n, bps: 125 }]);
  });

  it("market-cap tiers keep their order; the lp share (AMM-only) is not counted", () => {
    const fc = {
      feeTiers: [
        { marketCapLamportsThreshold: bn("420000000000"), fees: fees(80, 20, 25) },
        { marketCapLamportsThreshold: bn(0), fees: fees(95, 30, 20) },
      ],
    };
    expect(pumpFeeTiers(GLOBAL, fc)).toEqual([
      { marketCapLamports: 0n, bps: 125 },
      { marketCapLamports: 420_000_000_000n, bps: 100 },
    ]);
    expect(feeTiersJson(pumpFeeTiers(GLOBAL, fc))).toBe('[{"marketCapLamports":"0","bps":125},{"marketCapLamports":"420000000000","bps":100}]');
  });

  it("no FeeConfig: Global fee + creator fee; nothing read: no tiers (core falls back)", () => {
    expect(pumpFeeTiers(GLOBAL, null)).toEqual([{ marketCapLamports: 0n, bps: 100 }]);
    expect(pumpFeeTiers(GLOBAL, { feeTiers: [] })).toEqual([{ marketCapLamports: 0n, bps: 100 }]);
    expect(pumpLaunchCurve(GLOBAL).feeTiers).toBeUndefined();
  });

  it("refuses values core would reject", () => {
    expect(() => pumpFeeTiers(GLOBAL, { feeTiers: [{ marketCapLamportsThreshold: bn(0), fees: fees(6_000, 0) }] })).toThrow();
    const dup = { feeTiers: [0, 0].map((m) => ({ marketCapLamportsThreshold: bn(m), fees: fees(95, 30) })) };
    expect(() => pumpFeeTiers(GLOBAL, dup)).toThrow();
  });

  it("writer: reserves always, fee tiers when core has 0034, silently skipped before it", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    let column = true;
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("fee_tiers") && !column) throw Object.assign(new Error("no column"), { code: "42703" });
        return { rows: [] };
      },
    };
    const w = new LaunchCurveWriter(pool as never, "devnet", async () => [pumpLaunchCurve(GLOBAL, DEVNET_FEE_CONFIG)]);
    expect(await w.writeOnce()).toBe(1);
    expect(calls.map((c) => c.sql.trim().split(/\s+/)[0])).toEqual(["INSERT", "UPDATE"]);
    expect(calls[1]!.params).toEqual(["devnet", "pumpfun", '[{"marketCapLamports":"0","bps":125}]']);
    column = false;
    calls.length = 0;
    const w2 = new LaunchCurveWriter(pool as never, "devnet", async () => [pumpLaunchCurve(GLOBAL, DEVNET_FEE_CONFIG)]);
    expect(await w2.writeOnce()).toBe(1);
    expect(await w2.writeOnce()).toBe(1);
    expect(calls.filter((c) => c.sql.includes("fee_tiers")).length).toBe(1); // tried once, then off
  });
});
