import { createHash } from "node:crypto";
import BN from "bn.js";
import {
  Curve,
  CpmmCreatorFeeOn,
  DEV_LAUNCHPAD_PROGRAM,
  LAUNCHPAD_PROGRAM,
  LaunchpadConfig,
  LaunchpadCurveRuleBaseTokenProgram,
  LaunchpadPool,
  PlatformConfig,
  PlatformCurveRule,
  buyExactInInstruction,
  checkLaunchAgainstCurveRule,
  getPdaCreatorVault,
  getPdaLaunchpadAuth,
  getPdaLaunchpadPoolId,
  getPdaLaunchpadVaultId,
  getPdaMetadataKey,
  getPdaPlatformCurveRule,
  getPdaPlatformVault,
  initializeV2,
  initializeWithToken2022,
  sellExactInInstruction,
} from "@raydium-io/raydium-sdk-v2";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getTokenMetadata,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountInfo,
  type AddressLookupTableAccount,
  type Connection,
  type Signer,
  type TransactionInstruction,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { LookupTables, staticAccounts } from "./alt";
import { parseMetaplexMetadata } from "./intel/metrics";
import type { SolanaCluster } from "./config";
import { AdapterError, classifyError } from "./errors";
import { anchorEventPayloads, tokenDelta } from "./events";
import { fixedPrice, type PriorityPrice } from "./fees";
import type { CreatorKeyring } from "./keys";
import { formatUnits, toBN, toBig } from "./math";
import { makeQuotePool, type QuoteAsset, type QuotePool } from "./pool-a";
import type { CreateResult, PreparedCreate, PreparedTrade } from "./pumpfun";
import { parseMint, validateMeta } from "./pumpfun";
import type { TxPipeline } from "./sender";
import { broadcastAndConfirm, fetchTx, isSendFailure, signTx, type SendFailure, type SignedTx } from "./tx";
import type { CreateOptions, CurveStatus, Quote, TokenMeta, TradeOptions, TxResult } from "./types";

/**
 * Raydium LaunchLab adapter (venue "raydium-launchlab"): one adapter for every
 * LaunchLab platform — stonk.fun and bonk.fun (platform IDs hardcoded, checked
 * on chain 13.10, launchpads-a.md §3-4) and Unzeen's own platform config.
 *
 * SDK `@raydium-io/raydium-sdk-v2` 0.2.74-alpha (pinned exactly): only the
 * low-level instruction builders, account layouts, PDAs and curve math are
 * used. `Raydium.load()` is NEVER called (it fetches Raydium's HTTP API: our
 * server would tell a third party what it looks at).
 *
 * - create = `initialize_v2` (SPL mint + Metaplex metadata) + first `buy_exact_in`
 *   in ONE tx; `creator` is a FRESH HD creator address per launch (not a signer,
 *   so it never needs SOL; its key is kept to claim creator fees later);
 *   the vault only pays. Quote = the GlobalConfig chosen by quote mint.
 * - platforms with `restrictCurveParam` (stonk.fun): the launch parameters are
 *   checked against the platform's PlatformCurveRule before anything is signed.
 * - SOL quote: a wSOL ATA is filled for the buy and closed in the same tx.
 * - non-SOL quote: the same stock/leg model as DBC and pump.fun (src/pool-a.ts);
 *   stock-only quotes (ZEC) use quote units and core's valuation.
 */

export const LAUNCHLAB_PROGRAM: Record<"mainnet-beta" | "devnet", PublicKey> = {
  "mainnet-beta": LAUNCHPAD_PROGRAM,
  devnet: DEV_LAUNCHPAD_PROGRAM,
};

/** Third-party platforms (verified on chain 13.10: name, fees, claim wallet). Never chosen by name. */
export const LAUNCHLAB_PLATFORMS: Record<"mainnet-beta" | "devnet", Record<string, string>> = {
  "mainnet-beta": {
    stonk: "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7", // "StonkFun": fee 1 %, creator 0, restrictCurveParam 1
    bonk: "FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1", // "letsbonk.fun": fee 1.25 %, creator 0
  },
  devnet: {}, // stonk / bonk have no devnet platform: devnet uses "unzeen"
};

/**
 * What we accepted for the third-party platforms (on chain 13.10). Checked at start
 * (`checkPlatforms`): a platform whose claim wallet or fee rates changed is switched off.
 */
export const LAUNCHLAB_PLATFORM_PINS: Record<string, { claimWallet: string; feeRate: number; creatorFeeRate: number }> = {
  stonk: { claimWallet: "5CEbueQnq1Ym2uSSx2xXds3jQAqT1BDnkA59RZobSPAG", feeRate: 10_000, creatorFeeRate: 0 },
  bonk: { claimWallet: "YvWXoyyRpD5fPVZHZV6SY8NS1nuTFmyewxudD3mwuE3", feeRate: 12_500, creatorFeeRate: 0 },
};

/** GlobalConfig (curve type 0, index 0) per quote mint, read on chain 13.10. */
export const LAUNCHLAB_CONFIGS: Record<"mainnet-beta" | "devnet", Record<string, string>> = {
  "mainnet-beta": {
    So11111111111111111111111111111111111111112: "6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX",
    USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: "EPiZbnrThjyLnoQ6QQzkxeFqyL5uyg9RzNHHAudUPxBz",
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "8gj14w8vkNZjJTPak6e96Uf1sY438WKheH4s5dHyxiRw",
    A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS: "E2fd24QycuwszEK8WyU8CgtCfp5bUkTMenUthzgShJxA",
  },
  devnet: {
    So11111111111111111111111111111111111111112: "7ZR4zD7PYfY2XxoG1Gxcy2EgEeGYrpxrwzPuwdUBssEt",
    USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT: "4wHbNkobu7iARU9MbCEqDSAq6JuQreGupG2Jsf2R3DFP",
  },
};

/**
 * Unzeen's own platform (scripts/launchlab-platform.ts). Rates in 1e-6:
 * protocol 0.25 % + platform 0.45 % + creator 0.30 % = 1 % total, like the DBC curve;
 * creator 0.30 % = the rate core assumes for pump.fun launches (one creator rate).
 * LP after graduation: 100 % platform (locked NFT).
 */
