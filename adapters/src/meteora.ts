import BN from "bn.js";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  DynamicBondingCurveIdl,
  MigrationFeeOption,
  MigrationOption,
  SwapMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithMarketCap,
  createDbcProgram,
  deriveDbcPoolAddress,
  deriveDbcTokenVaultAddress,
  swapQuoteExactIn,
  swapQuotePartialFill,
  type ConfigParameters,
  type PoolConfig,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getTokenMetadata,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  type AccountInfo,
  type AddressLookupTableAccount,
  type Signer,
  type TransactionInstruction,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { LookupTables, staticAccounts } from "./alt";
import type { SolanaCluster } from "./config";
import { AdapterError, classifyError, type AdapterErrorCode, type ProgramErrorInfo } from "./errors";
import { anchorEventPayloads, lamportDelta, tokenDelta } from "./events";
import { fixedPrice, type PriorityPrice } from "./fees";
import { slip10DerivePath, type CreatorKeyring } from "./keys";
import { formatUnits, toBN, toBig } from "./math";
import type { CreateResult, PreparedCreate, PreparedTrade } from "./pumpfun";
import { parseMint, validateMeta } from "./pumpfun";
import type { TxPipeline } from "./sender";
import { broadcastAndConfirm, fetchTx, isSendFailure, signTx, type SendFailure, type SignedTx } from "./tx";
import type { CreateOptions, CurveStatus, LaunchpadAdapter, Quote, TokenMeta, TradeOptions, TxResult } from "./types";

/**
 * Meteora Dynamic Bonding Curve adapter (venue "meteora-dbc"), same contract
 * as PumpFunAdapter (prepare -> record signature -> submit -> result).
 *
 * SDK `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 (pinned exactly). The
 * SDK only BUILDS instructions here: every transaction is signed by
 * `signTx` with the pool-wide prefix (one quantized CU price, the same
 * Sender tip on mainnet) and sent through the shared pipeline, exactly like
 * pump.fun transactions.
 *
 * Pools are created from Unzeen's own config key (partner = the pool's
 * partner key, see `derivePartnerKeypair`), address per network from
 * METEORA_DBC_CONFIG_DEVNET / METEORA_DBC_CONFIG_MAINNET. Only pools of that
 * config are traded here (their address is a PDA of config + mint, no
 * program-wide scan); other DBC tokens -> `not_found` (Jupiter's job).
 *
 * Privacy: the pool creator is a FRESH creator address per launch (it must
 * sign `initialize_virtual_pool`, so its key is derived for the create and
 * then dropped), never a vault and never a user wallet. The vault only pays.
 */

export const DBC_PROGRAM_ID: PublicKey = DYNAMIC_BONDING_CURVE_PROGRAM_ID;

/**
 * Compute budgets. Measured on devnet 2026-10-12: create + first buy 142k CU,
 * swap2 buy 53k, swap2 sell 51k; ~2-3x headroom.
 */
const CU_CREATE = 300_000;
const CU_TRADE = 150_000;
/** Network fee headroom for one transaction, lamports. */
const FEE_HEADROOM = 100_000n;
/**
 * create: Token-2022 mint with metadata, virtual pool, base + quote vaults,
 * the vault's token ATA and a temporary wSOL account (closed in the tx).
 */
const CREATE_RENT_HEADROOM = 30_000_000n;
/** First buy of a mint: token ATA + temporary wSOL account. */
const BUY_RENT_HEADROOM = 5_000_000n;
/** First create of a vault may create / extend its address lookup table. */
const ALT_RENT_HEADROOM = 10_000_000n;
const CONFIG_TTL_MS = 60_000;

const DBC_ERRORS: readonly ProgramErrorInfo[] = (DynamicBondingCurveIdl.errors as ReadonlyArray<{ code: number; name: string }>).map(
  (e) => ({ code: e.code, name: e.name }),
);

/** DBC program error names (IDL 0.2.1) -> adapter code. */
export const DBC_ERROR_BY_NAME: Readonly<Record<string, AdapterErrorCode>> = {
  ExceededSlippage: "slippage",
  PoolIsCompleted: "graduated",
  NotEnoughLiquidity: "slippage",
  InsufficientLiquidity: "slippage",
  AmountLeftIsNotZero: "slippage",
  AmountIsZero: "bad_request",
  InvalidInput: "bad_request",
};

// ---------------------------------------------------------------------------
// Unzeen's config (partner) — parameters and addresses
// ---------------------------------------------------------------------------

/**
 * Curve of Unzeen DBC launches: the same shape as a pump.fun curve, so the
 * ledger's launch estimates (UNZEEN_LAUNCH_*, creator cap) hold for both
 * venues:
 * - 1 000 000 000 tokens, 6 decimals, SOL quote, Token-2022, metadata immutable;
 * - start market cap 27.96 SOL (pump: 30 virtual SOL / 1.073e9 virtual tokens),
 *   graduation at 410.9 SOL market cap = ~84.94 SOL raised (pump: ~85 SOL);
 * - flat 1 % trading fee in SOL: Meteora takes 20 % of it, the rest is split
 *   50/50 between the partner (the pool) and the creator (fresh pool address,
 *   credited to the launcher's anon key by core);
 * - no pool creation fee, no first-swap discount, no vesting, no leftover;
 * - graduation to DAMM v2 (0.25 % pool fee); 100 % of the LP is permanently
 *   locked (50 % partner + 50 % creator): nobody can pull liquidity.
 */
