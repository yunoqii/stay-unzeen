// Uniform error handling for docs/API.md "Ошибки": every non-2xx is { error: { code, message, details? } }.
// `message` is for developers; the UI text always comes from `code`.

import type { ApiErrorBody, ErrorCode } from "./types";

const CODES: readonly ErrorCode[] = [
  "bad_request",
  "unauthorized",
  "not_found",
  "replay",
  "insufficient_balance",
  "below_minimum",
  "balance_frozen",
  "graduated",
  "pool_liquidity",
  "slippage",
  "rate_limited",
  "venue_unavailable",
  "feature_disabled",
  "creator_locked",
  "creator_cap",
  "internal",
];

/** Client-side codes for failures that never reached a well-formed API response. */
export type ClientErrorCode = "network" | "locked";

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode | ClientErrorCode,
    /** Developer message from the server, never shown as-is. */
    message: string,
    public readonly status: number = 0,
    public readonly details?: unknown,
    /** Seconds, from Retry-After on 429. */
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const STATUS_FALLBACK: Record<number, ErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  404: "not_found",
  409: "replay",
  422: "bad_request",
  423: "balance_frozen",
  429: "rate_limited",
  503: "venue_unavailable",
};

export function isApiErrorBody(x: unknown): x is ApiErrorBody {
  if (!x || typeof x !== "object" || !("error" in x)) return false;
  const e = (x as { error: unknown }).error;
  return !!e && typeof e === "object" && typeof (e as { code: unknown }).code === "string";
}

/** Build an ApiError from a non-2xx response. Unknown or missing codes fall back by status. */
export async function errorFromResponse(res: Response, label: string): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const retry = res.headers.get("retry-after");
  const retryAfter = retry && /^\d+$/.test(retry) ? Number(retry) : undefined;
  if (isApiErrorBody(body)) {
    const code = (CODES as readonly string[]).includes(body.error.code)
      ? body.error.code
      : (STATUS_FALLBACK[res.status] ?? "internal");
    return new ApiError(code, `${label}: ${body.error.message}`, res.status, body.error.details, retryAfter);
  }
  return new ApiError(STATUS_FALLBACK[res.status] ?? "internal", `${label} → ${res.status}`, res.status, undefined, retryAfter);
}

const UI_TEXT: Record<ErrorCode | ClientErrorCode, string> = {
  bad_request: "Something in this request is off. Check the values and try again.",
  unauthorized: "Your anon key could not be verified. Check your device clock and try again.",
  not_found: "Not found. Unzeen does not track this yet.",
  replay: "This request was already sent. Try again.",
  insufficient_balance: "Not enough ZEC on your balance. Top up and try again.",
  below_minimum: "This amount is below the pool minimum. Try a larger amount.",
  balance_frozen: "Your balance is on hold while a deposit is reviewed. Nothing is lost; try again later.",
  graduated: "This token left the bonding curve. Trade it through another venue.",
  pool_liquidity: "The pool is short on liquidity right now. Your balance is untouched. Try again shortly.",
  slippage: "Price moved past your limit. Adjust slippage and try again.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  venue_unavailable: "The launchpad is not responding right now. Try again shortly.",
  feature_disabled: "This isn't switched on yet.",
  creator_locked: "Your launch buy is locked for now. The lock ends 24 hours after launch; tokens you bought later are free to move.",
  creator_cap: "As the creator you can hold at most 5% of supply through the pool. Try a smaller amount.",
  internal: "Something went wrong on our side. Try again.",
  network: "Can't reach Unzeen. Check your connection.",
  locked: "Unlock your anon key to continue.",
};

/** User-facing English text for any thrown value. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "rate_limited" && e.retryAfter) return `Too many requests. Try again in ${e.retryAfter}s.`;
    return UI_TEXT[e.code];
  }
  return UI_TEXT.internal;
}
