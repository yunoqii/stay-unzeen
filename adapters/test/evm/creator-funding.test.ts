import { describe, expect, it } from "vitest";
import type { Address, LocalAccount } from "viem";
import type { HoodConfig } from "../../src/evm/chain";
import type { EvmExecutor } from "../../src/evm/executor";
import type { EvmKeyring } from "../../src/evm/keys";
import { PonsAdapter } from "../../src/evm/pons/adapter";
import {
  CREATOR_FUNDING_DEFAULTS,
  CREATOR_FUNDING_UNIT_WEI,
  PONS_CREATE_GAS_LIMIT,
  assertCreatorGasReserve,
  creatorFundingFromEnv,
  creatorFundingWarning,
  funderNeedForOneCreate,
} from "../../src/evm/pons/creator-funding";
import { quantizeGasLimit } from "../../src/evm/fees";
import { hoodPonsAdapter } from "../../src/evm/runtime";

const GWEI = 1_000_000_000n;
const ETH = 10n ** 18n;
const mETH = 10n ** 15n; // 0.001 ETH
const LAUNCH_FEE = 500_000_000_000_000n; // 0.0005 ETH (factory launchFee, 19.10)
/** docs/submission/mainnet-demo-run-lite.md §3.2, variant L1 (reserve 0.0018 ETH after review-hood-l1). */
const L1 = { HOOD_CREATOR_FUND_STEP_WEI: "500000000000000", HOOD_CREATOR_GAS_RESERVE_WEI: "1800000000000000" };

describe("creator funding env", () => {
  it("defaults when unset or empty (0.01 ETH step, 0.002 ETH reserve)", () => {
    const d = { fundStepWei: 10_000_000_000_000_000n, gasReserveWei: 2_000_000_000_000_000n };
    expect(CREATOR_FUNDING_DEFAULTS).toEqual(d);
    expect(creatorFundingFromEnv({})).toEqual(d);
    expect(creatorFundingFromEnv({ HOOD_CREATOR_FUND_STEP_WEI: "", HOOD_CREATOR_GAS_RESERVE_WEI: "  " })).toEqual(d);
  });

  it("reads decimal wei", () => {
    expect(creatorFundingFromEnv(L1)).toEqual({ fundStepWei: 500_000_000_000_000n, gasReserveWei: 1_800_000_000_000_000n });
    // the previous L1 reserve stays valid
    expect(creatorFundingFromEnv({ HOOD_CREATOR_GAS_RESERVE_WEI: "1500000000000000" }).gasReserveWei).toBe(1_500_000_000_000_000n);
    // beyond 2^53: exact BigInt, no float rounding
    expect(creatorFundingFromEnv({ HOOD_CREATOR_FUND_STEP_WEI: "123456789000000000000000000" }).fundStepWei).toBe(123456789n * 10n ** 18n);
    // the minimum step is one unit (0.0001 ETH)
    expect(creatorFundingFromEnv({ HOOD_CREATOR_FUND_STEP_WEI: "100000000000000" }).fundStepWei).toBe(CREATOR_FUNDING_UNIT_WEI);
  });

  it("rejects non-integer and <= 0", () => {
    for (const name of ["HOOD_CREATOR_FUND_STEP_WEI", "HOOD_CREATOR_GAS_RESERVE_WEI"]) {
      for (const bad of ["0.01", "1e15", "-5", "0x10", "abc", "1_000"]) {
        expect(() => creatorFundingFromEnv({ [name]: bad }), `${name}=${bad}`).toThrow(new RegExp(`${name} must be an integer in wei`));
      }
      expect(() => creatorFundingFromEnv({ [name]: "0" })).toThrow(new RegExp(`${name} must be > 0`));
      // not round: below one unit, or not a multiple of 0.0001 ETH
      for (const bad of ["500", "99999999999999", "150000000000001", "1550000000000000"]) {
        expect(() => creatorFundingFromEnv({ [name]: bad }), `${name}=${bad}`).toThrow(new RegExp(`${name}=${bad} must be a multiple of 100000000000000 wei`));
      }
    }
  });
});

