import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { FUNDER_DEFAULTS, FunderPool, funderOptionsFromEnv, funderPollMsFromEnv } from "../../src/evm/funders";
import { EvmFeeCache } from "../../src/evm/fees";
import { EvmKeyring } from "../../src/evm/keys";
import { FileLaunchStore } from "../../src/evm/relayer/launches";
import { rowToHoodSpec } from "../../src/evm/relayer/queue";
import type { EvmExecutor } from "../../src/evm/executor";
import { TEST_MNEMONIC } from "./cases";

const base = { id: "1", venue: "pons", mint: "0xcd70e319f13d4611f2e5f5d603c52724bcea3300", lamports_in: null, token_amount: null, min_out: null, meta: null, dest: null, gas_lamports: null, network: "hood" };

describe("hood job rows", () => {
  it("maps buy / sell / create / transfer / attest; amounts above u64 stay exact", () => {
    expect(rowToHoodSpec({ ...base, op: "buy", lamports_in: "10000000000000000", min_out: "1" }, "hood")).toEqual({
      kind: "buy",
      token: "0xcd70E319F13D4611F2e5f5D603C52724bCea3300",
      weiIn: 10n ** 16n,
      minOut: 1n,
    });
    expect(rowToHoodSpec({ ...base, op: "sell", token_amount: "1000000000000000000000000000", min_out: "0" }, "hood")).toMatchObject({ amount: 10n ** 27n });
    expect(rowToHoodSpec({ ...base, op: "create", mint: null, meta: { name: "A", symbol: "B" } }, "hood")).toMatchObject({ kind: "create", weiIn: 0n });
    expect(rowToHoodSpec({ ...base, op: "transfer", token_amount: "123000", dest: "0xabc", gas_lamports: "50000000000000" }, "hood")).toMatchObject({ kind: "withdraw", gasWei: 5n * 10n ** 13n });
    expect(rowToHoodSpec({ ...base, op: "fund_vaults", venue: null, mint: null, lamports_in: "1000000000000000000" }, "hood")).toEqual({ kind: "fund_vaults", wei: 10n ** 18n });
    expect(rowToHoodSpec({ ...base, op: "attest", venue: null, mint: null, meta: { memo: "ab".repeat(32), purpose: "verify" } }, "hood")).toEqual({ kind: "attest", memo: "ab".repeat(32), purpose: "verify" });
  });

  it("refuses foreign networks, venues, Solana mints, non-ETH pairs", () => {
    expect(() => rowToHoodSpec({ ...base, op: "buy", lamports_in: "1", min_out: "1" }, "hood-testnet")).toThrow(/network|relayer is/);
    expect(() => rowToHoodSpec({ ...base, op: "buy", venue: "pumpfun", lamports_in: "1", min_out: "1" }, "hood")).toThrow(/pons/);
    expect(() => rowToHoodSpec({ ...base, op: "buy", mint: "So11111111111111111111111111111111111111112", lamports_in: "1", min_out: "1" }, "hood")).toThrow(/EVM address/);
    expect(() => rowToHoodSpec({ ...base, op: "create", meta: { name: "A", symbol: "B", quote: "USDC" } }, "hood")).toThrow(/ETH-paired/);
    expect(() => rowToHoodSpec({ ...base, op: "fund_quote" }, "hood")).toThrow(/not supported/);
  });
});

