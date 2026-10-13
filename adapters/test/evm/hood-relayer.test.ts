import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { FunderPool } from "../../src/evm/funders";
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
    expect(rowToHoodSpec({ ...base, op: "attest", venue: null, mint: null, meta: { memo: "ab".repeat(32), purpose: "verify" } }, "hood")).toEqual({ kind: "attest", memo: "ab".repeat(32), purpose: "verify" });
  });

  it("refuses foreign networks, venues, Solana mints, non-ETH pairs", () => {
    expect(() => rowToHoodSpec({ ...base, op: "buy", lamports_in: "1", min_out: "1" }, "hood-testnet")).toThrow(/network|relayer is/);
    expect(() => rowToHoodSpec({ ...base, op: "buy", venue: "pumpfun", lamports_in: "1", min_out: "1" }, "hood")).toThrow(/pons/);
    expect(() => rowToHoodSpec({ ...base, op: "buy", mint: "So11111111111111111111111111111111111111112", lamports_in: "1", min_out: "1" }, "hood")).toThrow(/EVM address/);
    expect(() => rowToHoodSpec({ ...base, op: "create", meta: { name: "A", symbol: "B", quote: "USDC" } }, "hood")).toThrow(/ETH-paired/);
    expect(() => rowToHoodSpec({ ...base, op: "fund_vaults" }, "hood")).toThrow(/not supported/);
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
    expect(await pool.plan()).toEqual([{ index: 1, value: 5n * 10n ** 16n }]); // 0.05 - 0.003 -> ceil to 0.01
  });
});