export const UNZEEN_PLATFORM = {
  name: "Unzeen",
  web: "",
  img: "",
  feeRate: 4_500,
  creatorFeeRate: 3_000,
  // The program requires creatorScale = 0 (platform_config.rs:58, devnet 13.10; stonk/bonk have 0 too):
  // the graduated LP goes 100 % to the platform as a locked NFT (fees only, nobody can pull liquidity).
  platformScale: 1_000_000,
  creatorScale: 0,
  burnScale: 0,
} as const;

/** Launch parameters (pump.fun-like shape): 1e9 tokens, 6 decimals, 79.31 % sold on the curve, CPMM migration. */
export const LAUNCH_SUPPLY = 1_000_000_000_000_000n;
export const LAUNCH_TOTAL_SELL = 793_100_000_000_000n;
/** totalFundRaisingB per quote (base units): SOL 85, USD-like 12 500, ZEC 200. */
export function fundRaisingFor(quote: { mint: PublicKey; decimals: number; symbol?: string }): bigint {
  if (quote.mint.equals(NATIVE_MINT)) return 85_000_000_000n;
  if (quote.symbol === "ZEC") return 200n * 10n ** BigInt(quote.decimals);
  return 12_500n * 10n ** BigInt(quote.decimals);
}

/** Fixed CU per class (stock and leg paths alike: no CU fingerprint). */
export const CU_LL_CREATE = 400_000;
export const CU_LL_TRADE = 200_000;
export const CU_LL_CREATE_QUOTE = 500_000;
export const CU_LL_TRADE_QUOTE = 300_000;
const QUOTE_MARGIN_BPS = 50n;
const FEE_HEADROOM = 100_000n;
const CREATE_RENT_HEADROOM = 25_000_000n;
const BUY_RENT_HEADROOM = 5_000_000n;
const ALT_RENT_HEADROOM = 10_000_000n;

const eventDisc = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
const TRADE_EVENT = eventDisc("TradeEvent");
const POOL_CREATE_EVENT = eventDisc("PoolCreateEvent");

export interface LaunchLabTradeEvent {
  pool: PublicKey;
  amountIn: bigint;
  amountOut: bigint;
  protocolFee: bigint;
  platformFee: bigint;
  creatorFee: bigint;
  shareFee: bigint;
  /** 0 = buy, 1 = sell (IDL TradeDirection). */
  direction: number;
  /** 0 = trading, 1 = migrating, 2 = migrated (IDL PoolStatus). */
  poolStatus: number;
  exactIn: boolean;
}

/** TradeEvent (IDL 13.10): pool 32 | 13 x u64 | direction u8 | status u8 | exact_in bool. */
export function decodeTradeEvent(p: Buffer): LaunchLabTradeEvent | null {
  if (p.length < 32 + 13 * 8 + 3) return null;
  const u = (i: number) => p.readBigUInt64LE(32 + i * 8);
  return {
    pool: new PublicKey(p.subarray(0, 32)),
    amountIn: u(7),
    amountOut: u(8),
    protocolFee: u(9),
    platformFee: u(10),
    creatorFee: u(11),
    shareFee: u(12),
    direction: p.readUInt8(32 + 13 * 8),
    poolStatus: p.readUInt8(32 + 13 * 8 + 1),
    exactIn: p.readUInt8(32 + 13 * 8 + 2) !== 0,
  };
}

/** PoolCreateEvent: pool 32 | creator 32 | config 32 | MintParams { decimals u8, name, symbol, uri (borsh strings) }. */
export function decodePoolCreateEvent(p: Buffer): { pool: PublicKey; creator: PublicKey; config: PublicKey; name: string; symbol: string; uri: string } | null {
  try {
    let o = 96 + 1;
    const str = () => {
      const n = p.readUInt32LE(o);
      const s = p.subarray(o + 4, o + 4 + n).toString("utf8");
      o += 4 + n;
      return s;
    };
    const name = str();
    const symbol = str();
    const uri = str();
    return { pool: new PublicKey(p.subarray(0, 32)), creator: new PublicKey(p.subarray(32, 64)), config: new PublicKey(p.subarray(64, 96)), name, symbol, uri };
  } catch {
    return null;
  }
}

type PoolInfo = ReturnType<typeof LaunchpadPool.decode>;
type ConfigInfo = ReturnType<typeof LaunchpadConfig.decode>;
type PlatformInfo = ReturnType<typeof PlatformConfig.decode>;

interface QuoteRoute {
  asset: QuoteAsset;
  poolA: QuotePool | null;
}

interface PoolView {
  id: PublicKey;
  /** Token program of the launched mint (SPL, or Token-2022 on platforms that require it). */
  mintAProgram: PublicKey;
  pool: PoolInfo;
  config: ConfigInfo;
  platform: PlatformInfo;
  /** null = SOL quote. */
  route: QuoteRoute | null;
}

export interface LaunchLabAdapterOptions {
  connection: Connection;
  cluster: "mainnet-beta" | "devnet";
  defaultVault: Signer;
  vaults?: readonly Signer[];
  creators: CreatorKeyring;
  stateDir: string;
  /** Unzeen's own platform id (PDA of the partner key); null = not created on this network. */
  unzeenPlatform?: PublicKey | null;
  /** Non-SOL quotes served (with pool A, or stock-only). */
  quotes?: readonly QuoteAsset[];
  priorityMicroLamports?: number | PriorityPrice;
  pipeline?: TxPipeline | null;
  lookupTables?: LookupTables;
}

export class LaunchLabAdapter {
  readonly id = "raydium-launchlab" as const;
  readonly program: PublicKey;
  private readonly auth: PublicKey;
  private readonly connection: Connection;
  private readonly defaultVault: Signer;
  private readonly vaultKeys: Set<string>;
  private readonly creators: CreatorKeyring;
  private readonly priority: PriorityPrice;
  private readonly pipeline: TxPipeline | null;
  private readonly alts: LookupTables;
  private readonly platforms: Map<string, PublicKey>;
  private readonly configs: Map<string, PublicKey>; // quote mint -> GlobalConfig
  private readonly routes = new Map<string, QuoteRoute>(); // quote mint -> route
  private readonly routesBySymbol = new Map<string, QuoteRoute>();

