import { ceilToStep, quantizeGasLimit } from "../fees";
import { weiEnv } from "../funders";

/**
 * Funder -> creator funding of a Pons create (PonsAdapter.fundCreator):
 * the creator receives `ceilToStep(launchFee + initialBuy + gasReserve - balance, fundStep)`.
 * Both knobs are pool-wide env values (one step for every create: the amount is
 * round and never tailored to a single launch, so it is no fingerprint).
 */

export const CREATOR_FUNDING_DEFAULTS = {
  /** HOOD_CREATOR_FUND_STEP_WEI: 0.01 ETH. */
  fundStepWei: 10_000_000_000_000_000n,
  /** HOOD_CREATOR_GAS_RESERVE_WEI: 0.002 ETH (launch tx + later fee claims). */
  gasReserveWei: 2_000_000_000_000_000n,
} as const;

/**
 * Gas limit budgeted for the creator's `launchAndBuy` tx. Arbitrum (like geth)
 * rejects a tx unless the sender holds `gasLimit x maxFeePerGas + value` upfront.
 * Real create+buy: 4.56M gas used (tx 0x70c5...0738, docs/analysis/robinhood-chain.md),
 * L1 calldata component included. The executor signs with
 * quantizeGasLimit(estimate) = ceil(estimate x 1.2) to 100k = 5.5M; 5.6M adds one
 * 100k bucket for estimate drift (longer metadata, L1 price moves).
 */
export const PONS_CREATE_GAS_LIMIT = 5_600_000n;

export interface CreatorFunding {
  fundStepWei: bigint;
  gasReserveWei: bigint;
}

/** HOOD_CREATOR_FUND_STEP_WEI / HOOD_CREATOR_GAS_RESERVE_WEI (decimal wei, > 0); unset / empty = defaults. */
export function creatorFundingFromEnv(env: NodeJS.ProcessEnv = process.env): CreatorFunding {
  return {
    fundStepWei: weiEnv(env, "HOOD_CREATOR_FUND_STEP_WEI", CREATOR_FUNDING_DEFAULTS.fundStepWei),
    gasReserveWei: weiEnv(env, "HOOD_CREATOR_GAS_RESERVE_WEI", CREATOR_FUNDING_DEFAULTS.gasReserveWei),
  };
}

/** Upfront gas of one create at `maxFeePerGas`. */
export function creatorCreateGasWei(maxFeePerGas: bigint): bigint {
  return PONS_CREATE_GAS_LIMIT * maxFeePerGas;
}

/** Start-up refusal: a creator funded with this reserve could not even pay the upfront gas of its create. */
export function assertCreatorGasReserve(f: CreatorFunding, maxFeePerGas: bigint): void {
  const need = creatorCreateGasWei(maxFeePerGas);
  if (f.gasReserveWei < need) {
    throw new Error(
      `HOOD_CREATOR_GAS_RESERVE_WEI=${f.gasReserveWei} is below the upfront gas of one create ` +
        `(${PONS_CREATE_GAS_LIMIT} gas x maxFeePerGas ${maxFeePerGas} = ${need} wei): ` +
        `every launch would be rejected with "insufficient funds for gas * price + value"`,
    );
  }
}

/**
 * Smallest funder -> creator top-up of a create from an empty creator with a
 * non-zero first buy below one step, plus the funder's own transfer gas.
 */
export function funderNeedForOneCreate(f: CreatorFunding, launchFeeWei: bigint, maxFeePerGas: bigint): bigint {
  return ceilToStep(launchFeeWei + f.gasReserveWei + 1n, f.fundStepWei) + quantizeGasLimit(21_000n) * maxFeePerGas;
}

/** Start-up warning (not an error) when a funder at its target cannot pay for a single create; null when fine. */
export function creatorFundingWarning(
  f: CreatorFunding,
  o: { funderTargetWei: bigint; launchFeeWei: bigint; maxFeePerGas: bigint },
): string | null {
  const need = funderNeedForOneCreate(f, o.launchFeeWei, o.maxFeePerGas);
  if (o.funderTargetWei >= need) return null;
  return (
    `HOOD_FUNDER_TARGET_WEI=${o.funderTargetWei} does not cover one create ` +
    `(top-up ceil(launchFee ${o.launchFeeWei} + reserve ${f.gasReserveWei} + first buy, step ${f.fundStepWei}) + transfer gas = ${need} wei): ` +
    `creates will fail with "no funder can cover this launch"`
  );
}
