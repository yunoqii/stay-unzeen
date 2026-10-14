import { getAddress, hexToBigInt, isHex, type Address, type Hex } from "viem";
import { AdapterError } from "../errors";

/**
 * LI.FI (li.quest) as a FALLBACK route on Robinhood Chain (same-chain swaps),
 * used only when the graduated token's own Uniswap v4 pool cannot be used.
 *
 * Privacy: LI.FI receives exactly one address, the vault (`fromAddress`; the
 * recipient defaults to it). No integrator tag, no API key, no user data. The
 * request is made from the server, never from a browser.
 *
 * Safety: the calldata comes from a third party, so it is accepted only if
 *   - `transactionRequest.to` and the approval spender are the LI.FI Diamond
 *     pinned below (cross-checked against GET /v1/chains, 2026-10-13);
 *   - chainId is 4663, value equals the input for an ETH sale-in and 0 otherwise;
 *   - from / to address are the vault, tokens are the requested ones;
 *   - `toAmountMin` >= the caller's minimum.
 * The approval is for the EXACT amount (never unlimited), and the executor
 * still simulates (eth_estimateGas) before signing.
 */
export const LIFI_DIAMOND_4663: Address = getAddress("0xb477751b76cf82d00a686a1232f5fcd772414af3");
export const LIFI_API = "https://li.quest/v1";
const NATIVE: Address = "0x0000000000000000000000000000000000000000";

export interface LifiQuoteRequest {
  fromToken: Address;
  toToken: Address;
  fromAmount: bigint;
  vault: Address;
  /** Hard minimum the route must guarantee (the user's minOut). */
  minOut: bigint;
  /** Requested slippage for LI.FI's own bound, default 0.5 %. */
  slippage?: number;
}

export interface LifiRoute {
  tool: string;
  to: Address;
  data: Hex;
  value: bigint;
  approvalAddress: Address;
  toAmount: bigint;
  toAmountMin: bigint;
}

export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class LifiClient {
  constructor(
    private readonly fetchFn: Fetch = fetch as unknown as Fetch,
    private readonly chainId = 4663,
    private readonly diamond: Address = LIFI_DIAMOND_4663,
    private readonly timeoutMs = 10_000,
  ) {}

  async quote(r: LifiQuoteRequest): Promise<LifiRoute> {
    const q = new URLSearchParams({
      fromChain: String(this.chainId),
      toChain: String(this.chainId),
      fromToken: r.fromToken,
      toToken: r.toToken,
      fromAmount: r.fromAmount.toString(),
      fromAddress: r.vault,
      slippage: String(r.slippage ?? 0.005),
    });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    let body: unknown;
    try {
      const res = await this.fetchFn(`${LIFI_API}/quote?${q}`, { signal: ctl.signal });
      body = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = (body as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
        throw new AdapterError(res.status === 404 ? "graduated" : "venue_unavailable", `LI.FI: ${msg}`);
      }
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      throw new AdapterError("venue_unavailable", "LI.FI unreachable", { cause: e });
    } finally {
      clearTimeout(t);
    }
    return this.validate(body, r);
  }

  /** Rejects anything but a same-chain route through the pinned Diamond for exactly this request. */
  validate(body: unknown, r: LifiQuoteRequest): LifiRoute {
    const bad = (why: string) => new AdapterError("internal", `LI.FI route rejected: ${why}`); // final, never retried
    const j = body as {
      tool?: string;
      action?: { fromToken?: { address?: string }; toToken?: { address?: string }; fromAddress?: string; toAddress?: string; fromAmount?: string };
      estimate?: { approvalAddress?: string; toAmount?: string; toAmountMin?: string };
      transactionRequest?: { to?: string; data?: string; value?: string; chainId?: number };
    } | null;
    const tx = j?.transactionRequest;
    if (!j || !tx || !j.action || !j.estimate) throw bad("malformed response");
    const eq = (a: string | undefined, b: Address) => {
      try {
        return a !== undefined && getAddress(a) === getAddress(b);
      } catch {
        return false;
      }
    };
    if (tx.chainId !== this.chainId) throw bad("chain");
    if (!eq(tx.to, this.diamond)) throw bad("unexpected target contract");
    if (!eq(j.estimate.approvalAddress, this.diamond)) throw bad("unexpected spender");
    if (!eq(j.action.fromAddress, r.vault) || !(j.action.toAddress === undefined || eq(j.action.toAddress, r.vault))) throw bad("addresses");
    if (!eq(j.action.fromToken?.address, r.fromToken) || !eq(j.action.toToken?.address, r.toToken)) throw bad("tokens");
    if (j.action.fromAmount !== r.fromAmount.toString()) throw bad("amount");
    if (typeof tx.data !== "string" || !isHex(tx.data) || tx.data.length < 10) throw bad("calldata");
    const value = tx.value && isHex(tx.value) ? hexToBigInt(tx.value) : BigInt(tx.value ?? 0);
    const expectValue = getAddress(r.fromToken) === NATIVE ? r.fromAmount : 0n;
    if (value !== expectValue) throw bad("value");
    const toAmount = BigInt(j.estimate.toAmount ?? "0");
    const toAmountMin = BigInt(j.estimate.toAmountMin ?? "0");
    if (toAmountMin < r.minOut) throw new AdapterError("slippage", "LI.FI cannot guarantee the minimum");
    return { tool: j.tool ?? "?", to: this.diamond, data: tx.data as Hex, value, approvalAddress: this.diamond, toAmount, toAmountMin };
  }
}