  constructor(private readonly o: LaunchLabAdapterOptions) {
    this.program = LAUNCHLAB_PROGRAM[o.cluster];
    this.auth = getPdaLaunchpadAuth(this.program).publicKey;
    this.connection = o.connection;
    this.defaultVault = o.defaultVault;
    this.vaultKeys = new Set([o.defaultVault, ...(o.vaults ?? [])].map((v) => v.publicKey.toBase58()));
    this.creators = o.creators;
    const p = o.priorityMicroLamports ?? 0;
    this.priority = typeof p === "number" ? fixedPrice(p) : p;
    this.pipeline = o.pipeline ?? null;
    this.alts = o.lookupTables ?? new LookupTables(o.connection, o.stateDir, this.priority, this.pipeline);
    this.platforms = new Map(Object.entries(LAUNCHLAB_PLATFORMS[o.cluster]).map(([k, v]) => [k, new PublicKey(v)]));
    if (o.unzeenPlatform) this.platforms.set("unzeen", o.unzeenPlatform);
    this.configs = new Map(Object.entries(LAUNCHLAB_CONFIGS[o.cluster]).map(([k, v]) => [k, new PublicKey(v)]));
    for (const a of o.quotes ?? []) {
      if (!this.configs.has(a.mint.toBase58()) || (!a.poolA && !a.stockOnly)) continue;
      const r = { asset: a, poolA: makeQuotePool(o.connection, a) };
      this.routes.set(a.mint.toBase58(), r);
      this.routesBySymbol.set(a.symbol, r);
    }
  }

  /**
   * RELAYER v8 A1: compare every third-party platform with its pin (claim wallet, fee rates);
   * a missing or changed one is removed (its creates fail venue_unavailable). Returns warnings.
   */
  async checkPlatforms(): Promise<string[]> {
    const own = await this.checkOwnPlatform();
    const names = [...this.platforms.keys()].filter((n) => LAUNCHLAB_PLATFORM_PINS[n]);
    if (names.length === 0) return own;
    let accs: (AccountInfo<Buffer> | null)[];
    try {
      accs = await this.rpc(() => this.connection.getMultipleAccountsInfo(names.map((n) => this.platforms.get(n)!)));
    } catch (e) {
      // Fail closed: unverified third-party fee setups are not used.
      for (const n of names) this.platforms.delete(n);
      return [`LaunchLab platforms ${names.join(", ")} switched off: check failed (${e instanceof Error ? e.message.slice(0, 80) : "error"})`];
    }
    const warnings: string[] = [];
    names.forEach((n, i) => {
      const pin = LAUNCHLAB_PLATFORM_PINS[n]!;
      const acc = accs[i];
      let why: string | null = null;
      if (!acc || !acc.owner.equals(this.program)) why = "platform account not found";
      else {
        const p = PlatformConfig.decode(acc.data);
        if (p.platformClaimFeeWallet.toBase58() !== pin.claimWallet) why = `claim wallet changed to ${p.platformClaimFeeWallet.toBase58()}`;
        else if (Number(p.feeRate) !== pin.feeRate || Number(p.creatorFeeRate) !== pin.creatorFeeRate) why = `fee rates changed to ${p.feeRate.toString()} / ${p.creatorFeeRate.toString()}`;
      }
      if (why) {
        this.platforms.delete(n);
        warnings.push(`LaunchLab platform ${n} switched off: ${why}`);
      }
    });
    return [...own, ...warnings];
  }

  /**
   * Our own platform ("unzeen", PDA of the partner key) is served only once
   * `pnpm launchlab:platform --send` created it on this network (GAP-4): a missing
   * account switches it off (creates -> venue_unavailable instead of a failed tx).
   * An RPC error keeps it (our own config; the create tx would fail on chain anyway).
   */
  private async checkOwnPlatform(): Promise<string[]> {
    const id = this.platforms.get("unzeen");
    if (!id) return [];
    let acc: AccountInfo<Buffer> | null;
    try {
      acc = await this.rpc(() => this.connection.getAccountInfo(id));
    } catch {
      return [];
    }
    if (acc && acc.owner.equals(this.program)) return [];
    this.platforms.delete("unzeen");
    return ["LaunchLab platform unzeen switched off: not created on this network (pnpm launchlab:platform)"];
  }

  platformIds(): Record<string, string> {
    return Object.fromEntries([...this.platforms].map(([k, v]) => [k, v.toBase58()]));
  }

  // -------------------------------------------------------------------------
  // read side
  // -------------------------------------------------------------------------

  /** The mint's pool under any served quote: one read over every (mint, quote) PDA. */
  private async loadPool(mint: PublicKey): Promise<PoolView> {
    const quotes = [NATIVE_MINT, ...[...this.routes.values()].map((r) => r.asset.mint)];
    const ids = quotes.map((q) => getPdaLaunchpadPoolId(this.program, mint, q).publicKey);
    const accs = await this.rpc(() => this.connection.getMultipleAccountsInfo(ids));
    const i = accs.findIndex((a) => a?.owner.equals(this.program));
    if (i < 0) throw new AdapterError("not_found", `no LaunchLab pool for ${mint.toBase58()}`);
    const pool = LaunchpadPool.decode(accs[i]!.data);
    const [c, p, m] = await this.rpc(() => this.connection.getMultipleAccountsInfo([pool.configId, pool.platformId, mint]));
    if (!c || !p || !m) throw new AdapterError("venue_unavailable", "LaunchLab config / platform / mint not readable");
    const route = pool.mintB.equals(NATIVE_MINT) ? null : (this.routes.get(pool.mintB.toBase58()) ?? null);
    if (!pool.mintB.equals(NATIVE_MINT) && !route) throw new AdapterError("bad_request", "LaunchLab pool quoted in a token this pool does not serve");
    return { id: ids[i]!, mintAProgram: m.owner, pool, config: LaunchpadConfig.decode(c.data), platform: PlatformConfig.decode(p.data), route };
  }

  /** Quote pair of a mint's pool (null = SOL), for the relayer's vault choice. */
  async quotePairOf(mint: string): Promise<{ quoteMint: string; stockOnly: boolean } | null> {
    const v = await this.loadPool(parseMint(mint));
    return v.route ? { quoteMint: v.route.asset.mint.toBase58(), stockOnly: !v.route.poolA } : null;
  }

  quotePairFor(symbol: string): { quoteMint: string; stockOnly: boolean } | null {
    const r = this.routesBySymbol.get(symbol.toUpperCase()) ?? null;
    return r ? { quoteMint: r.asset.mint.toBase58(), stockOnly: !r.poolA } : null;
  }

