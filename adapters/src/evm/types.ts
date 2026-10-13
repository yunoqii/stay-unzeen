import type { Address, Hex, LocalAccount } from "viem";
import type { CurveStatus } from "../types";

/**
 * EVM counterpart of src/types.ts (`LaunchpadAdapter`, `TxResult`, `Quote`).
 * Same five operations; amounts are chain-neutral (`quoteAmount` in wei, not
 * lamports) and 18-decimal token amounts need > u64, so everything stays
 * bigint (core: NUMERIC(78,0) / u128, strings in the API).
 *
 * Kept separate from the Solana `VenueId`/`TxResult` until core publishes the
 * venue `pons` / network `hood` contract; the relayer maps these 1:1 then.
 */

export type EvmVenueId = "pons";
export type EvmNetworkId = "hood";

export interface EvmTokenMeta {
  name: string;
  symbol: string;
  /** Image URL stored ON CHAIN by Pons (`logo`). Upload server-side, never from the user's browser. */
  logo?: string;
  description?: string;
  socials?: Partial<{ twitter: string; telegram: string; discord: string; website: string; farcaster: string }>;
}

/** A side transaction the operation needed (funding, approve): booked as pool cost. */
export interface EvmSideTx {
  kind: "fund" | "approve";
  hash: Hex;
  networkFee: bigint;
  /** fund: ETH moved funder -> creator. */
  value?: bigint;
}

export interface EvmTxResult {
  venue: EvmVenueId;
  network: EvmNetworkId;
  chainId: number;
  kind: "create" | "buy" | "sell";
  hash: Hex;
  blockNumber: bigint;
  /** Block time, unix seconds. */
  blockTime: number | null;
  /** Token contract (the "mint"), checksummed. */
  token: Address;
  /** Bonding curve of the token. */
  curve: Address;
  /** Vault that holds the position (one vault per token). */
  vault: Address;
  /** Token base units received (buy/create) or sent (sell). */
  tokenAmount: bigint;
  /** Wei of the trade itself, venue fees and snipe tax included: spent on buy/create, received on sell. */
  quoteAmount: bigint;
  /** Venue fee (+ snipe tax) and creator tax inside `quoteAmount`, from the curve event. */
  venueFee: bigint;
  creatorTax: bigint;
  /** Snipe tax actually charged (should be 0: the adapter waits out the window). */
  snipeTax: bigint;
  /** Wei refunded on a clamped final buy (already excluded from quoteAmount). */
  refund: bigint;
  /** Network fee of the main tx, wei (gasUsed x effectiveGasPrice). */
  networkFee: bigint;
  /** Funding / approve transactions done for this operation. */
  sideTxs: EvmSideTx[];
  decimals: number;
  /** Where it traded: the Pons curve, or the graduated Uniswap v4 pool. */
  route: "curve" | "uniswap-v4" | "lifi";
  /**
   * uniswap-v4 buys: the hook skims its fee + creator tax from the OUTPUT, so
   * `venueFee` / `creatorTax` are TOKEN base units (else wei).
   */
  feeInToken?: boolean;
  /** Amounts come from on-chain events (curve events, v4 Swap / hook skim / ERC-20 Transfer). */
  /** False only for a LI.FI fallback whose completion event was not found: re-read the receipt before crediting. */
  amountsKnown: boolean;
  fromEvent: boolean;
  /** create only: Pons launch fee paid by the creator (wei), on top of `quoteAmount`. */
  launchFee?: bigint;
  /** create only: fresh creator address (deployer + creatorFeeRecipient) and its HD index. */
  creator?: Address;
  creatorIndex?: number;
}

export interface EvmQuote {
  venue: EvmVenueId;
  token: Address;
  side: "buy" | "sell";
  /** buy: wei in; sell: token base units in. */
  amountIn: bigint;
  /** buy: tokens out; sell: wei out. Fees included. */
  amountOut: bigint;
  /** buy only: wei actually spent (< amountIn when clamped at graduation) and refund. */
  spent?: bigint;
  refund?: bigint;
  /** Snipe tax the buy recipient (default: the default vault) pays at this block (bps). */
  snipeTaxBps: bigint;
  /** Spot ETH per 1 whole token before the trade (decimal string). */
  priceEth: string;
  marketCapEth: string;
  status: CurveStatus;
  decimals: number;
  route: "curve" | "uniswap-v4" | "lifi";
  /** Block the state was read at. */
  blockNumber: bigint;
}

export interface EvmTradeOptions {
  /** Vault account (one vault per token); default the adapter's default vault. */
  vault?: LocalAccount;
  /**
   * buy: what to do inside the snipe-tax window (first `snipeTaxSeconds` after a
   * launch, up to 99%): "wait" (default) until it is 0, "fail" -> venue_unavailable.
   */
  snipeTax?: "wait" | "fail";
  /**
   * Graduated token whose v4 pool is not seeded yet (phase Swept): call the
   * permissionless `createGraduatedPool` first (vault pays gas). Default false
   * -> venue_unavailable "graduation in progress".
   */
  seedPool?: boolean;
  /** buy/create: approve the curve right after the buy (not right before a sell). Default true. */
  approveAfterBuy?: boolean;
}

export interface EvmCreateOptions extends EvmTradeOptions {
  /** Creator HD index reserved earlier (retry). Default: allocate a new one. */
  creatorIndex?: number;
  /** Creator tax, bps (0..maxCreatorTaxBps). Default 0. */
  creatorTaxBps?: number;
  /** Slippage on the first buy. It is priced exactly (same tx), default 0. */
  slippageBps?: number;
}

/** docs/ARCHITECTURE.md "Адаптер" for EVM launchpads. */
export interface EvmLaunchpadAdapter {
  id: EvmVenueId;
  create(meta: EvmTokenMeta, initialBuyWei: bigint, opts?: EvmCreateOptions): Promise<EvmTxResult>;
  buy(token: Address, weiIn: bigint, minOut: bigint, opts?: EvmTradeOptions): Promise<EvmTxResult>;
  sell(token: Address, amount: bigint, minWei: bigint, opts?: EvmTradeOptions): Promise<EvmTxResult>;
  quote(token: Address, side: "buy" | "sell", amount: bigint, opts?: { recipient?: Address }): Promise<EvmQuote>;
  status(token: Address): Promise<CurveStatus>;
}