describe("pending launch store", () => {
  it("file store: 0600, survives reopen, deletes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hood-launch-"));
    try {
      const s = FileLaunchStore.inDir(dir);
      await s.put("42", { creatorIndex: 7, fromBlock: 87_000_000n });
      expect(fs.statSync(s.file).mode & 0o777).toBe(0o600);
      expect(await FileLaunchStore.inDir(dir).get("42")).toEqual({ creatorIndex: 7, fromBlock: 87_000_000n });
      await s.delete("42");
      expect((await s.all()).size).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("funder rotation", () => {
  const kr = new EvmKeyring(TEST_MNEMONIC);
  const fake = (bal: (a: Address) => bigint) =>
    ({ fees: new EvmFeeCache(200_000_000n, async () => 1n), balance: async (a: Address) => bal(a) }) as unknown as EvmExecutor;

  it("never the same funder twice in a row; only funders that can cover the launch", async () => {
    const pool = new FunderPool({ executor: fake(() => 10n ** 18n), keyring: kr, count: 4 });
    let last = "";
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const f = (await pool.pick(10n ** 16n)).address;
      expect(f).not.toBe(last);
      last = f;
      seen.add(f);
    }
    expect(seen.size).toBeGreaterThan(2);
    const poor = new FunderPool({ executor: fake((a) => (a === kr.funder(2).address ? 10n ** 18n : 0n)), keyring: kr, count: 4 });
    expect((await poor.pick(10n ** 16n)).address).toBe(kr.funder(2).address);
    const none = new FunderPool({ executor: fake(() => 0n), keyring: kr, count: 4 });
    await expect(none.pick(1n)).rejects.toMatchObject({ apiCode: "pool_liquidity" });
  });

  it("top-up plan: only low funders, round lots", async () => {
    const pool = new FunderPool({ executor: fake((a) => (a === kr.funder(1).address ? 3n * 10n ** 15n : 10n ** 17n)), keyring: kr, count: 3 });
    expect(await pool.plan()).toEqual([{ index: 1, value: 2n * 10n ** 16n }]); // 0.02 - 0.003 -> ceil to 0.005
    const big = new FunderPool({ executor: fake((a) => (a === kr.funder(1).address ? 3n * 10n ** 15n : 10n ** 17n)), keyring: kr, count: 3, targetWei: 5n * 10n ** 16n, lowWei: 2n * 10n ** 16n, lotWei: 10n ** 16n });
    expect(await big.plan()).toEqual([{ index: 1, value: 5n * 10n ** 16n }]); // 0.05 - 0.003 -> ceil to 0.01
  });
});

describe("GAP-7: funder thresholds from env", () => {
  it("defaults are demo-sized: target 0.02, low 0.011, lot 0.005 ETH", () => {
    expect(funderOptionsFromEnv({})).toEqual({ targetWei: 20_000_000_000_000_000n, lowWei: 11_000_000_000_000_000n, lotWei: 5_000_000_000_000_000n });
    expect(FUNDER_DEFAULTS.targetWei).toBe(20_000_000_000_000_000n);
  });
  it("env overrides; validation low < target, lot <= target, integers > 0", () => {
    expect(funderOptionsFromEnv({ HOOD_FUNDER_TARGET_WEI: "50000000000000000", HOOD_FUNDER_LOW_WEI: "20000000000000000", HOOD_FUNDER_LOT_WEI: "10000000000000000" })).toEqual({
      targetWei: 5n * 10n ** 16n,
      lowWei: 2n * 10n ** 16n,
      lotWei: 10n ** 16n,
    });
    expect(() => funderOptionsFromEnv({ HOOD_FUNDER_LOW_WEI: "20000000000000000" })).toThrow(/LOW_WEI must be below/);
    expect(() => funderOptionsFromEnv({ HOOD_FUNDER_LOT_WEI: "30000000000000000" })).toThrow(/LOT_WEI must not exceed/);
    expect(() => funderOptionsFromEnv({ HOOD_FUNDER_TARGET_WEI: "0.02" })).toThrow(/integer in wei/);
    expect(() => funderOptionsFromEnv({ HOOD_FUNDER_TARGET_WEI: "0" })).toThrow(/> 0/);
    const ex = { fees: new EvmFeeCache(200_000_000n, async () => 1n), balance: async () => 0n } as unknown as EvmExecutor;
    expect(() => new FunderPool({ executor: ex, keyring: new EvmKeyring(TEST_MNEMONIC), lowWei: 5n, targetWei: 5n })).toThrow(RangeError);
  });
  it("GAP-8 poll interval: HOOD_FUNDER_POLL_SECS 30..3600, default 300 s", () => {
    expect(funderPollMsFromEnv({})).toBe(300_000);
    expect(funderPollMsFromEnv({ HOOD_FUNDER_POLL_SECS: "120" })).toBe(120_000);
    expect(() => funderPollMsFromEnv({ HOOD_FUNDER_POLL_SECS: "5" })).toThrow(/30..3600/);
  });
});

describe("GAP-8: funder top-up when ETH arrives on the rebalance address", () => {
  const kr = new EvmKeyring(TEST_MNEMONIC);
  const REB = kr.rebalance(0).address;
  const ETH = 10n ** 18n;
  function world(rebalance: bigint, funders: bigint[]) {
    const bal = new Map<string, bigint>([[REB, rebalance], ...funders.map((b, i) => [kr.funder(i).address, b] as [string, bigint])]);
    const transfers: { from: string; to: string; value: bigint }[] = [];
    const fees = new EvmFeeCache(1_000_000_000n, async () => 1n);
    const ex = {
      fees,
      balance: async (a: Address) => bal.get(a) ?? 0n,
      transfer: async (from: { address: Address }, to: Address, value: bigint) => {
        const gas = 100_000n * fees.maxFeePerGas;
        if ((bal.get(from.address) ?? 0n) < value + gas) throw new Error("insufficient");
        bal.set(from.address, (bal.get(from.address) ?? 0n) - value - gas);
        bal.set(to, (bal.get(to) ?? 0n) + value);
        transfers.push({ from: from.address, to, value });
        return {};
      },
    } as unknown as EvmExecutor;
    const pool = new FunderPool({ executor: ex, keyring: kr, count: funders.length, sleep: async () => undefined });
    return { bal, transfers, pool };
  }

  it("first poll only records; no change -> nothing; arrival -> low funders topped up from rebalance only", async () => {
    const w = world(0n, [0n]);
    expect(await w.pool.topUpOnArrival()).toEqual({ arrived: false, sent: 0, totalWei: 0n });
    expect(await w.pool.topUpOnArrival()).toEqual({ arrived: false, sent: 0, totalWei: 0n });
    w.bal.set(REB, (22n * ETH) / 1000n); // 1Click delivered 0.022 ETH (plan: keep on rebalance-0)
    const r = await w.pool.topUpOnArrival();
    expect(r).toEqual({ arrived: true, sent: 1, totalWei: (2n * ETH) / 100n });
    expect(w.transfers).toEqual([{ from: REB, to: kr.funder(0).address, value: (2n * ETH) / 100n }]);
    // our own outflow is not an arrival
    expect((await w.pool.topUpOnArrival()).arrived).toBe(false);
    expect(w.transfers).toHaveLength(1);
  });

  it("only what the rebalance address can pay is sent (no failing transfer); the rest waits", async () => {
    const w = world(0n, [0n, 0n]);
    await w.pool.topUpOnArrival();
    w.bal.set(REB, (25n * ETH) / 1000n); // covers one 0.02 lot + gas, not two
    const r = await w.pool.topUpOnArrival();
    expect(r.sent).toBe(1);
    expect(w.transfers).toHaveLength(1);
    w.bal.set(REB, (w.bal.get(REB) ?? 0n) + (3n * ETH) / 100n); // next lot arrives
    expect((await w.pool.topUpOnArrival()).sent).toBe(1);
    expect(new Set(w.transfers.map((t) => t.to)).size).toBe(2);
    expect(w.transfers.every((t) => t.from === REB)).toBe(true);
  });

  it("top-ups are serialized: the 1–3 h cycle and the poll never double-fund", async () => {
    const w = world(ETH, [0n]);
    await w.pool.topUpOnArrival(); // record
    w.bal.set(REB, 2n * ETH);
    const [a, b] = await Promise.all([w.pool.topUp(), w.pool.topUpOnArrival()]);
    expect(a.sent + b.sent).toBe(1);
    expect(w.bal.get(kr.funder(0).address)).toBe((2n * ETH) / 100n);
  });
});