  async status(mint: string): Promise<CurveStatus> {
    return llStatus((await this.loadPool(parseMint(mint))).pool);
  }

  async quote(mint: string, side: "buy" | "sell", amount: bigint): Promise<Quote> {
    if (amount <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    const v = await this.loadPool(parseMint(mint));
    const status = llStatus(v.pool);
    if (status === "graduated") throw new AdapterError("graduated", `${mint} has left the LaunchLab curve`);
    const slot = await this.rpc(() => this.connection.getSlot("confirmed"));
    const s = v.route?.poolA ? await v.route.poolA.load() : null;
    let amountOut: bigint;
    if (side === "buy") {
      const units = v.route?.poolA && s ? margin(v.route.poolA.quoteForSol(s, amount)) : amount;
      amountOut = buyOut(v, units, slot);
    } else {
      const units = sellOut(v, amount, slot);
      amountOut = v.route?.poolA && s ? v.route.poolA.solForQuote(s, units) : units;
    }
    const m = this.marketOf(v, s);
    return { venue: this.id, mint, side, amountIn: amount, amountOut, priceSol: m.priceSol, marketCapSol: m.marketCapSol, status, decimals: v.pool.mintDecimalsA, ...(v.route ? { quoteMint: v.route.asset.mint.toBase58(), priceQuote: m.priceQuote } : {}) };
  }

  async market(mint: string): Promise<{ priceSol: string; marketCapSol: string; status: CurveStatus; priceQuote?: string }> {
    const v = await this.loadPool(parseMint(mint));
    const s = v.route?.poolA ? await v.route.poolA.load() : null;
    const m = this.marketOf(v, s);
    return { priceSol: m.priceSol, marketCapSol: m.marketCapSol, status: llStatus(v.pool), ...(v.route ? { priceQuote: m.priceQuote } : {}) };
  }

  /** Spot price / cap in SOL (quote pairs: converted on pool A; stock-only quotes: "0", core prices them). */
  private marketOf(v: PoolView, s: unknown | null): { priceSol: string; marketCapSol: string; priceQuote: string } {
    const qd = v.pool.mintDecimalsB;
    const price = Curve.getPrice({ poolInfo: v.pool, curveType: v.config.curveType, decimalA: v.pool.mintDecimalsA, decimalB: qd });
    const price18 = BigInt(price.mul(1e18).toFixed(0));
    const capUnits = (price18 * toBig(v.pool.supply) * 10n ** BigInt(qd)) / (10n ** BigInt(v.pool.mintDecimalsA) * 10n ** 18n);
    const priceQuote = formatUnits(price18, 18);
    if (!v.route) return { priceSol: priceQuote, marketCapSol: formatUnits(capUnits, 9), priceQuote };
    if (!v.route.poolA || !s) return { priceSol: "0", marketCapSol: "0", priceQuote };
    const perQuote = v.route.poolA.solForQuote(s, 10n ** BigInt(qd));
    return {
      priceSol: formatUnits((price18 * perQuote) / 10n ** BigInt(9), 18),
      marketCapSol: formatUnits((capUnits * perQuote) / 10n ** BigInt(qd), 9),
      priceQuote,
    };
  }

  async tokenSymbol(mint: string): Promise<string | null> {
    const pk = parseMint(mint);
    const md = await this.rpc(() => this.connection.getAccountInfo(getPdaMetadataKey(pk).publicKey)).catch(() => null);
    if (md) return parseMetaplexMetadata(md.data)?.symbol ?? null;
    // Token-2022 launches (stonk.fun) carry on-mint metadata.
    return (await getTokenMetadata(this.connection, pk, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null))?.symbol ?? null;
  }

  // -------------------------------------------------------------------------
  // write side
  // -------------------------------------------------------------------------

  /**
   * initialize_v2 + first buy_exact_in in ONE tx. Platform: `opts.platform`
   * ("stonk" | "bonk" | "unzeen"; default "unzeen"); quote: `opts.quote` (default SOL).
   */
  async prepareCreate(meta: TokenMeta, initialBuy: bigint, minOut: bigint, opts: CreateOptions = {}): Promise<PreparedCreate> {
    validateMeta(meta);
    if (Buffer.byteLength(meta.symbol, "utf8") > 10) throw new AdapterError("bad_request", "symbol: at most 10 bytes on LaunchLab");
    if (initialBuy < 0n || minOut < 0n) throw new AdapterError("bad_request", "amounts must be >= 0");
    if (opts.mintKeypair) throw new AdapterError("bad_request", "fair launch is pump.fun / SOL only");
    const vault = opts.vault ?? this.defaultVault;
    const platformName = (opts.platform ?? "unzeen").toLowerCase();
    const platformId = this.platforms.get(platformName);
    if (!platformId) throw new AdapterError("venue_unavailable", `LaunchLab platform ${platformName} not available on this network`);
    const route = opts.quote && opts.quote.toUpperCase() !== "SOL" ? this.routesBySymbol.get(opts.quote.toUpperCase()) ?? null : null;
    if (opts.quote && opts.quote.toUpperCase() !== "SOL" && !route) throw new AdapterError("venue_unavailable", `LaunchLab quote ${opts.quote} not served on this network`);
    const mintB = route ? route.asset.mint : NATIVE_MINT;
    const configId = this.configs.get(mintB.toBase58());
    if (!configId) throw new AdapterError("venue_unavailable", "no LaunchLab GlobalConfig for this quote");
    const [cAcc, pAcc] = await this.rpc(() => this.connection.getMultipleAccountsInfo([configId, platformId]));
    if (!cAcc || !pAcc) throw new AdapterError("venue_unavailable", "LaunchLab config / platform not found");
    const config = LaunchpadConfig.decode(cAcc.data);
    const platform = PlatformConfig.decode(pAcc.data);
    if (config.curveType !== 0) throw new AdapterError("venue_unavailable", "only constant-product LaunchLab configs");

    const quoteDecimals = route ? route.asset.decimals : 9;
    const supply = new BN(LAUNCH_SUPPLY.toString());
    const totalSellA = new BN(LAUNCH_TOTAL_SELL.toString());
    const totalFundRaisingB = new BN(fundRaisingFor(route ? route.asset : { mint: NATIVE_MINT, decimals: 9 }).toString());
    try {
      Curve.checkParam({ supply, totalFundRaising: totalFundRaisingB, totalSell: totalSellA, totalLockedAmount: new BN(0), decimals: 6, config, migrateType: "cpmm" });
    } catch (e) {
      throw new AdapterError("venue_unavailable", `LaunchLab config rejects the launch parameters: ${e instanceof Error ? e.message : "?"}`);
    }
    // Platforms with restrictCurveParam (stonk.fun): our parameters must match one rule group.
    // The only free choice we make is the base token program: SPL first, Token-2022 if the rule wants it
    // (stonk.fun's SOL rule, 13.10: BaseTokenProgram Eq Token2022, everything else = our defaults).
    let ruleId: PublicKey | undefined;
    let token2022 = false;
    if (platform.restrictCurveParam) {
      ruleId = getPdaPlatformCurveRule(this.program, platformId, configId).publicKey;
      const r = await this.rpc(() => this.connection.getAccountInfo(ruleId!));
      if (r) {
        const rule = PlatformCurveRule.decode(r.data) as unknown as Parameters<typeof checkLaunchAgainstCurveRule>[0]["rule"];
        const check = (base: number) =>
          checkLaunchAgainstCurveRule({
            rule,
            context: {
              curveType: 0, migrateType: 1, migrateCpmmFeeOn: CpmmCreatorFeeOn.OnlyTokenB, supply, totalSellA, totalFundRaisingB, totalLockedAmount: new BN(0),
              cliffPeriod: new BN(0), unlockPeriod: new BN(0), baseTokenProgram: base, unixTimestamp: new BN(Math.floor(Date.now() / 1000)),
            },
          });
        const spl = check(LaunchpadCurveRuleBaseTokenProgram.SplToken);
        if (!spl.ok) {
          const t22 = check(LaunchpadCurveRuleBaseTokenProgram.Token2022);
          if (!t22.ok) {
            const why = spl.groupFailures.map((g) => `group ${g.groupId}: ${g.unsatisfied.map((u) => `field ${u.field} op ${u.op} ${u.value.toString()} (ours ${u.actual?.toString() ?? "?"})`).join(", ")}`).join("; ");
            throw new AdapterError("venue_unavailable", `platform ${platformName} curve rule rejects the launch: ${why}`.slice(0, 400));
          }
          token2022 = true;
        }
      }
    }
    const mintAProgram = token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    // First buy: SOL directly (wSOL ATA filled and closed in the tx), or quote units from the stock / leg.
    let units = initialBuy;
    let leg: unknown | null = null;
    let quoteSource: "stock" | "leg" | undefined;
    if (route && initialBuy > 0n) {
      if (!route.poolA) {
        quoteSource = "stock";
        if ((await this.quoteStock(vault.publicKey, route)) < units) throw new AdapterError("insufficient_sol", `vault's ${route.asset.symbol} stock is short`);
      } else {
        const s = await route.poolA.load();
        units = margin(route.poolA.quoteForSol(s, initialBuy));
        if (units <= 0n) throw new AdapterError("slippage", "first buy too small for the quote token");
        quoteSource = (await this.quoteStock(vault.publicKey, route)) >= units ? "stock" : "leg";
        if (quoteSource === "leg") leg = s;
      }
    }
    await this.requireSol(vault.publicKey, (route ? (leg ? initialBuy : 0n) : initialBuy) + CREATE_RENT_HEADROOM + ALT_RENT_HEADROOM);

    const creatorIndex = opts.creatorIndex ?? (await this.creators.allocate());
    const creator = this.creators.publicKey(creatorIndex); // recorded in creator-pubkeys.json first (T1)
    if (this.vaultKeys.has(creator.toBase58())) throw new AdapterError("internal", "creator collides with a vault");
    const mintKp = Keypair.generate();

    const fresh = freshPool(config, totalFundRaisingB);
    const slot = await this.rpc(() => this.connection.getSlot("confirmed"));
    const expected = units > 0n ? swapOut("buy", fresh, config, platform, units, slot) : 0n;
    if (expected < minOut) throw new AdapterError("slippage", `first buy quote ${expected} < minOut ${minOut}`);

    const build = async (mintA: PublicKey, payer: PublicKey, creatorPk: PublicKey): Promise<TransactionInstruction[]> => {
      const poolId = getPdaLaunchpadPoolId(this.program, mintA, mintB).publicKey;
      const vaultA = getPdaLaunchpadVaultId(this.program, poolId, mintA).publicKey;
      const vaultB = getPdaLaunchpadVaultId(this.program, poolId, mintB).publicKey;
      const curveParam = { type: "ConstantCurve" as const, totalSellA, migrateType: "cpmm" as const, supply, totalFundRaisingB };
      const ixs: TransactionInstruction[] = [
        token2022
          ? initializeWithToken2022(
              this.program, payer, creatorPk, configId, platformId, this.auth, poolId, mintA, mintB, vaultA, vaultB,
              TOKEN_PROGRAM_ID, 6, meta.name, meta.symbol, meta.uri, curveParam,
              new BN(0), new BN(0), new BN(0), CpmmCreatorFeeOn.OnlyTokenB, undefined, undefined, ruleId,
            )
          : initializeV2(
              this.program, payer, creatorPk, configId, platformId, this.auth, poolId, mintA, mintB, vaultA, vaultB,
              getPdaMetadataKey(mintA).publicKey, TOKEN_PROGRAM_ID, 6, meta.name, meta.symbol, meta.uri, curveParam,
              new BN(0), new BN(0), new BN(0), CpmmCreatorFeeOn.OnlyTokenB, undefined, ruleId,
            ),
      ];
      if (units > 0n) {
        const pre = leg && route?.poolA ? await route.poolA.buyQuoteExactOut(payer, leg, units, initialBuy) : [];
        ixs.push(...pre, ...this.buyIxs({ payer, poolId, mintA, mintB, vaultA, vaultB, configId, platformId, creator: creatorPk, units, minOut: minOut > 0n ? minOut : 1n, sol: !route, mintAProgram }));
      }
      return ixs;
    };
    const ixs = await build(mintKp.publicKey, vault.publicKey, creator);
    const table = await this.lookupTable(vault, ixs, build);
    const signed = await this.sign(ixs, vault, route ? CU_LL_CREATE_QUOTE : CU_LL_CREATE, [mintKp], [table]);
    return {
      ...signed,
      kind: "create",
      mint: mintKp.publicKey.toBase58(),
      vault: vault.publicKey.toBase58(),
      creator: creator.toBase58(),
      creatorIndex,
      expectedOut: expected,
      ...(route ? { quoteMint: route.asset.mint.toBase58(), quoteUnits: units, ...(quoteSource ? { quoteSource } : {}) } : {}),
    };
  }

  async prepareBuy(mint: string, amountIn: bigint, minOut: bigint, opts: TradeOptions = {}): Promise<PreparedTrade> {
    if (amountIn <= 0n || minOut < 0n) throw new AdapterError("bad_request", "bad buy amounts");
    const vault = opts.vault ?? this.defaultVault;
    const mintA = parseMint(mint);
    const v = await this.loadPool(mintA);
    if (llStatus(v.pool) === "graduated") throw new AdapterError("graduated", `${mint} has left the LaunchLab curve`);
    let units = amountIn;
    let pre: TransactionInstruction[] = [];
    let quoteSource: "stock" | "leg" | undefined;
    if (v.route) {
      if (!v.route.poolA) {
        quoteSource = "stock"; // stock-only quote: `amountIn` IS quote units
        if ((await this.quoteStock(vault.publicKey, v.route)) < units) throw new AdapterError("insufficient_sol", `vault's ${v.route.asset.symbol} stock is short`);
      } else {
        const s = await v.route.poolA.load();
        units = margin(v.route.poolA.quoteForSol(s, amountIn));
        if (units <= 0n) throw new AdapterError("slippage", "buy too small for the quote token");
        quoteSource = (await this.quoteStock(vault.publicKey, v.route)) >= units ? "stock" : "leg";
        if (quoteSource === "leg") pre = await v.route.poolA.buyQuoteExactOut(vault.publicKey, s, units, amountIn);
      }
    }
    const slot = await this.rpc(() => this.connection.getSlot("confirmed"));
    const expected = swapOut("buy", v.pool, v.config, v.platform, units, slot);
    if (expected < minOut) throw new AdapterError("slippage", `quote ${expected} < minOut ${minOut}`);
    await this.requireSol(vault.publicKey, (v.route ? (quoteSource === "leg" ? amountIn : 0n) : amountIn) + BUY_RENT_HEADROOM);
    const ixs = [
      ...pre,
      ...this.buyIxs({
        payer: vault.publicKey, poolId: v.id, mintA, mintB: v.pool.mintB, vaultA: v.pool.vaultA, vaultB: v.pool.vaultB, configId: v.pool.configId,
        platformId: v.pool.platformId, creator: v.pool.creator, units, minOut: minOut > 0n ? minOut : 1n, sol: !v.route, mintAProgram: v.mintAProgram,
      }),
    ];
    const signed = await this.sign(ixs, vault, v.route ? CU_LL_TRADE_QUOTE : CU_LL_TRADE);
    return { ...signed, kind: "buy", mint, vault: vault.publicKey.toBase58(), expectedOut: expected, ...(v.route ? { quoteMint: v.route.asset.mint.toBase58(), quoteUnits: units, ...(quoteSource ? { quoteSource } : {}) } : {}) };
  }

  async prepareSell(mint: string, amount: bigint, minOutLamports: bigint, opts: TradeOptions = {}): Promise<PreparedTrade> {
    if (amount <= 0n || minOutLamports < 0n) throw new AdapterError("bad_request", "bad sell amounts");
    const vault = opts.vault ?? this.defaultVault;
    const mintA = parseMint(mint);
    const v = await this.loadPool(mintA);
    if (llStatus(v.pool) === "graduated") throw new AdapterError("graduated", `${mint} has left the LaunchLab curve`);
    const ata = getAssociatedTokenAddressSync(mintA, vault.publicKey, true, v.mintAProgram);
    const info = await this.rpc(() => this.connection.getAccountInfo(ata));
    const held = info ? unpackAccount(ata, info, v.mintAProgram).amount : 0n;
    if (held < amount) throw new AdapterError("insufficient_tokens", `vault holds ${held} < ${amount}`);
    const slot = await this.rpc(() => this.connection.getSlot("confirmed"));
    const outUnits = swapOut("sell", v.pool, v.config, v.platform, amount, slot);
    let expected = outUnits;
    let minUnits = minOutLamports;
    if (v.route?.poolA) {
      const s = await v.route.poolA.load();
      expected = v.route.poolA.solForQuote(s, outUnits);
      minUnits = minOutLamports > 0n ? v.route.poolA.quoteForSol(s, minOutLamports) : 0n;
    } // stock-only: min out already in quote units
    if (expected < minOutLamports) throw new AdapterError("slippage", `quote ${expected} < minOut ${minOutLamports}`);
    await this.requireSol(vault.publicKey, 2_100_000n);
    const sol = !v.route;
    const userB = getAssociatedTokenAddressSync(v.pool.mintB, vault.publicKey, true, TOKEN_PROGRAM_ID);
    const ixs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(vault.publicKey, userB, vault.publicKey, v.pool.mintB, TOKEN_PROGRAM_ID),
      sellExactInInstruction(
        this.program, vault.publicKey, this.auth, v.pool.configId, v.pool.platformId, v.id, ata, userB, v.pool.vaultA, v.pool.vaultB, mintA, v.pool.mintB,
        v.mintAProgram, TOKEN_PROGRAM_ID, getPdaPlatformVault(this.program, v.pool.platformId, v.pool.mintB).publicKey,
        getPdaCreatorVault(this.program, v.pool.creator, v.pool.mintB).publicKey, toBN(amount), toBN(minUnits),
      ),
      // SOL quote: unwrap the proceeds (non-SOL proceeds stay as quote STOCK).
      ...(sol ? [createCloseAccountInstruction(userB, vault.publicKey, vault.publicKey)] : []),
    ];
    const signed = await this.sign(ixs, vault, v.route ? CU_LL_TRADE_QUOTE : CU_LL_TRADE);
    return { ...signed, kind: "sell", mint, vault: vault.publicKey.toBase58(), expectedOut: expected, ...(v.route ? { quoteMint: v.route.asset.mint.toBase58() } : {}) };
  }