describe("creator gas reserve refusal", () => {
  it("6.0M covers the executor's gas limit for the observed max 4.61M create with 4 buckets of headroom", () => {
    expect(PONS_CREATE_GAS_LIMIT).toBe(6_000_000n);
    expect(quantizeGasLimit(4_610_000n)).toBe(5_600_000n);
    expect(quantizeGasLimit(5_000_000n)).toBe(PONS_CREATE_GAS_LIMIT);
    expect(quantizeGasLimit(5_000_001n)).toBeGreaterThan(PONS_CREATE_GAS_LIMIT);
  });

  it("accepts reserve >= 6.0M x maxFee, refuses below", () => {
    const fee = 200_000_000n; // 0.2 gwei default HOOD_MAX_FEE_WEI
    const need = 6_000_000n * fee; // 0.0012 ETH
    expect(() => assertCreatorGasReserve({ fundStepWei: mETH, gasReserveWei: need }, fee)).not.toThrow();
    expect(() => assertCreatorGasReserve(CREATOR_FUNDING_DEFAULTS, fee)).not.toThrow();
    expect(() => assertCreatorGasReserve(creatorFundingFromEnv(L1), fee)).not.toThrow();
    expect(() => assertCreatorGasReserve({ fundStepWei: mETH, gasReserveWei: need - 1n }, fee)).toThrow(/HOOD_CREATOR_GAS_RESERVE_WEI=1199999999999999 is below/);
    // the default reserve fails once the fee cap passes ~0.333 gwei
    expect(() => assertCreatorGasReserve(CREATOR_FUNDING_DEFAULTS, 4n * GWEI / 10n)).toThrow(/insufficient funds/);
  });

  function exec(maxFee: bigint): EvmExecutor {
    return { fees: { maxFeePerGas: maxFee } } as unknown as EvmExecutor;
  }
  const cfg = (maxFeeFloorWei: bigint) => ({ chainId: 4663, maxFeeFloorWei }) as HoodConfig;
  const kr = {} as EvmKeyring;
  const funders = { pick: async () => ({}) as LocalAccount } as never;

  it("hoodPonsAdapter refuses at start against max(floor, fee cache)", () => {
    const low = { fundStepWei: mETH, gasReserveWei: 1_000_000_000_000_000n }; // 0.001 < 0.0012
    expect(() => hoodPonsAdapter(cfg(200_000_000n), exec(100_000_000n), kr, funders, undefined, low)).toThrow(/below the upfront gas/);
    // floor ok, but the live cache already rose above it
    const l1 = creatorFundingFromEnv(L1);
    expect(hoodPonsAdapter(cfg(200_000_000n), exec(200_000_000n), kr, funders, undefined, l1)).toBeInstanceOf(PonsAdapter);
    // L1 reserve 0.0018 holds up to 0.3 gwei, refuses at 0.4
    expect(hoodPonsAdapter(cfg(200_000_000n), exec(300_000_000n), kr, funders, undefined, l1)).toBeInstanceOf(PonsAdapter);
    expect(() => hoodPonsAdapter(cfg(200_000_000n), exec(400_000_000n), kr, funders, undefined, l1)).toThrow(/below the upfront gas/);
    // not the Pons chain: null, no check
    expect(hoodPonsAdapter({ ...cfg(200_000_000n), chainId: 46630 }, exec(GWEI), kr, funders, undefined, low)).toBeNull();
  });

  it("hoodPonsAdapter reads env by default", () => {
    const prev = process.env.HOOD_CREATOR_GAS_RESERVE_WEI;
    process.env.HOOD_CREATOR_GAS_RESERVE_WEI = "1000000000000000";
    try {
      expect(() => hoodPonsAdapter(cfg(200_000_000n), exec(200_000_000n), kr, funders)).toThrow(/RESERVE_WEI=1000000000000000 is below/);
    } finally {
      if (prev === undefined) delete process.env.HOOD_CREATOR_GAS_RESERVE_WEI;
      else process.env.HOOD_CREATOR_GAS_RESERVE_WEI = prev;
    }
  });
});

