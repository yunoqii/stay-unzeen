/**
 * Adapter error codes. Each maps to an `ErrorCode` of docs/API.md through
 * `apiCode` so the relayer/API can answer without knowing venue internals.
 */
export type AdapterErrorCode =
  | "slippage" //            minOut / minLamports not reachable
  | "insufficient_sol" //    vault lacks SOL for the trade + fees/rent
  | "insufficient_tokens" // vault lacks tokens to sell
  | "graduated" //           curve complete / migrated: trade via AMM / Jupiter
  | "not_found" //           no bonding curve for this mint
  | "bad_request" //         invalid arguments
  | "venue_unavailable" //   RPC / program unavailable, tx not landed
  | "internal";

/** Subset of `ErrorCode` from docs/API.md (v0.2) that adapters/relayer produce. */
export type ApiErrorCode =
  | "bad_request"
  | "not_found"
  | "graduated"
  | "pool_liquidity"
  | "slippage"
  | "venue_unavailable"
  | "internal";

const API_CODE: Record<AdapterErrorCode, ApiErrorCode> = {
  slippage: "slippage",
  // Pool reserve problem, not the user's balance (API.md: never
  // insufficient_balance): the vault lacks SOL / tokens; operator tops up.
  insufficient_sol: "pool_liquidity",
  // The ledger already checked the user's holdings; a vault short of tokens is
  // a pool-side problem too.
  insufficient_tokens: "pool_liquidity",
  graduated: "graduated",
  not_found: "not_found",
  bad_request: "bad_request",
  venue_unavailable: "venue_unavailable",
  internal: "internal",
};

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly apiCode: ApiErrorCode;
  /** Program error number / name when the failure came from a program. */
  readonly programError?: { code: number; name?: string } | undefined;
  readonly signature?: string | undefined;
  /**
   * Send stage of a failed submission (see `SendFailure.stage` in tx.ts):
   * "build"/"preflight" = never broadcast; "confirm" = may have been broadcast,
   * check the signature before any retry. Undefined for pre-send checks.
   */
  readonly stage?: "build" | "preflight" | "confirm" | undefined;
  /** True when the transaction landed on chain with an error. */
  readonly landedErr?: boolean | undefined;

  constructor(
    code: AdapterErrorCode,
    message: string,
    extra: {
      programError?: { code: number; name?: string };
      signature?: string;
      cause?: unknown;
      stage?: "build" | "preflight" | "confirm";
      landedErr?: boolean;
    } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = "AdapterError";
    this.code = code;
    this.apiCode = API_CODE[code];
    this.programError = extra.programError;
    this.signature = extra.signature;
    this.stage = extra.stage;
    this.landedErr = extra.landedErr;
  }
}

export function toApiCode(code: AdapterErrorCode): ApiErrorCode {
  return API_CODE[code];
}

/** pump program error names -> adapter code. Numbers come from the SDK IDL. */
const PUMP_ERROR_BY_NAME: Record<string, AdapterErrorCode> = {
  TooMuchSolRequired: "slippage",
  TooLittleSolReceived: "slippage",
  BuySlippageBelowMinTokensOut: "slippage",
  BondingCurveComplete: "graduated",
  BondingCurveNotComplete: "bad_request",
  NotEnoughTokensToBuy: "slippage",
  NotEnoughTokensToSell: "insufficient_tokens",
  BuyZeroAmount: "bad_request",
  SellZeroAmount: "bad_request",
};

export interface ProgramErrorInfo {
  code: number;
  name?: string;
}

/**
 * Turns whatever web3.js / the RPC threw (SendTransactionError, simulation
 * logs, InstructionError) into an AdapterError.
 *
 * @param pumpErrors IDL errors (`{code,name}[]`) of the pump program.
 * @param pumpProgramId base58 id, used to attribute `custom program error`.
 */