export const UNZEEN_DBC_CURVE = {
  totalTokenSupply: 1_000_000_000,
  tokenDecimals: TokenDecimal.SIX,
  initialMarketCapSol: 27.96,
  migrationMarketCapSol: 410.9,
  feeBps: 100,
  creatorTradingFeePercentage: 50,
} as const;

export function unzeenDbcConfigParameters(): ConfigParameters {
  return buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.Token2022,
      tokenBaseDecimal: UNZEEN_DBC_CURVE.tokenDecimals,
      tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: UNZEEN_DBC_CURVE.totalTokenSupply,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: UNZEEN_DBC_CURVE.feeBps, endingFeeBps: UNZEEN_DBC_CURVE.feeBps, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: UNZEEN_DBC_CURVE.creatorTradingFeePercentage,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps25,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Slot,
    initialMarketCap: UNZEEN_DBC_CURVE.initialMarketCapSol,
    migrationMarketCap: UNZEEN_DBC_CURVE.migrationMarketCapSol,
  });
}

/**
 * Unzeen config keys created by `pnpm meteora:config` (public addresses).
 * Env overrides: METEORA_DBC_CONFIG_DEVNET / METEORA_DBC_CONFIG_MAINNET.
 */
export const DEFAULT_DBC_CONFIG: Partial<Record<SolanaCluster, string>> = {
  // created 2026-10-12 by `pnpm meteora:config --send`, partner Anp6G3cSa3ncgQv2d4kpdXK1svyPBMkynzSuqfmY2sNY
  devnet: "5MHT8FPocqaLBrz9nHAyCuXSFPRbQxrXvG9E8y1eTZpK",
};

export function dbcConfigEnvName(cluster: SolanaCluster): string | null {
  return cluster === "devnet" ? "METEORA_DBC_CONFIG_DEVNET" : cluster === "mainnet-beta" ? "METEORA_DBC_CONFIG_MAINNET" : null;
}

/** Config key of this network, or null when Meteora is not set up here. */
export function dbcConfigAddress(cluster: SolanaCluster, env: NodeJS.ProcessEnv = process.env): PublicKey | null {
  const name = dbcConfigEnvName(cluster);
  const raw = (name ? env[name]?.trim() : "") || DEFAULT_DBC_CONFIG[cluster] || "";
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`${name}: not a base58 address`);
  }
}

/**
 * HD path of the partner key (fee claimer + leftover receiver of the config,
 * payer of the config account): a hardened branch next to the creator
 * addresses (m/44'/501'/<index>'/0'); `/1'` never collides with them.
 */
export const PARTNER_PATH = [44, 501, 0x7ffffffe, 1] as const;

/** The partner key of the config: claims the partner share of DBC fees. Not a vault, not a creator. */
export function derivePartnerKeypair(creatorMasterSeed: Uint8Array): Keypair {
  return Keypair.fromSeed(slip10DerivePath(creatorMasterSeed, PARTNER_PATH));
}

// ---------------------------------------------------------------------------
// pure helpers (unit-tested)
// ---------------------------------------------------------------------------

type PoolState = VirtualPool["poolState"];

/** curve | graduated: migrated, or quote reserve at the migration threshold (curve complete). */
export function dbcStatus(pool: Pick<PoolState, "isMigrated" | "quoteReserve">, config: Pick<PoolConfig, "migrationQuoteThreshold">): CurveStatus {
  const migrated = Number(pool.isMigrated) !== 0;
  return migrated || pool.quoteReserve.gte(config.migrationQuoteThreshold) ? "graduated" : "curve";
}

/** Curve progress 0..100 (2 decimals): SOL raised / migration quote threshold. */
export function dbcProgressPct(pool: Pick<PoolState, "quoteReserve">, config: Pick<PoolConfig, "migrationQuoteThreshold">): string {
  const thr = toBig(config.migrationQuoteThreshold);
  if (thr === 0n) return "100.00";
  const q = toBig(pool.quoteReserve);
  const bp = q >= thr ? 10_000n : (q * 10_000n) / thr;
  return `${bp / 100n}.${(bp % 100n).toString().padStart(2, "0")}`;
}

const Q128 = 1n << 128n;

/**
 * Spot price (SOL per whole token, 18 fractional digits, rounded down) and
 * market cap (SOL) from the pool's Q64.64 sqrt price:
 * lamports per base unit = sqrtPrice^2 / 2^128.
 */
export function dbcPriceAndCap(sqrtPrice: BN | bigint, supply: bigint, decimals: number): { priceSol: string; marketCapSol: string } {
  const s = typeof sqrtPrice === "bigint" ? sqrtPrice : toBig(sqrtPrice);
  const sq = s * s;
  const price = (sq * 10n ** BigInt(decimals) * 10n ** 18n) / (Q128 * 1_000_000_000n);
  const capLamports = (sq * supply) / Q128;
  return { priceSol: formatUnits(price, 18), marketCapSol: formatUnits(capLamports, 9) };
}