  /** ATA for the token, quote account (wSOL filled + closed for SOL), buy_exact_in. */
  private buyIxs(a: {
    payer: PublicKey; poolId: PublicKey; mintA: PublicKey; mintB: PublicKey; vaultA: PublicKey; vaultB: PublicKey; configId: PublicKey;
    platformId: PublicKey; creator: PublicKey; units: bigint; minOut: bigint; sol: boolean; mintAProgram: PublicKey;
  }): TransactionInstruction[] {
    const userA = getAssociatedTokenAddressSync(a.mintA, a.payer, true, a.mintAProgram);
    const userB = getAssociatedTokenAddressSync(a.mintB, a.payer, true, TOKEN_PROGRAM_ID);
    return [
      createAssociatedTokenAccountIdempotentInstruction(a.payer, userA, a.payer, a.mintA, a.mintAProgram),
      createAssociatedTokenAccountIdempotentInstruction(a.payer, userB, a.payer, a.mintB, TOKEN_PROGRAM_ID),
      ...(a.sol ? [SystemProgram.transfer({ fromPubkey: a.payer, toPubkey: userB, lamports: a.units }), createSyncNativeInstruction(userB)] : []),
      buyExactInInstruction(
        this.program, a.payer, this.auth, a.configId, a.platformId, a.poolId, userA, userB, a.vaultA, a.vaultB, a.mintA, a.mintB,
        a.mintAProgram, TOKEN_PROGRAM_ID, getPdaPlatformVault(this.program, a.platformId, a.mintB).publicKey,
        getPdaCreatorVault(this.program, a.creator, a.mintB).publicKey, toBN(a.units), toBN(a.minOut),
      ),
      ...(a.sol ? [createCloseAccountInstruction(userB, a.payer, a.payer)] : []),
    ];
  }

