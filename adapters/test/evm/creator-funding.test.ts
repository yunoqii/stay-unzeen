import { describe, expect, it } from "vitest";
import type { Address, LocalAccount } from "viem";
import type { HoodConfig } from "../../src/evm/chain";
import type { EvmExecutor } from "../../src/evm/executor";
import type { EvmKeyring } from "../../src/evm/keys";
import { PonsAdapter } from "../../src/evm/pons/adapter";
import {
  CREATOR_FUNDING_DEFAULTS,
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
/** docs/submission/mainnet-demo-run-lite.md §3.2, variant L1. */
const L1 = { HOOD_CREATOR_FUND_STEP_WEI: "500000000000000", HOOD_CREATOR_GAS_RESERVE_WEI: "1500000000000000" };

describe("creator funding env", () => {
  it("defaults when unset or empty (0.01 ETH step, 0.002 ETH reserve)", () => {
    const d = { fundStepWei: 10_000_000_000_000_000n, gasReserveWei: 2_000_000_000_000_000n };
    expect(CREATOR_FUNDING_DEFAULTS).toEqual(d);
    expect(creatorFundingFromEnv({})).toEqual(d);
    expect(creatorFundingFromEnv({ HOOD_CREATOR_FUND_STEP_WEI: "", HOOD_CREATOR_GAS_RESERVE_WEI: "  " })).toEqual(d);
  });

  it("reads decimal wei", () => {
    expect(creatorFundingFromEnv(L1)).toEqual({ fundStepWei: 500_000_000_000_000n, gasReserveWei: 1_500_000_000_000_000n });
    // beyond 2^53: exact BigInt, no float rounding
    expect(creatorFundingFromEnv({ HOOD_CREATOR_FUND_STEP_WEI: "123456789012345678901" }).fundStepWei).toBe(123456789012345678901n);
  });

  it("rejects non-integer and <= 0", () => {
    for (const name of ["HOOD_CREATOR_FUND_STEP_WEI", "HOOD_CREATOR_GAS_RESERVE_WEI"]) {
      for (const bad of ["0.01", "1e15", "-5", "0x10", "abc", "1_000"]) {
        expect(() => creatorFundingFromEnv({ [name]: bad }), `${name}=${bad}`).toThrow(new RegExp(`${name} must be an integer in wei`));
      }
      expect(() => creatorFundingFromEnv({ [name]: "0" })).toThrow(new RegExp(`${name} must be > 0`));
    }
  });
});

describe("creator gas reserve refusal", () => {
  it("5.6M covers the executor's gas limit for the measured 4.56M create (+1 bucket)", () => {
    expect(quantizeGasLimit(4_560_000n)).toBe(5_500_000n);
    expect(quantizeGasLimit(4_666_000n)).toBe(PONS_CREATE_GAS_LIMIT);
  });

  it("accepts reserve >= 5.6M x maxFee, refuses below", () => {
    const fee = 200_000_000n; // 0.2 gwei default HOOD_MAX_FEE_WEI
    const need = 5_600_000n * fee; // 0.00112 ETH
    expect(() => assertCreatorGasReserve({ fundStepWei: mETH, gasReserveWei: need }, fee)).not.toThrow();
    expect(() => assertCreatorGasReserve(CREATOR_FUNDING_DEFAULTS, fee)).not.toThrow();
    expect(() => assertCreatorGasReserve(creatorFundingFromEnv(L1), fee)).not.toThrow();
    expect(() => assertCreatorGasReserve({ fundStepWei: mETH, gasReserveWei: need - 1n }, fee)).toThrow(/HOOD_CREATOR_GAS_RESERVE_WEI=1119999999999999 is below/);
    // the default reserve fails once the fee cap passes ~0.357 gwei
    expect(() => assertCreatorGasReserve(CREATOR_FUNDING_DEFAULTS, 4n * GWEI / 10n)).toThrow(/insufficient funds/);
  });

  function exec(maxFee: bigint): EvmExecutor {
    return { fees: { maxFeePerGas: maxFee } } as unknown as EvmExecutor;
  }
  const cfg = (maxFeeFloorWei: bigint) => ({ chainId: 4663, maxFeeFloorWei }) as HoodConfig;
  const kr = {} as EvmKeyring;
  const funders = { pick: async () => ({}) as LocalAccount } as never;

  it("hoodPonsAdapter refuses at start against max(floor, fee cache)", () => {
    const low = { fundStepWei: mETH, gasReserveWei: 1_000_000_000_000_000n }; // 0.001 < 0.00112
    expect(() => hoodPonsAdapter(cfg(200_000_000n), exec(100_000_000n), kr, funders, undefined, low)).toThrow(/below the upfront gas/);
    // floor ok, but the live cache already rose above it
    const l1 = creatorFundingFromEnv(L1);
    expect(hoodPonsAdapter(cfg(200_000_000n), exec(200_000_000n), kr, funders, undefined, l1)).toBeInstanceOf(PonsAdapter);
    expect(() => hoodPonsAdapter(cfg(200_000_000n), exec(300_000_000n), kr, funders, undefined, l1)).toThrow(/below the upfront gas/);
    // not the Pons chain: null, no check
    expect(hoodPonsAdapter({ ...cfg(200_000_000n), chainId: 46630 }, exec(GWEI), kr, funders, undefined, low)).toBeNull();
  });

  it("hoodPonsAdapter reads env by default", () => {
    const prev = process.env.HOOD_CREATOR_GAS_RESERVE_WEI;
    process.env.HOOD_CREATOR_GAS_RESERVE_WEI = "1000";
    try {
      expect(() => hoodPonsAdapter(cfg(200_000_000n), exec(200_000_000n), kr, funders)).toThrow(/RESERVE_WEI=1000 is below/);
    } finally {
      if (prev === undefined) delete process.env.HOOD_CREATOR_GAS_RESERVE_WEI;
      else process.env.HOOD_CREATOR_GAS_RESERVE_WEI = prev;
    }
  });
});

describe("funder target warning", () => {
  const fee = 200_000_000n;
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
    const ex = {
      balance: async () => balance,
      transfer: async (_from: LocalAccount, _to: Address, value: bigint) => {
        sent.push(value);
        return { hash: "0x01", networkFee: 0n };
      },
    } as unknown as EvmExecutor;
    const a = new PonsAdapter({ executor: ex, keyring: {} as EvmKeyring, funders: { pick: async () => ({}) as LocalAccount }, ...funding });
    const fund = (txValue: bigint) => (a as unknown as { fundCreator(c: Address, v: bigint): Promise<{ value: bigint } | null> }).fundCreator("0x0000000000000000000000000000000000000001", txValue);
    return { fund, sent };
  }

  it("L1 step 0.0005: launchFee 0.0005 + first buy 0.0001 + reserve 0.0015 -> 0.0025", async () => {
    const { fund, sent } = adapter(0n, { fundStepWei: 500_000_000_000_000n, creatorGasReserveWei: 1_500_000_000_000_000n });
    expect((await fund(LAUNCH_FEE + 100_000_000_000_000n))?.value).toBe(2_500_000_000_000_000n);
    expect(sent).toEqual([2_500_000_000_000_000n]);
  });

  it("defaults unchanged: same create -> 0.01 ETH", async () => {
    const { fund } = adapter(0n);
    expect((await fund(LAUNCH_FEE + 100_000_000_000_000n))?.value).toBe(10n * mETH);
  });

  it("round multiples of the step only; skipped when the creator holds enough", async () => {
    const step = 500_000_000_000_000n;
    const { fund } = adapter(123_456_789n, { fundStepWei: step, creatorGasReserveWei: 1_500_000_000_000_000n });
    const v = (await fund(LAUNCH_FEE + 7_777_777n))!.value;
    expect(v % step).toBe(0n);
    expect(await adapter(ETH, { fundStepWei: step, creatorGasReserveWei: 1_500_000_000_000_000n }).fund(LAUNCH_FEE)).toBeNull();
  });
});