/** Tokens out for `lamportsIn` (fees included; partial fill near the threshold). */
export function dbcQuoteBuy(pool: VirtualPool, config: PoolConfig, lamportsIn: bigint, currentPoint: BN): { out: bigint; consumed: bigint } {
  const r = swapQuotePartialFill(pool, config, false, toBN(lamportsIn), 0, false, currentPoint, false);
  return { out: toBig(r.outputAmount), consumed: toBig(r.includedFeeInputAmount) };
}

/** Lamports out (net of fees) for selling `amount` tokens. */
export function dbcQuoteSell(pool: VirtualPool, config: PoolConfig, amount: bigint, currentPoint: BN): bigint {
  return toBig(swapQuoteExactIn(pool, config, true, toBN(amount), 0, false, currentPoint, false).outputAmount);
}

/** Decoded DBC events, IDL field names in camelCase (anchor coder). */
export interface DbcSwap2Event {
  pool: PublicKey;
  tradeDirection: number;
  swapResult: { includedFeeInputAmount: BN; excludedFeeInputAmount: BN; amountLeft: BN; outputAmount: BN; tradingFee: BN; protocolFee: BN; referralFee: BN };
}
export interface DbcSwapEvent {
  pool: PublicKey;
  tradeDirection: number;
  amountIn: BN;
  swapResult: { actualInputAmount: BN; outputAmount: BN; tradingFee: BN; protocolFee: BN; referralFee: BN };
}
export interface DbcInitEvent {
  pool: PublicKey;
  config: PublicKey;
  creator: PublicKey;
  baseMint: PublicKey;
}

/** TradeDirection: 0 = base -> quote (sell), 1 = quote -> base (buy). */
const QUOTE_TO_BASE = 1;

/**
 * Executed amounts of one swap, venue fees included, rent and network fee
 * excluded (collect fee mode QuoteToken: the fee is in SOL, taken from the
 * input on a buy and from the output on a sell):
 * - swap2 buy: lamports = includedFeeInputAmount (what left the vault for the
 *   curve; a partial fill refunds `amountLeft`), tokens = outputAmount;
 * - swap2 sell: tokens = includedFeeInputAmount, lamports = outputAmount (net);
 * - swap (v1, the first buy of create_pool_with_first_buy): exact-in, the whole
 *   `amountIn` is spent, tokens = outputAmount.
 */