describe("funder target warning", () => {
  const fee = 200_000_000n;
  it("counts the fee-cap reserve when it exceeds the configured one", () => {
    const f = creatorFundingFromEnv(L1);
    // 0.4 gwei: reserve -> 6.0M x 0.4 = 0.0024; ceil(0.0005 + 0.0024 + 1 wei, 0.0005) = 0.003, + 100k x 0.4 gwei
    expect(funderNeedForOneCreate(f, LAUNCH_FEE, 400_000_000n)).toBe(3_000_000_000_000_000n + 40_000_000_000_000n);
    expect(creatorFundingWarning(f, { funderTargetWei: 2_600_000_000_000_000n, launchFeeWei: LAUNCH_FEE, maxFeePerGas: 400_000_000n })).not.toBeNull();
  });

  it("L1: target 0.0026 covers 0.0025 + 100k x 0.2 gwei", () => {
    const f = creatorFundingFromEnv(L1);
    expect(funderNeedForOneCreate(f, LAUNCH_FEE, fee)).toBe(2_500_000_000_000_000n + 20_000_000_000_000n);
    expect(creatorFundingWarning(f, { funderTargetWei: 2_600_000_000_000_000n, launchFeeWei: LAUNCH_FEE, maxFeePerGas: fee })).toBeNull();
    expect(creatorFundingWarning(f, { funderTargetWei: 2_519_999_999_999_999n, launchFeeWei: LAUNCH_FEE, maxFeePerGas: fee })).toMatch(
      /HOOD_FUNDER_TARGET_WEI=2519999999999999 does not cover one create/,
    );
  });

  it("defaults: 0.02 target covers one 0.01 top-up; L1 target with default step does not", () => {
    expect(creatorFundingWarning(CREATOR_FUNDING_DEFAULTS, { funderTargetWei: 20n * mETH, launchFeeWei: LAUNCH_FEE, maxFeePerGas: fee })).toBeNull();
    expect(creatorFundingWarning(CREATOR_FUNDING_DEFAULTS, { funderTargetWei: 2_600_000_000_000_000n, launchFeeWei: LAUNCH_FEE, maxFeePerGas: fee })).not.toBeNull();
  });
});

describe("fundCreator rounding", () => {
  function adapter(balance: bigint, funding?: { fundStepWei: bigint; creatorGasReserveWei: bigint }) {
    const sent: bigint[] = [];
    const fees = { maxFeePerGas: 200_000_000n }; // pool fee cache, 0.2 gwei
    const chain = { balance };
    const ex = {
      fees,
      balance: async () => chain.balance,
      transfer: async (_from: LocalAccount, _to: Address, value: bigint) => {
        sent.push(value);
        chain.balance += value;
        return { hash: "0x01", networkFee: 0n };
      },
    } as unknown as EvmExecutor;
    const a = new PonsAdapter({ executor: ex, keyring: {} as EvmKeyring, funders: { pick: async () => ({}) as LocalAccount }, ...funding });
    const fund = (txValue: bigint) => (a as unknown as { fundCreator(c: Address, v: bigint): Promise<{ value: bigint } | null> }).fundCreator("0x0000000000000000000000000000000000000001", txValue);
    return { fund, sent, fees, chain };
  }

  const L1F = { fundStepWei: 500_000_000_000_000n, creatorGasReserveWei: 1_800_000_000_000_000n };

  it("L1 step 0.0005: launchFee 0.0005 + first buy 0.0001 + reserve 0.0018 -> 0.0025", async () => {
    const { fund, sent } = adapter(0n, L1F);
    expect((await fund(LAUNCH_FEE + 100_000_000_000_000n))?.value).toBe(2_500_000_000_000_000n);
    expect(sent).toEqual([2_500_000_000_000_000n]);
  });

  it("a fee cap rise after start-up tops the creator up on retry instead of a stuck create", async () => {
    const tx = LAUNCH_FEE + 100_000_000_000_000n; // 0.0006
    const { fund, sent, fees, chain } = adapter(0n, L1F);
    expect((await fund(tx))?.value).toBe(2_500_000_000_000_000n);
    // the create is rejected after the cache rose to 0.4 gwei: 0.0006 + 5.5M x 0.4 gwei = 0.0028 > 0.0025
    fees.maxFeePerGas = 400_000_000n;
    // retry on the same creator: need 0.0006 + 6.0M x 0.4 gwei = 0.003 -> one more step of 0.0005
    expect((await fund(tx))?.value).toBe(500_000_000_000_000n);
    expect(chain.balance).toBe(3_000_000_000_000_000n);
    expect(chain.balance >= tx + 5_500_000n * fees.maxFeePerGas).toBe(true);
    expect(sent.every((v) => v % L1F.fundStepWei === 0n)).toBe(true);
    // the configured reserve still wins while it is higher than the fee-cap gas
    fees.maxFeePerGas = 200_000_000n;
    expect(await fund(tx)).toBeNull();
  });

  it("defaults unchanged: same create -> 0.01 ETH", async () => {
    const { fund } = adapter(0n);
    expect((await fund(LAUNCH_FEE + 100_000_000_000_000n))?.value).toBe(10n * mETH);
  });

  it("round multiples of the step only; skipped when the creator holds enough", async () => {
    const step = 500_000_000_000_000n;
    const { fund } = adapter(123_456_789n, L1F);
    const v = (await fund(LAUNCH_FEE + 7_777_777n))!.value;
    expect(v % step).toBe(0n);
    expect(await adapter(ETH, L1F).fund(LAUNCH_FEE)).toBeNull();
  });
});
