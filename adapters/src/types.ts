import type { Keypair, PublicKey, Signer } from "@solana/web3.js";

/** Venue ids, same strings as `Venue` in docs/API.md. */
export type VenueId = "pumpfun" | "meteora-dbc" | "jupiter";

export type CurveStatus = "curve" | "graduated";

export interface TokenMeta {
  name: string;
  symbol: string;
  /**
   * Metadata JSON URI. Upload it from the server (never from the user's
   * browser) so the user's IP is not tied to the mint.
   */
  uri: string;
}

/** Executed trade / create, amounts are what actually happened on chain. */
export interface TxResult {
  venue: VenueId;
  kind: "create" | "buy" | "sell";
  signature: string;
  slot: number;
  mint: string;
  /** Vault that signed and paid. */
  vault: string;
  /** Base units of the token moved (received on buy/create, sent on sell). */
  tokenAmount: bigint;
  /**
   * Lamports of the trade itself (fees of the venue included, network fee and
   * rent excluded): paid on buy/create, received on sell. 0 for a create
   * without first buy.
   */
  solAmount: bigint;
  /** Network fee of the transaction, lamports. */
  networkFee: bigint;
  /** Block time, unix seconds (null if unknown). */
  blockTime?: number | null;
  /**
   * False when the transaction landed but could not be read yet: then
   * `tokenAmount`/`solAmount`/`networkFee` are NOT the executed amounts and
   * must not be credited; re-read with `PumpFunAdapter.tradeResult`.
   */
  amountsKnown: boolean;
  /** True when the amounts come from the venue's on-chain trade event (else balance deltas). */
  fromEvent?: boolean;
  /** create only: creator address recorded on chain (fresh pool address). */
  creator?: string;
  /** create only: HD index the creator was derived from (to claim fees later). */
  creatorIndex?: number;
  decimals: number;
}

export interface Quote {
  venue: VenueId;
  mint: string;
  side: "buy" | "sell";
  /** buy: lamports in; sell: token base units in. */
  amountIn: bigint;
  /** buy: token base units out; sell: lamports out. Venue fees included. */
  amountOut: bigint;
  /** Spot price before the trade: SOL per 1 whole token, decimal string (UI). */
  priceSol: string;
  /** Market cap before the trade, decimal SOL string (UI). */
  marketCapSol: string;
  status: CurveStatus;
  decimals: number;
}

/**
 * Per-call options. Lets the relayer pick the vault shard for a trade;
 * defaults to the adapter's default vault.
 */
export interface TradeOptions {
  vault?: Signer;
}

export interface CreateOptions extends TradeOptions {
  /**
   * HD index of the fresh creator address. When omitted the adapter allocates
   * the next unused index. Never a vault, never a user wallet.
   */
  creatorIndex?: number;
  /**
   * Mint keypair fixed by the caller (fair launch: core's `mint_secret`, the
   * same on every attempt so a retry can never create a second mint). Default
   * a fresh one per call.
   */
  mintKeypair?: Keypair;
}

/** docs/ARCHITECTURE.md "Адаптер", with an optional trailing options arg. */
export interface LaunchpadAdapter {
  id: VenueId;
  create(meta: TokenMeta, initialBuyLamports: bigint, opts?: CreateOptions): Promise<TxResult>;
  buy(mint: string, lamportsIn: bigint, minOut: bigint, opts?: TradeOptions): Promise<TxResult>;
  sell(mint: string, amount: bigint, minLamports: bigint, opts?: TradeOptions): Promise<TxResult>;
  quote(mint: string, side: "buy" | "sell", amount: bigint): Promise<Quote>;
  status(mint: string): Promise<CurveStatus>;
}

export type { PublicKey, Signer };