export function dbcSwapAmounts(ev: { kind: "swap2"; e: DbcSwap2Event } | { kind: "swap"; e: DbcSwapEvent }): {
  isBuy: boolean;
  tokenAmount: bigint;
  solAmount: bigint;
} {
  if (ev.kind === "swap2") {
    const r = ev.e.swapResult;
    const isBuy = ev.e.tradeDirection === QUOTE_TO_BASE;
    return isBuy
      ? { isBuy, tokenAmount: toBig(r.outputAmount), solAmount: toBig(r.includedFeeInputAmount) }
      : { isBuy, tokenAmount: toBig(r.includedFeeInputAmount), solAmount: toBig(r.outputAmount) };
  }
  const isBuy = ev.e.tradeDirection === QUOTE_TO_BASE;
  return isBuy
    ? { isBuy, tokenAmount: toBig(ev.e.swapResult.outputAmount), solAmount: toBig(ev.e.amountIn) }
    : { isBuy, tokenAmount: toBig(ev.e.amountIn), solAmount: toBig(ev.e.swapResult.outputAmount) };
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

type EventCoder = { decode(log: string): { name: string; data: unknown } | null };

function eventDisc(name: string): Buffer {
  const ev = (DynamicBondingCurveIdl.events as ReadonlyArray<{ name: string; discriminator: number[] }>).find((e) => e.name === name);
  if (!ev) throw new Error(`DBC IDL has no event ${name}`);
  return Buffer.from(ev.discriminator);
}
const EVT_SWAP = eventDisc("EvtSwap");
const EVT_SWAP2 = eventDisc("EvtSwap2");
const EVT_INIT = eventDisc("EvtInitializePool");

/**
 * Anchor coder of the DBC IDL, built once without network access (the
 * Connection is never used for decoding).
 */
let sharedCoder: { accounts: { decode(name: string, data: Buffer): unknown }; events: EventCoder } | null = null;
export function dbcCoder(): { accounts: { decode(name: string, data: Buffer): unknown }; events: EventCoder } {
  sharedCoder ??= createDbcProgram(new Connection("http://127.0.0.1:8899")).program.coder as unknown as NonNullable<typeof sharedCoder>;
  return sharedCoder;
}

/** EvtSwap2 (buy / sell) events of a confirmed transaction. */
export function dbcSwap2Events(tx: VersionedTransactionResponse): DbcSwap2Event[] {
  return decodeEvents<DbcSwap2Event>(tx, dbcCoder().events, EVT_SWAP2);
}
/** EvtSwap (the first buy of create_pool_with_first_buy) events. */
export function dbcSwapEvents(tx: VersionedTransactionResponse): DbcSwapEvent[] {
  return decodeEvents<DbcSwapEvent>(tx, dbcCoder().events, EVT_SWAP);
}
/** EvtInitializePool events. */
export function dbcInitEvents(tx: VersionedTransactionResponse): DbcInitEvent[] {
  return decodeEvents<DbcInitEvent>(tx, dbcCoder().events, EVT_INIT);
}

function decodeEvents<T>(tx: VersionedTransactionResponse, coder: EventCoder, disc: Buffer): T[] {
  const out: T[] = [];
  for (const p of anchorEventPayloads(tx, DBC_PROGRAM_ID, disc)) {
    try {
      const ev = coder.decode(Buffer.concat([disc, p]).toString("base64"));
      if (ev) out.push(ev.data as T);
    } catch {
      // layout drift: caller falls back to balance deltas
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------

export interface MeteoraDbcAdapterOptions {
  connection: Connection;
  /** Unzeen's config key on this network (`dbcConfigAddress`). */
  config: PublicKey;
  defaultVault: Signer;
  vaults?: readonly Signer[];
  creators: CreatorKeyring;
  stateDir: string;
  /** Pool-wide compute unit price (src/fees.ts cache); a number = fixed. */
  priorityMicroLamports?: number | PriorityPrice;
  /** Pool tip + broadcaster (src/sender.ts), shared with every other builder. */
  pipeline?: TxPipeline | null;
  /** Shared per-vault lookup tables (same instance as the pump.fun adapter). */
  lookupTables?: LookupTables;
}

interface MintInfo {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  supply: bigint;
}

interface PoolView extends MintInfo {
  address: PublicKey;
  pool: VirtualPool;
  config: PoolConfig;
}

export class MeteoraDbcAdapter implements LaunchpadAdapter {
  readonly id = "meteora-dbc" as const;
  readonly configAddress: PublicKey;
  private readonly connection: Connection;
  private readonly client: DynamicBondingCurveClient;
  private readonly coder: { accounts: { decode(name: string, data: Buffer): unknown }; events: EventCoder };
  private readonly defaultVault: Signer;
  private readonly vaultKeys: Set<string>;
  private readonly creators: CreatorKeyring;
  private readonly priority: PriorityPrice;
  private readonly alts: LookupTables;
  private readonly pipeline: TxPipeline | null;
  private cfg: { at: number; config: PoolConfig } | null = null;

  constructor(o: MeteoraDbcAdapterOptions) {
    this.connection = o.connection;
    this.configAddress = o.config;
    this.client = new DynamicBondingCurveClient(o.connection, "confirmed");
    this.coder = dbcCoder();
    this.defaultVault = o.defaultVault;
    this.vaultKeys = new Set([o.defaultVault, ...(o.vaults ?? [])].map((v) => v.publicKey.toBase58()));
    this.creators = o.creators;
    const p = o.priorityMicroLamports ?? 0;
    this.priority = typeof p === "number" ? fixedPrice(p) : p;
    this.pipeline = o.pipeline ?? null;
    this.alts = o.lookupTables ?? new LookupTables(o.connection, o.stateDir, this.priority, this.pipeline);
  }

  /** Pool PDA of `mint` under Unzeen's config (SOL quote). */
  poolAddress(mint: PublicKey): PublicKey {
    return deriveDbcPoolAddress(NATIVE_MINT, mint, this.configAddress);
  }

  // -------------------------------------------------------------------------
  // read side
  // -------------------------------------------------------------------------

  async status(mint: string): Promise<CurveStatus> {
    const v = await this.loadPool(parseMint(mint));
    return dbcStatus(v.pool.poolState, v.config);
  }

  async quote(mint: string, side: "buy" | "sell", amount: bigint): Promise<Quote> {
    if (amount <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    const v = await this.loadPool(parseMint(mint));
    const status = dbcStatus(v.pool.poolState, v.config);
    if (status === "graduated") throw new AdapterError("graduated", `${mint} has left the bonding curve; trade it on DAMM v2 / Jupiter`);
    const point = await this.currentPoint(v.config);
    const amountOut = side === "buy" ? dbcQuoteBuy(v.pool, v.config, amount, point).out : dbcQuoteSell(v.pool, v.config, amount, point);
    return {
      venue: this.id,
      mint,
      side,
      amountIn: amount,
      amountOut,
      ...dbcPriceAndCap(v.pool.poolState.sqrtPrice, v.supply, v.decimals),
      status,
      decimals: v.decimals,
    };
  }

  /** Public price / market cap / status (tokens table). */
  async market(mint: string): Promise<{ priceSol: string; marketCapSol: string; status: CurveStatus }> {
    const v = await this.loadPool(parseMint(mint));
    return { ...dbcPriceAndCap(v.pool.poolState.sqrtPrice, v.supply, v.decimals), status: dbcStatus(v.pool.poolState, v.config) };
  }

  /** Curve progress for the indexer / UI. */
  async progress(mint: string): Promise<{ progressPct: string; graduated: boolean }> {
    const v = await this.loadPool(parseMint(mint));
    return { progressPct: dbcProgressPct(v.pool.poolState, v.config), graduated: dbcStatus(v.pool.poolState, v.config) === "graduated" };
  }

  async tokenSymbol(mint: string): Promise<string | null> {
    const pk = parseMint(mint);
    const mi = await this.loadMint(pk);
    if (!mi.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return null;
    const md = await getTokenMetadata(this.connection, pk, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);
    return md?.symbol ?? null;
  }

  /** Unzeen's config as stored on chain (cached briefly). */
  async poolConfig(): Promise<PoolConfig> {
    if (this.cfg && Date.now() - this.cfg.at < CONFIG_TTL_MS) return this.cfg.config;
    const info = await this.rpc(() => this.connection.getAccountInfo(this.configAddress));
    if (!info || !info.owner.equals(DBC_PROGRAM_ID)) {
      throw new AdapterError("venue_unavailable", "Meteora DBC config account not found on this network");
    }
    const config = this.coder.accounts.decode("poolConfig", info.data) as PoolConfig;
    this.cfg = { at: Date.now(), config };
    return config;
  }

  // -------------------------------------------------------------------------
  // write side
  // -------------------------------------------------------------------------

  async create(meta: TokenMeta, initialBuyLamports: bigint, opts: CreateOptions = {}): Promise<TxResult> {
    const p = await this.prepareCreate(meta, initialBuyLamports, 0n, opts);
    const sent = await this.submit(p);
    const r = await this.createResult(sent.signature, p.vault);
    const fallback = emptyResult("create", sent, { mint: new PublicKey(p.mint), tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: UNZEEN_DBC_CURVE.tokenDecimals, supply: 0n }, p.vault);
    return { ...(r ?? fallback), creator: p.creator, creatorIndex: p.creatorIndex };
  }

  /**
   * Signs initialize_virtual_pool_with_token2022 (+ the first buy when
   * `initialBuyLamports > 0`) in ONE transaction, with a fresh creator and a
   * new mint key. Sends nothing.
   */
  async prepareCreate(meta: TokenMeta, initialBuyLamports: bigint, minOut: bigint, opts: CreateOptions = {}): Promise<PreparedCreate> {
    validateMeta(meta);
    if (initialBuyLamports < 0n) throw new AdapterError("bad_request", "initialBuyLamports must be >= 0");
    if (minOut < 0n) throw new AdapterError("bad_request", "minOut must be >= 0");
    const vault = opts.vault ?? this.defaultVault;
    const config = await this.poolConfig();
    if (!config.quoteMint.equals(NATIVE_MINT)) throw new AdapterError("venue_unavailable", "Meteora DBC config is not SOL-quoted");
    await this.requireSol(vault.publicKey, initialBuyLamports + CREATE_RENT_HEADROOM + ALT_RENT_HEADROOM);

    let expected = 0n;
    if (initialBuyLamports > 0n) {
      const q = this.client.pool.getQuoteFromInputAmount({ config, swapBaseForQuote: false, amountIn: toBN(initialBuyLamports) });
      expected = toBig(q.outputAmount);
      if (expected < minOut) throw new AdapterError("slippage", `first buy quote ${expected} < minOut ${minOut}`);
    }

    // Allocate only after the cheap checks: every allocated index is burnt.
    const creatorIndex = opts.creatorIndex ?? (await this.creators.allocate());
    const creatorPk = this.creators.publicKey(creatorIndex); // recorded in creator-pubkeys.json first (T1)
    if (this.vaultKeys.has(creatorPk.toBase58())) throw new AdapterError("internal", "creator collides with a vault");
    const creatorKp = this.creators.keypair(creatorIndex);
    const mintKp = Keypair.generate();

    const build = (mint: PublicKey, payer: PublicKey, creator: PublicKey) =>
      this.sdk(async () => {
        const tx = await this.client.creator.createPoolWithFirstBuy({
          createPoolParam: { name: meta.name, symbol: meta.symbol, uri: meta.uri, payer, poolCreator: creator, config: this.configAddress, baseMint: mint },
          ...(initialBuyLamports > 0n
            ? { firstBuyParam: { buyer: payer, buyAmount: toBN(initialBuyLamports), minimumAmountOut: toBN(minOut > 0n ? minOut : 1n), referralTokenAccount: null } }
            : {}),
        });
        return tx.instructions;
      });
    const ixs = await build(mintKp.publicKey, vault.publicKey, creatorPk);
    const table = await this.lookupTable(vault, ixs, build);
    const signed = await this.sign(ixs, vault, CU_CREATE, [mintKp, creatorKp], [table]);
    return {
      ...signed,
      kind: "create",
      mint: mintKp.publicKey.toBase58(),
      vault: vault.publicKey.toBase58(),
      creator: creatorPk.toBase58(),
      creatorIndex,
      expectedOut: expected,
    };
  }

  /** Executed create: mint + creator from EvtInitializePool, first buy from EvtSwap. Null if unreadable yet. */
  async createResult(signature: string, vault: string): Promise<CreateResult | null> {
    const tx = await fetchTx(this.connection, signature, 10).catch(() => null);
    if (!tx) return null;
    const init = dbcInitEvents(tx).find((e) => e.config.equals(this.configAddress));
    if (!init) return null;
    const mint = init.baseMint;
    const vaultPk = new PublicKey(vault);
    const [mi, md] = await Promise.all([
      this.loadMint(mint).catch(() => null),
      getTokenMetadata(this.connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null),
    ]);
    if (!md) return null; // name/symbol/uri needed for the tokens row: re-read later
    const swap = dbcSwapEvents(tx).find((e) => e.pool.equals(init.pool));
    let tokenAmount = 0n;
    let solAmount = 0n;
    if (swap) {
      ({ tokenAmount, solAmount } = dbcSwapAmounts({ kind: "swap", e: swap }));
    } else {
      tokenAmount = tokenDelta(tx, vaultPk, mint);
      if (tokenAmount > 0n) return null; // a buy happened but its event is unreadable: never guess SOL
    }
    return {
      venue: this.id,
      kind: "create",
      signature,
      slot: tx.slot,
      mint: mint.toBase58(),
      vault,
      creator: init.creator.toBase58(),
      name: md.name,
      symbol: md.symbol,
      uri: md.uri,
      tokenProgram: (mi?.tokenProgram ?? TOKEN_2022_PROGRAM_ID).toBase58(),
      tokenAmount,
      solAmount,
      networkFee: BigInt(tx.meta?.fee ?? 0),
      blockTime: tx.blockTime ?? null,
      decimals: mi?.decimals ?? UNZEEN_DBC_CURVE.tokenDecimals,
      amountsKnown: true,
      fromEvent: swap !== undefined,
    };
  }

  async buy(mint: string, lamportsIn: bigint, minOut: bigint, opts: TradeOptions = {}): Promise<TxResult> {
    const p = await this.prepareBuy(mint, lamportsIn, minOut, opts);
    const sent = await this.submit(p);
    return this.landedResult(p, sent);
  }

  async sell(mint: string, amount: bigint, minLamports: bigint, opts: TradeOptions = {}): Promise<TxResult> {
    const p = await this.prepareSell(mint, amount, minLamports, opts);
    const sent = await this.submit(p);
    return this.landedResult(p, sent);
  }

  /**
   * swap2 PartialFill quote -> base: spends at most `lamportsIn` (fees
   * included); near the graduation threshold the rest is refunded in the tx.
   */
  async prepareBuy(mint: string, lamportsIn: bigint, minOut: bigint, opts: TradeOptions = {}): Promise<PreparedTrade> {
    if (lamportsIn <= 0n) throw new AdapterError("bad_request", "lamportsIn must be > 0");
    if (minOut < 0n) throw new AdapterError("bad_request", "minOut must be >= 0");
    const vault = opts.vault ?? this.defaultVault;
    const v = await this.loadPool(parseMint(mint));
    assertTradable(v, mint);
    const expected = dbcQuoteBuy(v.pool, v.config, lamportsIn, await this.currentPoint(v.config)).out;
    if (expected < minOut) throw new AdapterError("slippage", `quote ${expected} < minOut ${minOut}`);
    const ata = getAssociatedTokenAddressSync(v.mint, vault.publicKey, true, v.tokenProgram);
    const ataInfo = await this.rpc(() => this.connection.getAccountInfo(ata));
    await this.requireSol(vault.publicKey, lamportsIn + (ataInfo ? 0n : BUY_RENT_HEADROOM));
    const ixs = await this.sdk(async () =>
      (
        await this.client.pool.swap2({
          owner: vault.publicKey,
          pool: v.address,
          swapBaseForQuote: false,
          referralTokenAccount: null,
          swapMode: SwapMode.PartialFill,
          amountIn: toBN(lamportsIn),
          minimumAmountOut: toBN(minOut > 0n ? minOut : 1n),
        })
      ).instructions,
    );
    const signed = await this.signTrade(ixs, vault);
    return { ...signed, kind: "buy", mint, vault: vault.publicKey.toBase58(), expectedOut: expected };
  }

  /** swap2 ExactIn base -> quote, min lamports out (net of fees). */
  async prepareSell(mint: string, amount: bigint, minLamports: bigint, opts: TradeOptions = {}): Promise<PreparedTrade> {
    if (amount <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    if (minLamports < 0n) throw new AdapterError("bad_request", "minLamports must be >= 0");
    const vault = opts.vault ?? this.defaultVault;
    const v = await this.loadPool(parseMint(mint));
    assertTradable(v, mint);
    const ata = getAssociatedTokenAddressSync(v.mint, vault.publicKey, true, v.tokenProgram);
    const ataInfo = await this.rpc(() => this.connection.getAccountInfo(ata));
    const held = ataInfo ? unpackAccount(ata, ataInfo, v.tokenProgram).amount : 0n;
    if (held < amount) throw new AdapterError("insufficient_tokens", `vault holds ${held} < ${amount}`);
    const expected = dbcQuoteSell(v.pool, v.config, amount, await this.currentPoint(v.config));
    if (expected < minLamports) throw new AdapterError("slippage", `quote ${expected} < minLamports ${minLamports}`);
    // temporary wSOL account for the proceeds (closed in the same tx)
    await this.requireSol(vault.publicKey, 2_100_000n);
    const ixs = await this.sdk(async () =>
      (
        await this.client.pool.swap2({
          owner: vault.publicKey,
          pool: v.address,
          swapBaseForQuote: true,
          referralTokenAccount: null,
          swapMode: SwapMode.ExactIn,
          amountIn: toBN(amount),
          minimumAmountOut: toBN(minLamports),
        })
      ).instructions,
    );
    const signed = await this.signTrade(ixs, vault);
    return { ...signed, kind: "sell", mint, vault: vault.publicKey.toBase58(), expectedOut: expected };
  }

  async submit(p: SignedTx): Promise<{ signature: string; slot: number }> {
    try {
      return await broadcastAndConfirm(this.connection, p, this.pipeline?.broadcaster);
    } catch (e) {
      throw this.sendError(e);
    }
  }

  /** Executed amounts of a landed buy/sell from its EvtSwap2 (fallback: balance deltas). */
  async tradeResult(kind: "buy" | "sell", signature: string, vault: string, mint: string): Promise<TxResult | null> {
    const mi = await this.loadMint(parseMint(mint));
    return this.readResult(kind, signature, new PublicKey(vault), mi);
  }

  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    return classifyError(err, logs, DBC_ERRORS, DBC_PROGRAM_ID.toBase58(), DBC_ERROR_BY_NAME, "dbc");
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async landedResult(p: PreparedTrade, sent: { signature: string; slot: number }): Promise<TxResult> {
    const mi = await this.loadMint(parseMint(p.mint));
    return (await this.readResult(p.kind, sent.signature, new PublicKey(p.vault), mi)) ?? emptyResult(p.kind, sent, mi, p.vault);
  }

  private async readResult(kind: "buy" | "sell", signature: string, vault: PublicKey, mi: MintInfo): Promise<TxResult | null> {
    const tx = await fetchTx(this.connection, signature, 10).catch(() => null);
    if (!tx) return null;
    const fee = BigInt(tx.meta?.fee ?? 0);
    const pool = this.poolAddress(mi.mint);
    const ev = dbcSwap2Events(tx).find((e) => e.pool.equals(pool));
    let tokenAmount: bigint;
    let solAmount: bigint;
    if (ev) {
      ({ tokenAmount, solAmount } = dbcSwapAmounts({ kind: "swap2", e: ev }));
    } else {
      const td = tokenDelta(tx, vault, mi.mint);
      tokenAmount = td < 0n ? -td : td;
      const d = lamportDelta(tx, vault) + fee;
      solAmount = d < 0n ? -d : d;
    }
    return {
      venue: this.id,
      kind,
      signature,
      slot: tx.slot,
      mint: mi.mint.toBase58(),
      vault: vault.toBase58(),
      tokenAmount,
      solAmount,
      networkFee: fee,
      blockTime: tx.blockTime ?? null,
      decimals: mi.decimals,
      amountsKnown: true,
      fromEvent: ev !== undefined,
    };
  }

  private async loadMint(mint: PublicKey): Promise<MintInfo> {
    const info = await this.rpc(() => this.connection.getAccountInfo(mint));
    if (!info) throw new AdapterError("not_found", `mint ${mint.toBase58()} does not exist`);
    return mintInfo(mint, info);
  }

  private async loadPool(mint: PublicKey): Promise<PoolView> {
    const address = this.poolAddress(mint);
    const [mintAcc, poolAcc] = await this.rpc(() => this.connection.getMultipleAccountsInfo([mint, address]));
    if (!mintAcc) throw new AdapterError("not_found", `mint ${mint.toBase58()} does not exist`);
    const mi = mintInfo(mint, mintAcc);
    if (!poolAcc || !poolAcc.owner.equals(DBC_PROGRAM_ID)) {
      throw new AdapterError("not_found", `no Unzeen Meteora DBC pool for ${mint.toBase58()}`);
    }
    const pool = this.coder.accounts.decode("virtualPool", poolAcc.data) as VirtualPool;
    const config = await this.poolConfig();
    return { ...mi, address, pool, config };
  }

  private async currentPoint(config: PoolConfig): Promise<BN> {
    const slot = await this.rpc(() => this.connection.getSlot("confirmed"));
    if (Number(config.activationType) === ActivationType.Slot) return new BN(slot);
    const t = await this.rpc(() => this.connection.getBlockTime(slot));
    return new BN(t ?? Math.floor(Date.now() / 1000));
  }

  private async requireSol(vault: PublicKey, need: bigint): Promise<void> {
    const bal = BigInt(await this.rpc(() => this.connection.getBalance(vault, "confirmed")));
    if (bal < need + FEE_HEADROOM) throw new AdapterError("insufficient_sol", `vault has ${bal} lamports, needs ~${need + FEE_HEADROOM}`);
  }

  private async lookupTable(
    vault: Signer,
    ixs: TransactionInstruction[],
    build: (mint: PublicKey, payer: PublicKey, creator: PublicKey) => Promise<TransactionInstruction[]>,
  ): Promise<AddressLookupTableAccount> {
    const r = () => Keypair.generate().publicKey;
    const other = await build(r(), r(), r());
    try {
      return await this.alts.ensure(vault, staticAccounts(ixs, other));
    } catch (e) {
      throw this.classify(e);
    }
  }

  /** Trades: legacy when they fit, else v0 with the vault's lookup table. */
  private async signTrade(ixs: TransactionInstruction[], vault: Signer): Promise<SignedTx> {
    try {
      return await this.sign(ixs, vault, CU_TRADE);
    } catch (e) {
      if (!(e instanceof AdapterError) || e.stage !== "build") throw e;
      const table = await this.alts.ensure(vault, staticTradeAccounts(ixs)).catch((err) => {
        throw this.classify(err);
      });
      return this.sign(ixs, vault, CU_TRADE, [], [table]);
    }
  }

  private async sign(ixs: TransactionInstruction[], payer: Signer, cu: number, extra: Signer[] = [], lookupTables?: AddressLookupTableAccount[]): Promise<SignedTx> {
    try {
      return await signTx(this.connection, ixs, payer, extra, {
        computeUnits: cu,
        priorityMicroLamports: this.priority.microLamports(),
        tip: this.pipeline?.tip ?? null,
        ...(lookupTables ? { lookupTables } : {}),
      });
    } catch (e) {
      throw this.sendError(e);
    }
  }

  private sendError(e: unknown): AdapterError {
    if (!isSendFailure(e)) return this.classify(e);
    const f: SendFailure = e;
    const err = this.classify(f.error, f.logs);
    return new AdapterError(err.code, err.message, {
      ...(err.programError ? { programError: err.programError } : {}),
      ...(f.signature ? { signature: f.signature } : {}),
      ...(f.stage ? { stage: f.stage } : {}),
      ...(f.landedErr ? { landedErr: true } : {}),
      cause: f.error,
    });
  }

  /** SDK builders read the chain (pool, ATAs): failures there are RPC trouble unless typed. */
  private async sdk<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/completed/i.test(msg)) throw new AdapterError("graduated", msg.split("\n", 1)[0] ?? msg, { cause: e });
      if (/not found/i.test(msg)) throw new AdapterError("not_found", msg.split("\n", 1)[0] ?? msg, { cause: e });
      throw new AdapterError("venue_unavailable", `Meteora SDK: ${msg.split("\n", 1)[0] ?? msg}`, { cause: e });
    }
  }

  private async rpc<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new AdapterError("venue_unavailable", `RPC error: ${msg.split("\n", 1)[0] ?? msg}`, { cause: e });
    }
  }
}

function mintInfo(mint: PublicKey, info: AccountInfo<Buffer>): MintInfo {
  const tokenProgram = info.owner;
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new AdapterError("not_found", `${mint.toBase58()} is not an SPL mint`);
  }
  const m = unpackMint(mint, info, tokenProgram);
  return { mint, tokenProgram, decimals: m.decimals, supply: m.supply };
}

function assertTradable(v: PoolView, mint: string): void {
  if (dbcStatus(v.pool.poolState, v.config) === "graduated") {
    throw new AdapterError("graduated", `${mint} has left the bonding curve; trade it on DAMM v2 / Jupiter`);
  }
}

/**
 * Accounts of a swap worth a lookup table entry: programs and read-only,
 * non-signer accounts (pool authority, config, mints, token programs, event
 * authority). The vault's own token accounts never go into a table.
 */
function staticTradeAccounts(ixs: readonly TransactionInstruction[]): PublicKey[] {
  const m = new Map<string, PublicKey>();
  for (const ix of ixs) {
    m.set(ix.programId.toBase58(), ix.programId);
    for (const k of ix.keys) if (!k.isSigner && !k.isWritable) m.set(k.pubkey.toBase58(), k.pubkey);
  }
  return [...m.values()];
}

function emptyResult(kind: "create" | "buy" | "sell", sent: { signature: string; slot: number }, mi: MintInfo, vault: string): TxResult {
  return {
    venue: "meteora-dbc",
    kind,
    signature: sent.signature,
    slot: sent.slot,
    mint: mi.mint.toBase58(),
    vault,
    tokenAmount: 0n,
    solAmount: 0n,
    networkFee: 0n,
    decimals: mi.decimals,
    amountsKnown: false,
    fromEvent: false,
  };
}

/** Base / quote vault PDAs of a DBC pool (indexer: excluded from holder stats). */
export function dbcPoolVaults(pool: PublicKey, mint: PublicKey): { baseVault: PublicKey; quoteVault: PublicKey } {
  return { baseVault: deriveDbcTokenVaultAddress(pool, mint), quoteVault: deriveDbcTokenVaultAddress(pool, NATIVE_MINT) };
}