export function classifyError(
  err: unknown,
  logs: readonly string[] | null | undefined,
  pumpErrors: readonly ProgramErrorInfo[],
  pumpProgramId: string,
): AdapterError {
  if (err instanceof AdapterError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const allLogs = [...(logs ?? []), ...extractLogs(err)];
  const text = `${message}\n${allLogs.join("\n")}`;

  // 1. Not enough SOL: system program transfer / rent / fee payer.
  if (
    /insufficient lamports/i.test(text) ||
    /Attempt to debit an account but found no record of a prior credit/i.test(text) ||
    /InsufficientFundsForRent|insufficient funds for rent/i.test(text) ||
    /InsufficientFundsForFee|insufficient funds for fee/i.test(text)
  ) {
    return new AdapterError("insufficient_sol", "vault does not have enough SOL", { cause: err });
  }

  // 2. Program error raised by pump (Anchor log "Error Number: N").
  const pe = findPumpProgramError(text, allLogs, pumpErrors, pumpProgramId);
  if (pe) {
    const code = (pe.name && PUMP_ERROR_BY_NAME[pe.name]) || "internal";
    return new AdapterError(code, `pump program error ${pe.code}${pe.name ? ` ${pe.name}` : ""}`, {
      programError: pe,
      cause: err,
    });
  }

  // 3. Token program: not enough tokens in the vault ATA.
  if (/Error: insufficient funds/i.test(text) || /custom program error: 0x1\b/.test(text)) {
    return new AdapterError("insufficient_tokens", "vault does not hold enough tokens", { cause: err });
  }

  // 4. Network / RPC.
  if (
    /block height exceeded|blockhash not found|timed out|TransactionExpired|fetch failed|ECONNRESET|ETIMEDOUT|429|503|502/i.test(
      text,
    )
  ) {
    return new AdapterError("venue_unavailable", `RPC/landing failure: ${firstLine(message)}`, { cause: err });
  }

  return new AdapterError("internal", firstLine(message), { cause: err });
}

function findPumpProgramError(
  text: string,
  logs: readonly string[],
  pumpErrors: readonly ProgramErrorInfo[],
  pumpProgramId: string,
): ProgramErrorInfo | null {
  // Anchor: "Program log: AnchorError ... Error Code: TooMuchSolRequired. Error Number: 6002."
  const anchor = /Error Code: (\w+)\. Error Number: (\d+)/.exec(text);
  if (anchor && anchor[1] && anchor[2]) {
    return { code: Number(anchor[2]), name: anchor[1] };
  }
  // "Program <id> failed: custom program error: 0x1772"
  for (const line of logs) {
    const m = /^Program (\w+) failed: custom program error: 0x([0-9a-f]+)/i.exec(line);
    if (m && m[1] === pumpProgramId && m[2]) {
      return byCode(Number.parseInt(m[2], 16), pumpErrors);
    }
  }
  // InstructionError {"Custom": 6002} without logs: only trust codes in the
  // pump range (6000+); low codes belong to system/token programs.
  const custom = /"Custom":\s*(\d+)/.exec(text) ?? /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (custom && custom[1]) {
    const n = custom[0].includes("0x") ? Number.parseInt(custom[1], 16) : Number(custom[1]);
    if (n >= 6000) return byCode(n, pumpErrors);
  }
  return null;
}

function byCode(code: number, pumpErrors: readonly ProgramErrorInfo[]): ProgramErrorInfo {
  const hit = pumpErrors.find((e) => e.code === code);
  return hit?.name ? { code, name: hit.name } : { code };
}

function extractLogs(err: unknown): string[] {
  if (err && typeof err === "object") {
    const anyErr = err as { logs?: unknown; transactionLogs?: unknown };
    for (const cand of [anyErr.logs, anyErr.transactionLogs]) {
      if (Array.isArray(cand)) return cand.filter((l): l is string => typeof l === "string");
    }
  }
  return [];
}

function firstLine(s: string): string {
  return s.split("\n", 1)[0] ?? s;
}