  async submit(p: SignedTx): Promise<{ signature: string; slot: number }> {
    try {
      return await broadcastAndConfirm(this.connection, p, this.pipeline?.broadcaster);
    } catch (e) {
      throw this.sendError(e);
    }
  }

  // -------------------------------------------------------------------------
  // results
  // -------------------------------------------------------------------------

  async createResult(signature: string, vault: string): Promise<CreateResult | null> {
    const tx = await fetchTx(this.connection, signature, 10).catch(() => null);
    if (!tx) return null;
    const created = anchorEventPayloads(tx, this.program, POOL_CREATE_EVENT).map(decodePoolCreateEvent).find((e) => e !== null);
    if (!created) return null;
    const poolAcc = await this.rpc(() => this.connection.getAccountInfo(created.pool)).catch(() => null);
    if (!poolAcc) return null;
    const pool = LaunchpadPool.decode(poolAcc.data);
    const trade = anchorEventPayloads(tx, this.program, TRADE_EVENT).map(decodeTradeEvent).find((e) => e?.pool.equals(created.pool));
    let tokenAmount = 0n;
    let solAmount = 0n;
    let creatorFee: bigint | null = 0n;
    let quote: Pick<TxResult, "quoteMint" | "quoteAmount" | "quoteSource" | "lamportsByCore"> = {};
    const route = pool.mintB.equals(NATIVE_MINT) ? null : (this.routes.get(pool.mintB.toBase58()) ?? null);
    // No first buy: the pair is still the curve's (tokens.quote_mint, RELAYER v8), 0 units moved.
    if (route) quote = { quoteMint: route.asset.mint.toBase58(), quoteAmount: 0n, ...(route.poolA ? {} : { lamportsByCore: true as const }) };
    if (trade) {
      tokenAmount = trade.amountOut;
      const units = trade.amountIn;
      creatorFee = trade.creatorFee;
      if (route) {
        const conv = await this.toLamports(tx, route, units, "buy").catch(() => null);
        if (!conv) return null;
        // RELAYER v9 §4: ZEC launch -> creator fee in ZEC SPL units as is; USDC/USD1 -> lamport equivalent.
        if (!conv.byCore) creatorFee = units > 0n ? (conv.lamports * creatorFee) / units : 0n;
        solAmount = conv.lamports;
        quote = { quoteMint: route.asset.mint.toBase58(), quoteAmount: units, quoteSource: conv.source, ...(conv.byCore ? { lamportsByCore: true as const } : {}) };
      } else solAmount = units;
    }
    return {
      venue: this.id,
      kind: "create",
      signature,
      slot: tx.slot,
      mint: pool.mintA.toBase58(),
      vault,
      creator: created.creator.toBase58(),
      name: created.name,
      symbol: created.symbol,
      uri: created.uri,
      tokenProgram: (Number(pool.mintProgramFlag) & 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID).toBase58(),
      tokenAmount,
      solAmount,
      networkFee: BigInt(tx.meta?.fee ?? 0),
      blockTime: tx.blockTime ?? null,
      decimals: pool.mintDecimalsA,
      amountsKnown: true,
      fromEvent: trade !== undefined,
      creatorFee,
      ...quote,
    };
  }

