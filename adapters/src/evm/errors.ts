import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  RpcRequestError,
  TimeoutError,
  decodeErrorResult,
  type Abi,
  type Hex,
} from "viem";
import { AdapterError, type AdapterErrorCode } from "../errors";

/**
 * Solidity custom error name -> adapter code (-> API ErrorCode via AdapterError.apiCode).
 * Names come from the verified Pons V2 sources (curve, factory, LaunchAndBuy,
 * PonsV2BondingCurveMath, OpenZeppelin).
 */
export const PONS_ERROR_BY_NAME: Readonly<Record<string, AdapterErrorCode>> = {
  // curve
  SlippageExceeded: "slippage",
  CurveGraduated: "graduated",
  AlreadyGraduated: "graduated",
  NotInitialized: "not_found",
  ZeroAmount: "bad_request",
  ZeroAddress: "bad_request",
  NativeValueMismatch: "bad_request",
  UnexpectedNativeValue: "bad_request",
  InsufficientInputAmount: "bad_request",
  InsufficientOutputAmount: "slippage", // amount too small to buy a single base unit
  InsufficientLiquidity: "graduated",
  // token / SafeERC20
  ERC20InsufficientBalance: "insufficient_tokens",
  ERC20InsufficientAllowance: "internal", // adapter approves first: a bug if seen
  // factory / LaunchAndBuy
  TokenNotFound: "not_found",
  NotWhitelisted: "venue_unavailable", // launches closed by the Pons owner
  NotApprovedLauncher: "venue_unavailable",
  LaunchConfigDisabled: "venue_unavailable",
  InvalidLaunchConfigId: "venue_unavailable",
  LaunchEconomicsMismatch: "venue_unavailable", // owner changed terms under us: re-preview
  LaunchFeeNotPaid: "venue_unavailable", // launch fee changed between read and send
  CreatorTaxTooHigh: "bad_request",
  InvalidTokenParams: "bad_request",
  ExemptionListTooLong: "bad_request",
  WrongGraduationPhase: "graduated",
  // Uniswap v4 / Universal Router / Permit2 (graduated tokens)
  V4TooLittleReceived: "slippage",
  V4TooMuchRequested: "slippage",
  V4TooLittleReceivedPerHopSingle: "slippage",
  DeadlinePassed: "venue_unavailable",
  TransactionDeadlinePassed: "venue_unavailable",
  AllowanceExpired: "internal",
  InsufficientAllowance: "internal",
  // FeeEscrow
  NoBalance: "not_found",
  // MemeHook
  UnknownPool: "not_found",
  NotFeeSweepOperator: "bad_request",
  InternalSwapRequiresOperator: "bad_request",
};

export function revertName(err: unknown, abi?: Abi): { name: string; args?: readonly unknown[] } | null {
  if (!(err instanceof BaseError)) return null;
  const rev = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (rev?.data?.errorName) return { name: rev.data.errorName, ...(rev.data.args ? { args: rev.data.args } : {}) };
  // Raw revert data (eth_estimateGas / eth_call without an ABI): decode ourselves.
  if (abi) {
    const raw = err.walk((e) => typeof (e as { data?: unknown }).data === "string" && /^0x[0-9a-f]{8}/i.test((e as { data: string }).data)) as
      | { data: Hex }
      | null;
    const name = raw ? decodeRevert(abi, raw.data) : null;
    if (name) return { name };
  }
  return null;
}

/** Decodes raw revert data against an ABI (receipts of failed txs, raw eth_call errors). */
export function decodeRevert(abi: Abi, data: Hex): string | null {
  try {
    return decodeErrorResult({ abi, data }).errorName;
  } catch {
    return null;
  }
}

/**
 * Turns whatever viem / the RPC threw into an AdapterError.
 * @param stage "build"/"preflight" = never broadcast; "confirm" = maybe broadcast.
 */
export function classifyEvmError(
  err: unknown,
  stage?: "build" | "preflight" | "confirm",
  hash?: string,
  abi?: Abi,
  byName: Readonly<Record<string, AdapterErrorCode>> = PONS_ERROR_BY_NAME,
): AdapterError {
  if (err instanceof AdapterError) return err;
  const extra = { cause: err, ...(stage ? { stage } : {}), ...(hash ? { signature: hash } : {}) };
  const rev = revertName(err, abi);
  if (rev) {
    const code = byName[rev.name] ?? "internal";
    return new AdapterError(code, `pons revert ${rev.name}`, { ...extra, programError: { code: 0, name: rev.name } });
  }
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof BaseError && err.walk((e) => e instanceof InsufficientFundsError)) {
    return new AdapterError("insufficient_sol", "EVM vault does not have enough ETH", extra);
  }
  if (/insufficient funds/i.test(message)) {
    return new AdapterError("insufficient_sol", "EVM vault does not have enough ETH", extra);
  }
  if (
    (err instanceof BaseError && err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof RpcRequestError)) ||
    /fetch failed|ECONNRESET|ETIMEDOUT|timed out|429|403|502|503|rate limit|nonce too low|already known|max fee per gas less than block base fee/i.test(message)
  ) {
    return new AdapterError("venue_unavailable", `RPC/sequencer failure: ${firstLine(message)}`, extra);
  }
  return new AdapterError("internal", firstLine(message), extra);
}

function firstLine(s: string): string {
  return s.split("\n", 1)[0] ?? s;
}