  async tradeResult(kind: "buy" | "sell", signature: string, vault: string, mint: string): Promise<TxResult | null> {
    const tx = await fetchTx(this.connection, signature, 10).catch(() => null);
    if (!tx) return null;
    const v = await this.loadPool(parseMint(mint));
    const ev = anchorEventPayloads(tx, this.program, TRADE_EVENT).map(decodeTradeEvent).find((e) => e?.pool.equals(v.id));
    if (!ev) return null; // never guess from deltas (wSOL / quote stock move too)
    const tokenAmount = kind === "buy" ? ev.amountOut : ev.amountIn;
    const units = kind === "buy" ? ev.amountIn : ev.amountOut;
    let solAmount = units;
    let quote: Pick<TxResult, "quoteMint" | "quoteAmount" | "quoteSource" | "lamportsByCore"> = {};
    if (v.route) {
      const conv = await this.toLamports(tx, v.route, units, kind).catch(() => null);
      if (!conv) return null;
      solAmount = conv.lamports;
      quote = { quoteMint: v.route.asset.mint.toBase58(), quoteAmount: units, ...(kind === "buy" ? { quoteSource: conv.source } : {}), ...(conv.byCore ? { lamportsByCore: true as const } : {}) };
    }
    return {
      venue: this.id,
      kind,
      signature,
      slot: tx.slot,
      mint,
      vault,
      tokenAmount,
      solAmount,
      networkFee: BigInt(tx.meta?.fee ?? 0),
      blockTime: tx.blockTime ?? null,
      decimals: v.pool.mintDecimalsA,
      amountsKnown: true,
      fromEvent: true,
      ...quote,
    };
  }

  /** Same rules as DBC / pump.fun (src/pool-a.ts). */
  private async toLamports(tx: VersionedTransactionResponse, route: QuoteRoute, units: bigint, kind: "buy" | "sell"): Promise<{ lamports: bigint; source: "stock" | "leg"; byCore?: true }> {
    if (!route.poolA) return { lamports: 0n, source: "stock", byCore: true };
    if (kind === "buy") {
      const leg = route.poolA.legs(tx).find((l) => l.buy && l.outputAmount > 0n);
      if (leg) return { lamports: (leg.inputAmount * units) / leg.outputAmount, source: "leg" };
      const s = await route.poolA.load();
      return { lamports: route.poolA.solForExactQuote(s, units), source: "stock" };
    }
    const s = await route.poolA.load();
    return { lamports: route.poolA.solForQuote(s, units), source: "stock" };
  }

  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    return classifyError(err, logs, [], this.program.toBase58(), {}, "launchlab");
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async quoteStock(vault: PublicKey, route: QuoteRoute): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(route.asset.mint, vault, true, route.asset.tokenProgram);
    const info = await this.rpc(() => this.connection.getAccountInfo(ata, "confirmed"));
    return info ? unpackAccount(ata, info, route.asset.tokenProgram).amount : 0n;
  }

  private async requireSol(vault: PublicKey, need: bigint): Promise<void> {
    const bal = BigInt(await this.rpc(() => this.connection.getBalance(vault, "confirmed")));
    if (bal < need + FEE_HEADROOM) throw new AdapterError("insufficient_sol", `vault has ${bal} lamports, needs ~${need + FEE_HEADROOM}`);
  }

  private async lookupTable(vault: Signer, ixs: TransactionInstruction[], build: (m: PublicKey, p: PublicKey, c: PublicKey) => Promise<TransactionInstruction[]>): Promise<AddressLookupTableAccount> {
    // Stable across this vault's launches: everything but the mint / creator side. The table is the
    // vault's own, so its ATAs (wSOL, quote) belong in it, and so do the Sender tip accounts
    // (added by signTx, not in `ixs`). 13.10 local run: USD1 create + CLMM leg with 32/10/80-byte
    // metadata was 1233+ B without these (limit 1232), see scripts/launchlab-leg-local.ts.
    const r = () => Keypair.generate().publicKey;
    const other = await build(r(), vault.publicKey, r());
    try {
      return await this.alts.ensure(vault, [...staticAccounts(ixs, other), ...(this.pipeline?.tip?.accounts ?? [])]);
    } catch (e) {
      throw this.classify(e);
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
      if (!lookupTables && isSendFailure(e) && (e as SendFailure).stage === "build") {
        // Too large as legacy: retry as v0 with the vault's lookup table.
        const table = await this.alts.ensure(payer, staticAccounts(ixs, ixs)).catch((err) => {
          throw this.classify(err);
        });
        return this.sign(ixs, payer, cu, extra, [table]);
      }
      throw this.sendError(e);
    }
  }

  private sendError(e: unknown): AdapterError {
    if (!isSendFailure(e)) return e instanceof AdapterError ? e : this.classify(e);
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

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** status 0 = trading on the curve; 1 migrating / 2 migrated = graduated. */
export function llStatus(pool: Pick<PoolInfo, "status">): CurveStatus {
  return Number(pool.status) === 0 ? "curve" : "graduated";
}

function margin(units: bigint): bigint {
  return (units * (10_000n - QUOTE_MARGIN_BPS)) / 10_000n;
}

/** Curve math of the SDK (local): tokens out for `amount` quote (buy) or quote out for `amount` tokens (sell). */
export function swapOut(side: "buy" | "sell", pool: PoolInfo, config: Pick<ConfigInfo, "tradeFeeRate" | "curveType">, platform: Pick<PlatformInfo, "feeRate" | "creatorFeeRate">, amount: bigint, slot: number): bigint {
  const common = {
    poolInfo: pool,
    protocolFeeRate: config.tradeFeeRate,
    platformFeeRate: platform.feeRate,
    curveType: config.curveType,
    shareFeeRate: new BN(0),
    creatorFeeRate: platform.creatorFeeRate,
    transferFeeConfigA: undefined,
    transferFeeConfigB: undefined,
    slot,
  };
  if (side === "buy") {
    const r = Curve.buyExactIn({ ...common, amountB: toBN(amount) });
    return toBig(r.amountA.amount) - toBig(r.amountA.fee ?? new BN(0));
  }
  const r = Curve.sellExactIn({ ...common, amountA: toBN(amount) });
  return toBig(r.amountB);
}

/** The pool right after initialize_v2 with our launch parameters (same as the SDK's createLaunchpad). */
export function freshPool(config: Pick<ConfigInfo, "migrateFee">, totalFundRaisingB: BN): PoolInfo {
  const supply = new BN(LAUNCH_SUPPLY.toString());
  const totalSellA = new BN(LAUNCH_TOTAL_SELL.toString());
  const init = Curve.getCurve(0).getInitParam({ supply, totalFundRaising: totalFundRaisingB, totalSell: totalSellA, totalLockedAmount: new BN(0), migrateFee: config.migrateFee });
  return { virtualA: init.a, virtualB: init.b, realA: new BN(0), realB: new BN(0), totalSellA, totalFundRaisingB, supply, status: 0 } as unknown as PoolInfo;
}

function buyOut(v: PoolView, units: bigint, slot: number): bigint {
  return swapOut("buy", v.pool, v.config, v.platform, units, slot);
}
function sellOut(v: PoolView, amount: bigint, slot: number): bigint {
  return swapOut("sell", v.pool, v.config, v.platform, amount, slot);
}

/** SPL mint decimals (LaunchLab mints are SPL Token, 6 decimals). */
export function mintDecimals(info: AccountInfo<Buffer>, mint: PublicKey): number {
  return unpackMint(mint, info, info.owner).decimals;
}

export function launchLabCluster(c: SolanaCluster): "mainnet-beta" | "devnet" | null {
  return c === "mainnet-beta" || c === "devnet" ? c : null;
}
