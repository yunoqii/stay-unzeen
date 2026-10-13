import {
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurveMarketCap,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  getBuyV3TokenAmountFromQuoteAmount,
  getSellSolAmountFromTokenAmount,
  isBondingCurveMigrated,
  isLegacyQuoteMint,
  normalizeQuoteMint,
  pumpIdl,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from "@pump-fun/pump-sdk";
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
  Keypair,
  PublicKey,
  type VersionedTransactionResponse,
  type AddressLookupTableAccount,
  type Connection,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";
import { LookupTables, staticAccounts } from "./alt";
import { AdapterError, classifyError, type ProgramErrorInfo } from "./errors";
import { extractCreateEvents, extractTradeEvents, lamportDelta, tokenDelta } from "./events";
import type { CreatorKeyring } from "./keys";
import { formatUnits, spotPriceSol, toBN, toBig } from "./math";
import { fixedPrice, type PriorityPrice } from "./fees";
import type { TxPipeline } from "./sender";
import { quoteFairLegs, quoteFreshBuy, splitMinOut } from "./fair-bundle";
import { makeQuotePool, type QuoteAsset, type QuotePool } from "./pool-a";
import { broadcastAndConfirm, fetchTx, isSendFailure, signTx, type SendFailure, type SenderTip, type SignedTx } from "./tx";
import type {
  CreateOptions,
  CurveStatus,
  LaunchpadAdapter,
  Quote,
  TokenMeta,
  TradeOptions,
  TxResult,
} from "./types";

/** Compute budgets (README of pump-sdk 4.0.0: ~500k create+buy, 250-300k trades). */
const CU_CREATE = 500_000;
const CU_TRADE = 300_000;
/** Network fee headroom for one transaction, lamports. */
const FEE_HEADROOM = 100_000n;
/** First buy of a vault on a mint also funds its user_volume_accumulator. */
const ACCUMULATOR_RENT_HEADROOM = 2_000_000n;
/** create_v2: mint (Token-2022 + metadata), curve, curve ATA, vault ATA. */
const CREATE_RENT_HEADROOM = 15_000_000n;
/** First create of a vault also creates its address lookup table. */
const ALT_RENT_HEADROOM = 10_000_000n;
/** Global / FeeConfig rarely change; cache them briefly. */
const PARAMS_TTL_MS = 30_000;
/**
 * Non-SOL pairs: ONE fixed limit per class, stock or in-tx leg alike (no CU
 * fingerprint of the path; the DAMM v2 leg is 25-47k CU).
 */
export const CU_CREATE_PUMP_QUOTE = 600_000;
export const CU_TRADE_PUMP_QUOTE = 400_000;
/** Lamports -> quote margin for pool A drift between quote and landing. */
const PUMP_QUOTE_MARGIN_BPS = 50n;
/**
 * Creator fee rate set explicitly for QuoteControl quotes (pump lets 1-300 bps):
 * the same 30 bps core already assumes for pump.fun launches (UNZEEN_LAUNCH_CREATOR_FEE_BPS_PUMP).
 */
export const PUMP_QUOTE_CREATOR_FEE_BPS = 30;

interface PumpQuoteRoute {
  asset: QuoteAsset;
  /** null = stock-only quote (ZEC): amounts are quote units, no leg, no SOL valuation here. */
  poolA: QuotePool | null;
}

/** Pool A of a priced route (callers check `stockOnly` first). */
function pa(r: PumpQuoteRoute): QuotePool {
  if (!r.poolA) throw new AdapterError("internal", "stock-only quote has no pool A");
  return r.poolA;
}

const PUMP_ERRORS: readonly ProgramErrorInfo[] = (pumpIdl.errors as ReadonlyArray<{ code: number; name: string }>).map(
  (e) => ({ code: e.code, name: e.name }),
);

export interface PumpFunAdapterOptions {
  connection: Connection;
  /** Vault used when a call does not pass `opts.vault`. */
  defaultVault: Signer;
  /** All pool vaults: creator addresses are checked against them. */
  vaults?: readonly Signer[];
  creators: CreatorKeyring;
  /** Where per-vault lookup table addresses are remembered (e.g. keys dir). */
  stateDir: string;
  /** Pool-wide compute unit price (src/fees.ts cache); a number = fixed. Read at signing, never estimated per tx. */
  priorityMicroLamports?: number | PriorityPrice;
  /** Pool tip + broadcaster (src/sender.ts): the same tip on EVERY pool tx. Default plain RPC, no tip. */
  pipeline?: TxPipeline | null;
  /**
   * Shared per-vault lookup tables (one instance for every venue adapter, so
   * pump.fun and Meteora never extend the same table from stale caches).
   */
  lookupTables?: LookupTables;
  /** Non-SOL quotes this adapter serves (pump's own set, `quoteAssets(.., "pumpfun")`); only those with a pool A. */
  quotes?: readonly QuoteAsset[];
}

interface MintInfo {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
}

/**
 * A signed, not yet broadcast trade. The relayer persists `signature` +
 * `lastValidBlockHeight` BEFORE calling `submit`, so a retry can always check
 * whether this exact transaction landed (no double buy).
 */
export interface PreparedTrade extends SignedTx {
  kind: "buy" | "sell";
  mint: string;
  vault: string;
  /** Venue quote at preparation time (tokens for buy, lamports for sell). */
  expectedOut: bigint;
  /** Non-SOL pair (DBC quote configs): quote mint, units spent (buy) and where they came from. */
  quoteMint?: string;
  quoteUnits?: bigint;
  quoteSource?: "stock" | "leg";
}

/** A signed, not yet broadcast create (+ first buy). */
export interface PreparedCreate extends SignedTx {
  kind: "create";
  /** New mint (its key signed this tx and is then discarded). */
  mint: string;
  vault: string;
  /** Fresh creator address of this launch and its HD index (fees later). */
  creator: string;
  creatorIndex: number;
  /** Tokens the first buy is quoted to get (0 without first buy). */
  expectedOut: bigint;
  quoteMint?: string;
  quoteUnits?: bigint;
  quoteSource?: "stock" | "leg";
}

/** Executed create, read from the landed transaction. */
export interface CreateResult extends TxResult {
  kind: "create";
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  tokenProgram: string;
  /**
   * RELAYER v6 `out_creator_fee`: creator fee generated by this launch tx (pump:
   * TradeEvent.creatorFee of the first buy; DBC: creator share of the trading
   * fee). 0 without a first buy; undefined/null = unknown (core estimates).
   */
  creatorFee?: bigint | null;
}

/** One signed leg of a fair-launch bundle (legs[0] = create + first buy). */
export interface PreparedFairLeg extends SignedTx {
  vault: string;
  lamports: bigint;
  /** Tokens quoted on the simulated fresh curve. */
  expectedOut: bigint;
  /** min_tokens_out of this leg (core's min_out split pro rata). */
  minOut: bigint;
}

/** A signed, not yet broadcast fair-launch bundle: all legs share one blockhash. */
export interface PreparedFairBundle {
  kind: "fair_bundle";
  mint: string;
  creator: string;
  creatorIndex: number;
  legs: PreparedFairLeg[];
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Executed bundle leg (a buy of the new mint by a pool vault). */
export interface FairLegResult extends TxResult {
  /** TradeEvent.creatorFee of this buy (v3 keeps it on the curve until swept); null = unknown. */
  creatorFee: bigint | null;
}

interface CurveState extends MintInfo {
  bondingCurve: BondingCurve;
  curveBaseTokenBalance: bigint;
  /** null = SOL curve. */
  route: PumpQuoteRoute | null;
}

export class PumpFunAdapter implements LaunchpadAdapter {
  readonly id = "pumpfun" as const;
  private readonly connection: Connection;
  private readonly online: OnlinePumpSdk;
  private readonly defaultVault: Signer;
  private readonly vaultKeys: Set<string>;
  private readonly creators: CreatorKeyring;
  private readonly priority: PriorityPrice;
  private readonly alts: LookupTables;
  private readonly pipeline: TxPipeline | null;
  private params: { at: number; global: Global; feeConfig: FeeConfig } | null = null;
  /** Served non-SOL quotes, by mint and by symbol. */
  private readonly routesByMint = new Map<string, PumpQuoteRoute>();
  private readonly routesBySymbol = new Map<string, PumpQuoteRoute>();

  constructor(o: PumpFunAdapterOptions) {
    this.connection = o.connection;
    this.online = new OnlinePumpSdk(o.connection);
    this.defaultVault = o.defaultVault;
    this.vaultKeys = new Set([o.defaultVault, ...(o.vaults ?? [])].map((v) => v.publicKey.toBase58()));
    this.creators = o.creators;
    const p = o.priorityMicroLamports ?? 0;
    this.priority = typeof p === "number" ? fixedPrice(p) : p;
    this.pipeline = o.pipeline ?? null;
    this.alts = o.lookupTables ?? new LookupTables(o.connection, o.stateDir, this.priority, this.pipeline);
    for (const a of o.quotes ?? []) {
      if (!a.poolA && !a.stockOnly) continue;
      const r = { asset: a, poolA: makeQuotePool(o.connection, a) };
      this.routesByMint.set(a.mint.toBase58(), r);
      this.routesBySymbol.set(a.symbol, r);
    }
  }

  private routeOfQuote(quoteMint: PublicKey): PumpQuoteRoute | null {
    const q = normalizeQuoteMint(quoteMint);
    if (isLegacyQuoteMint(q)) return null;
    const r = this.routesByMint.get(q.toBase58());
    if (!r) throw new AdapterError("bad_request", "pump.fun curve quoted in a token this pool does not serve");
    return r;
  }

  // -------------------------------------------------------------------------
  // read side
  // -------------------------------------------------------------------------

  async status(mint: string): Promise<CurveStatus> {
    const mintPk = parseMint(mint);
    const info = await this.rpc(() => this.connection.getAccountInfo(bondingCurvePda(mintPk)));
    if (!info) throw new AdapterError("not_found", `no pump.fun bonding curve for ${mint}`);
    const curve = PUMP_SDK.decodeBondingCurve(info);
    return curveStatus(curve);
  }

  async quote(mint: string, side: "buy" | "sell", amount: bigint): Promise<Quote> {
    if (amount <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    const [state, { global, feeConfig }] = await Promise.all([this.loadCurve(parseMint(mint)), this.loadParams()]);
    const status = curveStatus(state.bondingCurve);
    if (status === "graduated") {
      throw new AdapterError("graduated", `${mint} has left the bonding curve; trade it on PumpSwap / Jupiter`);
    }
    if (state.route && !state.route.poolA) {
      // Stock-only quote: amounts in quote units both ways; SOL figures come from core's rate.
      const amountOut = side === "buy" ? quoteBuy(global, feeConfig, state.bondingCurve, state.curveBaseTokenBalance, amount) : quoteSell(global, feeConfig, state.bondingCurve, amount);
      const q = priceAndCapIn(state.bondingCurve, state.decimals, state.route.asset.decimals);
      return { venue: this.id, mint, side, amountIn: amount, amountOut, priceSol: "0", marketCapSol: "0", status, decimals: state.decimals, quoteMint: state.route.asset.mint.toBase58(), priceQuote: formatUnits(q.price18, 18) };
    }
    if (state.route) {
      const s = await pa(state.route).load();
      const amountOut =
        side === "buy"
          ? quoteBuy(global, feeConfig, state.bondingCurve, state.curveBaseTokenBalance, pumpMargin(pa(state.route).quoteForSol(s, amount)))
          : pa(state.route).solForQuote(s, quoteSell(global, feeConfig, state.bondingCurve, amount));
      const m = this.marketOfRoute(state, s);
      return { venue: this.id, mint, side, amountIn: amount, amountOut, priceSol: m.priceSol, marketCapSol: m.marketCapSol, status, decimals: state.decimals, quoteMint: state.route.asset.mint.toBase58(), priceQuote: m.priceQuote };
    }
    const amountOut =
      side === "buy"
        ? quoteBuy(global, feeConfig, state.bondingCurve, state.curveBaseTokenBalance, amount)
        : quoteSell(global, feeConfig, state.bondingCurve, amount);
    return {
      venue: this.id,
      mint,
      side,
      amountIn: amount,
      amountOut,
      ...priceAndCap(state.bondingCurve, state.decimals),
      status,
      decimals: state.decimals,
    };
  }

  // -------------------------------------------------------------------------
  // write side
  // -------------------------------------------------------------------------

  async create(meta: TokenMeta, initialBuyLamports: bigint, opts: CreateOptions = {}): Promise<TxResult> {
    const p = await this.prepareCreate(meta, initialBuyLamports, 0n, opts);
    const sent = await this.submit(p);
    const r = await this.createResult(sent.signature, p.vault);
    const fallback = emptyResult(this.id, "create", sent, { mint: new PublicKey(p.mint), tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: 6 }, p.vault);
    return { ...(r ?? fallback), creator: p.creator, creatorIndex: p.creatorIndex };
  }

  /**
   * Pre-checks and signs create_v2 (+ first buy when `initialBuyLamports > 0`)
   * with a FRESH creator (never a vault, never reused) and a new mint key.
   * Sends nothing; the relayer records the signature first.
   * `minOut`: minimum tokens of the first buy (slippage error otherwise).
   */
  async prepareCreate(
    meta: TokenMeta,
    initialBuyLamports: bigint,
    minOut: bigint,
    opts: CreateOptions = {},
  ): Promise<PreparedCreate> {
    validateMeta(meta);
    if (initialBuyLamports < 0n) throw new AdapterError("bad_request", "initialBuyLamports must be >= 0");
    if (minOut < 0n) throw new AdapterError("bad_request", "minOut must be >= 0");
    const vault = opts.vault ?? this.defaultVault;
    const { global, feeConfig } = await this.loadParams();
    if (!global.createV2Enabled) throw new AdapterError("venue_unavailable", "pump.fun create_v2 is disabled");

    // Non-SOL pair: first buy in quote units (pool A, local), from the vault's stock or
    // (stock short) bought by an ExactOut leg in THIS tx. Fair launch stays SOL only.
    let route: PumpQuoteRoute | null = null;
    if (opts.quote && opts.quote.toUpperCase() !== "SOL") {
      if (opts.mintKeypair) throw new AdapterError("bad_request", "fair launch is SOL only");
      route = this.routesBySymbol.get(opts.quote.toUpperCase()) ?? null;
      if (!route) throw new AdapterError("venue_unavailable", `pump.fun quote ${opts.quote} is not served on this network`);
    }
    let units = initialBuyLamports;
    let leg: unknown | null = null;
    let quoteSource: "stock" | "leg" | undefined;
    if (route && initialBuyLamports > 0n && !route.poolA) {
      // Stock-only (ZEC): `initialBuyLamports` IS quote units; no leg, a short stock is pool_liquidity.
      quoteSource = "stock";
      if ((await this.quoteStock(vault.publicKey, route)) < units) throw new AdapterError("insufficient_sol", `vault's ${route.asset.symbol} stock is short`);
    } else if (route && initialBuyLamports > 0n) {
      const s = await pa(route).load();
      units = pumpMargin(pa(route).quoteForSol(s, initialBuyLamports));
      if (units <= 0n) throw new AdapterError("slippage", "first buy too small for the quote token");
      quoteSource = (await this.quoteStock(vault.publicKey, route)) >= units ? "stock" : "leg";
      if (quoteSource === "leg") leg = s;
    }

    await this.requireSol(
      vault.publicKey,
      (route && !leg ? 0n : initialBuyLamports) + CREATE_RENT_HEADROOM + ACCUMULATOR_RENT_HEADROOM + ALT_RENT_HEADROOM,
    );

    // Allocate only after the cheap checks: every allocated index is burnt (never reused).
    const creatorIndex = opts.creatorIndex ?? (await this.creators.allocate());
    const creator = this.creators.publicKey(creatorIndex);
    if (this.vaultKeys.has(creator.toBase58())) {
      // Should be impossible (different key material); never let a vault be a public creator.
      throw new AdapterError("internal", "creator collides with a vault");
    }

    const mintKp = opts.mintKeypair ?? Keypair.generate();
    const build = async (mint: PublicKey, user: PublicKey, creatorPk: PublicKey) => {
      if (!route) return createIxs(global, feeConfig, meta, mint, user, creatorPk, initialBuyLamports);
      const r = await createQuoteIxs(global, feeConfig, meta, mint, user, creatorPk, units, route.asset);
      const pre = leg ? await pa(route).buyQuoteExactOut(user, leg, units, initialBuyLamports) : [];
      return { ixs: [...pre, ...r.ixs], tokens: r.tokens };
    };
    const { ixs, tokens } = await build(mintKp.publicKey, vault.publicKey, creator);
    if (tokens < minOut) throw new AdapterError("slippage", `first buy quote ${tokens} < minOut ${minOut}`);
    // create_v2 + buy is ~1476 bytes as legacy (> 1232): needs a v0 tx + lookup table.
    const table = await this.lookupTable(vault, ixs, async (m, u, c) => (await build(m, u, c)).ixs, global);
    const signed = await this.sign(ixs, vault, route ? CU_CREATE_PUMP_QUOTE : CU_CREATE, [mintKp], [table]);
    return {
      ...signed,
      kind: "create",
      mint: mintKp.publicKey.toBase58(),
      vault: vault.publicKey.toBase58(),
      creator: creator.toBase58(),
      creatorIndex,
      expectedOut: tokens,
      ...(route ? { quoteMint: route.asset.mint.toBase58(), quoteUnits: units, ...(quoteSource ? { quoteSource } : {}) } : {}),
    };
  }

  /** Quote units the vault holds (0 without an ATA). */
  private async quoteStock(vault: PublicKey, route: PumpQuoteRoute): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(route.asset.mint, vault, true, route.asset.tokenProgram);
    const info = await this.rpc(() => this.connection.getAccountInfo(ata, "confirmed"));
    return info ? unpackAccount(ata, info, route.asset.tokenProgram).amount : 0n;
  }

  /**
   * Lamports to book for a quote-pair trade of `units` (same rules as the DBC adapter):
   * buy with an in-tx leg -> the leg's SOL scaled to the units used; buy from stock ->
   * pool A ExactOut cost now; sell -> pool A value now.
   */
  private async toLamports(tx: VersionedTransactionResponse, route: PumpQuoteRoute, units: bigint, kind: "buy" | "sell"): Promise<{ lamports: bigint; source: "stock" | "leg"; byCore?: true }> {
    if (!route.poolA) return { lamports: 0n, source: "stock", byCore: true }; // stock-only: core values it
    if (kind === "buy") {
      const leg = route.poolA.legs(tx).find((l) => l.buy && l.outputAmount > 0n);
      if (leg) return { lamports: (leg.inputAmount * units) / leg.outputAmount, source: "leg" };
      const s = await route.poolA.load();
      return { lamports: route.poolA.solForExactQuote(s, units), source: "stock" };
    }
    const s = await route.poolA.load();
    return { lamports: route.poolA.solForQuote(s, units), source: "stock" };
  }

  /** SOL price / cap of a quote curve, converted at pool A's rate for 1 whole quote token. */
  private marketOfRoute(st: CurveState, s: unknown): { priceSol: string; marketCapSol: string; priceQuote: string } {
    const r = st.route!;
    const qd = r.asset.decimals;
    const q = priceAndCapIn(st.bondingCurve, st.decimals, qd);
    const perQuote = pa(r).solForQuote(s, 10n ** BigInt(qd));
    const capLamports = (q.capUnits * perQuote) / 10n ** BigInt(qd);
    const priceSol18 = (q.price18 * perQuote) / 1_000_000_000n;
    return { priceSol: formatUnits(priceSol18, 18), marketCapSol: formatUnits(capLamports, 9), priceQuote: formatUnits(q.price18, 18) };
  }

  /**
   * Fair-launch v2 (mainnet, Jito): signs a bundle of 2..5 legs with ONE
   * blockhash. Leg 0 = `create_v2 + buy_v2` from `legs[0].vault` (the mint's
   * pinned vault, v0 + its lookup table), legs 1.. = `buy_exact_quote_in_v3`
   * from other vaults, built OFFLINE against the simulated fresh curve (the
   * mint does not exist yet). Every leg carries `tip` in the pool prefix (same
   * shape as every pool tx; never via the lookup table) and its own
   * min_tokens_out, so an unbundled leg (uncled block) fills fairly or fails.
   * Sends nothing.
   */
  async prepareFairBundle(
    meta: TokenMeta,
    legs: readonly { vault: Signer; lamports: bigint }[],
    minOut: bigint,
    opts: { mintKeypair: Keypair; tip: SenderTip; creatorIndex?: number },
  ): Promise<PreparedFairBundle> {
    validateMeta(meta);
    if (legs.length < 2 || legs.length > 5) throw new AdapterError("bad_request", "a fair bundle has 2..5 legs");
    if (legs.some((l) => l.lamports <= 0n)) throw new AdapterError("bad_request", "leg lamports must be > 0");
    const keys = legs.map((l) => l.vault.publicKey.toBase58());
    if (new Set(keys).size !== keys.length) throw new AdapterError("bad_request", "one vault per leg");
    if (minOut <= 0n) throw new AdapterError("bad_request", "fair bundle needs minOut > 0");
    const { global, feeConfig } = await this.loadParams();
    if (!global.createV2Enabled) throw new AdapterError("venue_unavailable", "pump.fun create_v2 is disabled");
    const ataRent = await this.ataRent();
    await Promise.all(
      legs.map((l, i) =>
        this.requireSol(
          l.vault.publicKey,
          l.lamports + opts.tip.lamports + ACCUMULATOR_RENT_HEADROOM + (i === 0 ? CREATE_RENT_HEADROOM + ALT_RENT_HEADROOM : ataRent),
        ),
      ),
    );

    const creatorIndex = opts.creatorIndex ?? (await this.creators.allocate());
    const creator = this.creators.publicKey(creatorIndex);
    if (this.vaultKeys.has(creator.toBase58())) throw new AdapterError("internal", "creator collides with a vault");

    const mint = opts.mintKeypair.publicKey;
    const quotes = quoteFairLegs(global, feeConfig, creator, legs.map((l) => l.lamports));
    let minOuts: bigint[];
    try {
      minOuts = splitMinOut(minOut, quotes.map((q) => q.tokens));
    } catch (e) {
      throw new AdapterError("slippage", e instanceof Error ? e.message : "legs below min_out");
    }

    const a = legs[0]!;
    const build = (m: PublicKey, u: PublicKey, c: PublicKey) => createIxs(global, feeConfig, meta, m, u, c, a.lamports);
    const create = await build(mint, a.vault.publicKey, creator);
    if (create.tokens !== quotes[0]!.tokens) throw new AdapterError("internal", "create leg quote mismatch");
    if (create.tokens < minOuts[0]!) throw new AdapterError("slippage", "create leg below its min_out");
    const table = await this.lookupTable(a.vault, create.ixs, async (m, u, c) => (await build(m, u, c)).ixs, global);
    // Jito: tip accounts must not be resolved through a lookup table.
    if (opts.tip.accounts.some((t) => table.state.addresses.some((x) => x.equals(t)))) {
      throw new AdapterError("internal", "tip account inside the lookup table");
    }

    const legIxs: TransactionInstruction[][] = [create.ixs];
    for (let i = 1; i < legs.length; i++) {
      legIxs.push(
        await PUMP_SDK.buyExactQuoteInV3Instructions({
          bondingCurve: quotes[i]!.curveBefore,
          associatedUserAccountInfo: null, // new mint: the vault has no ATA yet (idempotent create)
          mint,
          user: legs[i]!.vault.publicKey,
          amount: toBN(minOuts[i]!), // slippage 0 => min_tokens_out = minOut of the leg
          quoteAmount: toBN(legs[i]!.lamports),
          slippage: 0,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
        }),
      );
    }

    const recent = await this.rpc(() => this.connection.getLatestBlockhash("confirmed"));
    const signed: PreparedFairLeg[] = [];
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i]!;
      const tx = await this.sign(legIxs[i]!, l.vault, i === 0 ? CU_CREATE : CU_TRADE, i === 0 ? [opts.mintKeypair] : [], i === 0 ? [table] : undefined, {
        tip: opts.tip,
        recent,
      });
      signed.push({ ...tx, vault: keys[i]!, lamports: l.lamports, expectedOut: quotes[i]!.tokens, minOut: minOuts[i]! });
    }
    return {
      kind: "fair_bundle",
      mint: mint.toBase58(),
      creator: creator.toBase58(),
      creatorIndex,
      legs: signed,
      blockhash: recent.blockhash,
      lastValidBlockHeight: recent.lastValidBlockHeight,
    };
  }

  /** Tokens a single create+buy of `lamports` gets on a fresh curve (capped fallback). */
  async freshQuote(lamports: bigint): Promise<bigint> {
    const { global, feeConfig } = await this.loadParams();
    return quoteFreshBuy(global, feeConfig, lamports);
  }

  /** Executed bundle leg: buy amounts + creator fee from its TradeEvent. Null when unreadable. */
  async fairLegResult(signature: string, vault: string, mint: string): Promise<FairLegResult | null> {
    const tx = await fetchTx(this.connection, signature, 10).catch(() => null);
    if (!tx) return null;
    const mi = await this.loadMint(parseMint(mint));
    const vaultPk = new PublicKey(vault);
    const ev = extractTradeEvents(tx, PUMP_PROGRAM_ID).find((e) => e.mint.equals(mi.mint) && e.user.equals(vaultPk));
    if (!ev) return null; // a landed leg always emits its TradeEvent; never guess SOL from deltas
    return {
      venue: this.id,
      kind: "buy",
      signature,
      slot: tx.slot,
      mint,
      vault,
      tokenAmount: BigInt(ev.tokenAmount.toString(10)),
      solAmount: tradeLamports(ev),
      networkFee: BigInt(tx.meta?.fee ?? 0),
      blockTime: tx.blockTime ?? null,
      decimals: mi.decimals,
      amountsKnown: true,
      fromEvent: true,
      creatorFee: creatorFeeOf(ev),
    };
  }

  /**
   * Executed create: mint and creator from the program's CreateEvent, first
   * buy amounts from its TradeEvent (0/0 without a first buy). Null when the
   * transaction (or its CreateEvent) cannot be read yet.
   */
  async createResult(signature: string, vault: string): Promise<CreateResult | null> {
    const tx = await fetchTx(this.connection, signature, 10).catch(() => null);
    if (!tx) return null;
    const vaultPk = new PublicKey(vault);
    const ce = extractCreateEvents(tx, PUMP_PROGRAM_ID).find((e) => e.user.equals(vaultPk));
    if (!ce) return null;
    const mint = ce.mint;
    const tokenProgram = ce.tokenProgram.equals(PublicKey.default) ? TOKEN_2022_PROGRAM_ID : ce.tokenProgram;
    const decimals = (await this.loadMint(mint).catch(() => null))?.decimals ?? 6;
    const ev = extractTradeEvents(tx, PUMP_PROGRAM_ID).find((e) => e.mint.equals(mint) && e.user.equals(vaultPk));
    let tokenAmount = 0n;
    let solAmount = 0n;
    let creatorFee: bigint | null = 0n;
    let quote: { quoteMint: string; quoteAmount: bigint; quoteSource: "stock" | "leg" } | null = null;
    if (ev) {
      tokenAmount = BigInt(ev.tokenAmount.toString(10));
      solAmount = tradeLamports(ev);
      creatorFee = creatorFeeOf(ev);
      const route = this.routeOfEvent(ev);
      if (route) {
        const units = this.quoteUnitsMoved(tx, vaultPk, route, "buy");
        const conv = await this.toLamports(tx, route, units, "buy").catch(() => null);
        if (!conv) return null;
        if (creatorFee !== null) creatorFee = units > 0n ? (conv.lamports * creatorFee) / units : 0n;
        quote = { quoteMint: route.asset.mint.toBase58(), quoteAmount: units, quoteSource: conv.source, ...(conv.byCore ? { lamportsByCore: true as const } : {}) };
        solAmount = conv.lamports;
      }
    } else {
      // No first buy, or the event did not decode: tokens from the vault's balance.
      tokenAmount = tokenDelta(tx, vaultPk, mint);
      if (tokenAmount > 0n) return null; // a buy happened but its amounts are unknown: never guess SOL
    }
    return {
      venue: this.id,
      kind: "create",
      signature,
      slot: tx.slot,
      mint: mint.toBase58(),
      vault,
      creator: ce.creator.toBase58(),
      name: ce.name,
      symbol: ce.symbol,
      uri: ce.uri,
      tokenProgram: tokenProgram.toBase58(),
      tokenAmount,
      solAmount,
      networkFee: BigInt(tx.meta?.fee ?? 0),
      blockTime: tx.blockTime ?? null,
      decimals,
      amountsKnown: true,
      fromEvent: ev !== undefined,
      creatorFee,
      ...(quote ?? {}),
    };
  }

  /** Route of a TradeEvent's quote (null = SOL). */
  private routeOfEvent(ev: { quoteMint?: PublicKey | null }): PumpQuoteRoute | null {
    if (!ev.quoteMint) return null;
    const q = normalizeQuoteMint(ev.quoteMint);
    if (isLegacyQuoteMint(q)) return null;
    return this.routesByMint.get(q.toBase58()) ?? null;
  }

  /**
   * Quote units the curve took (buy) / paid (sell), from the vault's quote balance:
   * buy = what an in-tx leg added minus the net change; sell = the net change.
   */
  private quoteUnitsMoved(tx: VersionedTransactionResponse, vault: PublicKey, route: PumpQuoteRoute, kind: "buy" | "sell"): bigint {
    const d = tokenDelta(tx, vault, route.asset.mint);
    if (kind === "sell") return d > 0n ? d : 0n;
    const leg = route.poolA ? route.poolA.legs(tx).find((l) => l.buy && l.outputAmount > 0n) : undefined;
    const spent = (leg?.outputAmount ?? 0n) - d;
    return spent > 0n ? spent : 0n;
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

  /** Pre-checks (curve, quote vs minOut, vault SOL) and signs a buy. Sends nothing. */
  async prepareBuy(mint: string, lamportsIn: bigint, minOut: bigint, opts: TradeOptions = {}): Promise<PreparedTrade> {
    if (lamportsIn <= 0n) throw new AdapterError("bad_request", "lamportsIn must be > 0");
    if (minOut < 0n) throw new AdapterError("bad_request", "minOut must be >= 0");
    const vault = opts.vault ?? this.defaultVault;
    const mintPk = parseMint(mint);
    const mi = await this.loadMint(mintPk);
    const [state, { global, feeConfig }] = await Promise.all([
      this.rpc(() => this.online.fetchBuyState(mintPk, vault.publicKey, mi.tokenProgram)),
      this.loadParams(),
    ]);
    assertTradable(state.bondingCurve, mint);
    const route = this.routeOfQuote(state.quoteMint);

    // Non-SOL curve: lamports -> quote units on pool A; stock first, in-tx leg as fallback.
    let units = lamportsIn;
    let pre: TransactionInstruction[] = [];
    let quoteSource: "stock" | "leg" | undefined;
    if (route && !route.poolA) {
      // Stock-only (ZEC): `lamportsIn` IS quote units (core's job); short stock -> pool_liquidity.
      quoteSource = "stock";
      if ((await this.quoteStock(vault.publicKey, route)) < units) throw new AdapterError("insufficient_sol", `vault's ${route.asset.symbol} stock is short`);
    } else if (route) {
      const s = await pa(route).load();
      units = pumpMargin(pa(route).quoteForSol(s, lamportsIn));
      if (units <= 0n) throw new AdapterError("slippage", "buy too small for the quote token");
      quoteSource = (await this.quoteStock(vault.publicKey, route)) >= units ? "stock" : "leg";
      if (quoteSource === "leg") pre = await pa(route).buyQuoteExactOut(vault.publicKey, s, units, lamportsIn);
    }
    const expected = quoteBuy(global, feeConfig, state.bondingCurve, toBig(state.curveBaseTokenBalance), units);
    if (expected < minOut) {
      throw new AdapterError("slippage", `quote ${expected} < minOut ${minOut}`);
    }
    const rent = state.associatedUserAccountInfo ? 0n : ACCUMULATOR_RENT_HEADROOM + (await this.ataRent());
    await this.requireSol(vault.publicKey, (quoteSource === "stock" ? 0n : lamportsIn) + rent);

    const ixs = await PUMP_SDK.buyExactQuoteInV3Instructions({
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      mint: mintPk,
      user: vault.publicKey,
      amount: toBN(minOut), // slippage 0 => min_tokens_out = max(minOut, 1)
      quoteAmount: toBN(units), // spendable_quote_in, fees included (lamports, or quote units on a quote curve)
      slippage: 0,
      tokenProgram: mi.tokenProgram,
      quoteTokenProgram: state.quoteTokenProgram,
    });
    const signed = await this.sign([...pre, ...ixs], vault, route ? CU_TRADE_PUMP_QUOTE : CU_TRADE);
    return {
      ...signed,
      kind: "buy",
      mint,
      vault: vault.publicKey.toBase58(),
      expectedOut: expected,
      ...(route ? { quoteMint: route.asset.mint.toBase58(), quoteUnits: units, ...(quoteSource ? { quoteSource } : {}) } : {}),
    };
  }

  /** Pre-checks (curve, vault holdings, quote vs minLamports) and signs a sell. Sends nothing. */
  async prepareSell(
    mint: string,
    amount: bigint,
    minLamports: bigint,
    opts: TradeOptions = {},
  ): Promise<PreparedTrade> {
    if (amount <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    if (minLamports < 0n) throw new AdapterError("bad_request", "minLamports must be >= 0");
    const vault = opts.vault ?? this.defaultVault;
    const mintPk = parseMint(mint);
    const mi = await this.loadMint(mintPk);
    const ata = getAssociatedTokenAddressSync(mintPk, vault.publicKey, true, mi.tokenProgram);
    const [state, { global, feeConfig }, ataInfo] = await Promise.all([
      this.rpc(() => this.online.fetchSellState(mintPk, vault.publicKey, mi.tokenProgram)),
      this.loadParams(),
      this.rpc(() => this.connection.getAccountInfo(ata)),
    ]);
    assertTradable(state.bondingCurve, mint);
    const held = ataInfo ? unpackAccount(ata, ataInfo, mi.tokenProgram).amount : 0n;
    if (held < amount) throw new AdapterError("insufficient_tokens", `vault holds ${held} < ${amount}`);
    const route = this.routeOfQuote(state.quoteMint);

    const outUnits = quoteSell(global, feeConfig, state.bondingCurve, amount);
    // Non-SOL curve: proceeds stay as quote STOCK (the scheduled stock job sells excess);
    // min lamports -> min quote units on pool A.
    let expected = outUnits;
    let minUnits = minLamports;
    if (route && route.poolA) {
      const s = await route.poolA.load();
      expected = route.poolA.solForQuote(s, outUnits);
      minUnits = minLamports > 0n ? route.poolA.quoteForSol(s, minLamports) : 0n;
    } // stock-only (ZEC): min_out is already in quote units (core's job)
    if (expected < minLamports) {
      throw new AdapterError("slippage", `quote ${expected} < minLamports ${minLamports}`);
    }
    await this.requireSol(vault.publicKey, route ? 2_100_000n : 0n);

    const ixs = await PUMP_SDK.sellV3Instructions({
      bondingCurve: state.bondingCurve,
      mint: mintPk,
      user: vault.publicKey,
      amount: toBN(amount),
      quoteAmount: toBN(minUnits), // slippage 0 => min output = minUnits
      slippage: 0,
      tokenProgram: mi.tokenProgram,
      quoteTokenProgram: state.quoteTokenProgram,
    });
    const signed = await this.sign(ixs, vault, route ? CU_TRADE_PUMP_QUOTE : CU_TRADE);
    return { ...signed, kind: "sell", mint, vault: vault.publicKey.toBase58(), expectedOut: expected, ...(route ? { quoteMint: route.asset.mint.toBase58() } : {}) };
  }

  /**
   * Broadcasts a prepared trade and waits for confirmation. Throws
   * AdapterError with `stage` and `signature` (see AdapterError.stage).
   */
  async submit(p: SignedTx): Promise<{ signature: string; slot: number }> {
    try {
      return await broadcastAndConfirm(this.connection, p, this.pipeline?.broadcaster);
    } catch (e) {
      throw this.sendError(e);
    }
  }

  /**
   * Executed amounts of a landed trade, from its pump `TradeEvent` (fallback:
   * balance deltas). Null when the transaction cannot be read yet.
   */
  async tradeResult(
    kind: "buy" | "sell",
    signature: string,
    vault: string,
    mint: string,
  ): Promise<TxResult | null> {
    const mi = await this.loadMint(parseMint(mint));
    return this.readResult(kind, signature, new PublicKey(vault), mi, 10);
  }

  /** Maps any send/RPC failure to an AdapterError (program errors via the pump IDL). */
  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    return classifyError(err, logs, PUMP_ERRORS, PUMP_PROGRAM_ID.toBase58());
  }

  private async landedResult(p: PreparedTrade, sent: { signature: string; slot: number }): Promise<TxResult> {
    const mi = await this.loadMint(parseMint(p.mint));
    const r = await this.readResult(p.kind, sent.signature, new PublicKey(p.vault), mi, 10);
    return r ?? emptyResult(this.id, p.kind, sent, mi, p.vault);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async loadParams(): Promise<{ global: Global; feeConfig: FeeConfig }> {
    if (this.params && Date.now() - this.params.at < PARAMS_TTL_MS) return this.params;
    const [global, feeConfig] = await this.rpc(() =>
      Promise.all([this.online.fetchGlobal(), this.online.fetchFeeConfig()]),
    );
    this.params = { at: Date.now(), global, feeConfig };
    return this.params;
  }

  private async loadMint(mint: PublicKey): Promise<MintInfo> {
    const info = await this.rpc(() => this.connection.getAccountInfo(mint));
    if (!info) throw new AdapterError("not_found", `mint ${mint.toBase58()} does not exist`);
    const tokenProgram = info.owner;
    if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      // API.md: unknown mint -> 404, whatever lives at that address.
      throw new AdapterError("not_found", `${mint.toBase58()} is not an SPL mint`);
    }
    const decimals = unpackMint(mint, info, tokenProgram).decimals;
    return { mint, tokenProgram, decimals };
  }

  private async loadCurve(mint: PublicKey): Promise<CurveState> {
    const mi = await this.loadMint(mint);
    const curvePda = bondingCurvePda(mint);
    const curveAta = getAssociatedTokenAddressSync(mint, curvePda, true, mi.tokenProgram);
    const [curveInfo, ataInfo] = await this.rpc(() => this.connection.getMultipleAccountsInfo([curvePda, curveAta]));
    if (!curveInfo) throw new AdapterError("not_found", `no pump.fun bonding curve for ${mint.toBase58()}`);
    const bondingCurve = PUMP_SDK.decodeBondingCurve(curveInfo);
    // SOL curves, or a quote this adapter serves (with a pool A); anything else is refused.
    const route = this.routeOfQuote(bondingCurve.quoteMint);
    const curveBaseTokenBalance = ataInfo ? unpackAccount(curveAta, ataInfo, mi.tokenProgram).amount : 0n;
    return { ...mi, bondingCurve, curveBaseTokenBalance, route };
  }

  private ataRentCache: bigint | null = null;
  private async ataRent(): Promise<bigint> {
    // Token-2022 ATA with extensions: up to ~182 bytes.
    this.ataRentCache ??= BigInt(await this.rpc(() => this.connection.getMinimumBalanceForRentExemption(182)));
    return this.ataRentCache;
  }

  private async requireSol(vault: PublicKey, need: bigint): Promise<void> {
    const bal = BigInt(await this.rpc(() => this.connection.getBalance(vault, "confirmed")));
    if (bal < need + FEE_HEADROOM) {
      throw new AdapterError("insufficient_sol", `vault has ${bal} lamports, needs ~${need + FEE_HEADROOM}`);
    }
  }

  private async lookupTable(
    vault: Signer,
    ixs: TransactionInstruction[],
    build: (mint: PublicKey, user: PublicKey, creator: PublicKey) => Promise<TransactionInstruction[]>,
    global: Global,
  ): Promise<AddressLookupTableAccount> {
    // Static accounts = those shared with a build for an unrelated mint / creator by the SAME vault
    // (the table is the vault's own: its ATAs / PDAs belong in it), plus the Sender tip accounts.
    const r = () => Keypair.generate().publicKey;
    const other = await build(r(), vault.publicKey, r());
    const feeRecipients = [global.feeRecipient, ...global.feeRecipients, ...global.buybackFeeRecipients].filter(
      (p) => !p.equals(PublicKey.default),
    );
    try {
      return await this.alts.ensure(vault, [...staticAccounts(ixs, other), ...feeRecipients, ...(this.pipeline?.tip?.accounts ?? [])]);
    } catch (e) {
      throw classifyError(e, null, PUMP_ERRORS, PUMP_PROGRAM_ID.toBase58());
    }
  }

  private async sign(
    ixs: TransactionInstruction[],
    payer: Signer,
    cu: number,
    extra: Signer[] = [],
    lookupTables?: AddressLookupTableAccount[],
    /** Fair bundle legs: Jito tip instead of the Sender tip, one shared blockhash. */
    o: { tip?: SenderTip; recent?: { blockhash: string; lastValidBlockHeight: number } } = {},
  ): Promise<SignedTx> {
    try {
      return await signTx(
        this.connection,
        ixs,
        payer,
        extra,
        {
          computeUnits: cu,
          priorityMicroLamports: this.priority.microLamports(),
          tip: o.tip ?? this.pipeline?.tip ?? null,
          ...(lookupTables ? { lookupTables } : {}),
        },
        o.recent,
      );
    } catch (e) {
      throw this.sendError(e);
    }
  }

  private async send(
    ixs: TransactionInstruction[],
    payer: Signer,
    extra: Signer[],
    cu: number,
    lookupTables?: AddressLookupTableAccount[],
  ): Promise<{ signature: string; slot: number }> {
    const signed = await this.sign(ixs, payer, cu, extra, lookupTables);
    return this.submit(signed);
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

  /** Reads the confirmed tx and turns it into exact executed amounts. */
  private async result(
    kind: "create" | "buy" | "sell",
    sent: { signature: string; slot: number },
    vault: PublicKey,
    mi: MintInfo,
  ): Promise<TxResult> {
    const r = await this.readResult(kind, sent.signature, vault, mi, 10);
    // Landed, but details unavailable: amountsKnown=false, never zeros as truth.
    return r ?? emptyResult(this.id, kind, sent, mi, vault.toBase58());
  }

  private async readResult(
    kind: "create" | "buy" | "sell",
    signature: string,
    vault: PublicKey,
    mi: MintInfo,
    attempts: number,
  ): Promise<TxResult | null> {
    const tx = await fetchTx(this.connection, signature, attempts).catch(() => null);
    if (!tx) return null;
    const fee = BigInt(tx.meta?.fee ?? 0);
    const ev = extractTradeEvents(tx, PUMP_PROGRAM_ID).find((e) => e.mint.equals(mi.mint) && e.user.equals(vault));
    let tokenAmount: bigint;
    let solAmount: bigint;
    const route = ev ? this.routeOfEvent(ev) : null;
    if (ev && route && kind !== "create") {
      // Quote curve: units from the vault's quote balance (+ leg), booked in lamports.
      const units = this.quoteUnitsMoved(tx, vault, route, kind);
      const conv = await this.toLamports(tx, route, units, kind).catch(() => null);
      if (!conv) return null;
      return {
        venue: this.id,
        kind,
        signature,
        slot: tx.slot,
        mint: mi.mint.toBase58(),
        vault: vault.toBase58(),
        tokenAmount: BigInt(ev.tokenAmount.toString(10)),
        solAmount: conv.lamports,
        networkFee: fee,
        blockTime: tx.blockTime ?? null,
        decimals: mi.decimals,
        amountsKnown: true,
        fromEvent: true,
        quoteMint: route.asset.mint.toBase58(),
        quoteAmount: units,
        ...(kind === "buy" ? { quoteSource: conv.source } : {}),
        ...(conv.byCore ? { lamportsByCore: true as const } : {}),
      };
    }
    if (ev) {
      // Executed amounts straight from the program's TradeEvent.
      tokenAmount = BigInt(ev.tokenAmount.toString(10));
      solAmount = tradeLamports(ev);
    } else {
      // Fallback: balance deltas (SOL includes rent on first buys).
      const tokDelta = tokenDelta(tx, vault, mi.mint);
      tokenAmount = tokDelta < 0n ? -tokDelta : tokDelta;
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

  /** RPC reads: AdapterErrors pass through, anything else is "venue_unavailable". */
  private async rpc<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/not found|could not find|Account does not exist/i.test(msg)) {
        throw new AdapterError("not_found", msg.split("\n", 1)[0] ?? msg, { cause: e });
      }
      throw new AdapterError("venue_unavailable", `RPC error: ${msg.split("\n", 1)[0] ?? msg}`, { cause: e });
    }
  }

  /** Public price / market cap / status of a mint right now (for the tokens table). */
  async market(mint: string): Promise<{ priceSol: string; marketCapSol: string; status: CurveStatus; priceQuote?: string }> {
    const st = await this.loadCurve(parseMint(mint));
    if (st.route && !st.route.poolA) {
      // Stock-only (ZEC): SOL figures from core's rate ("0" here), price in quote from the curve.
      const q = priceAndCapIn(st.bondingCurve, st.decimals, st.route.asset.decimals);
      return { priceSol: "0", marketCapSol: "0", status: curveStatus(st.bondingCurve), priceQuote: formatUnits(q.price18, 18) };
    }
    if (st.route) {
      const m = this.marketOfRoute(st, await pa(st.route).load());
      return { priceSol: m.priceSol, marketCapSol: m.marketCapSol, status: curveStatus(st.bondingCurve), priceQuote: m.priceQuote };
    }
    return { ...priceAndCap(st.bondingCurve, st.decimals), status: curveStatus(st.bondingCurve) };
  }

  /** Symbol from Token-2022 on-mint metadata (pump create_v2 mints); null if none. */
  async tokenSymbol(mint: string): Promise<string | null> {
    const pk = parseMint(mint);
    const mi = await this.loadMint(pk);
    if (!mi.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return null;
    const md = await getTokenMetadata(this.connection, pk, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);
    return md?.symbol ?? null;
  }

  /** Exposed for scripts: the raw on-chain curve (for display / debugging). */
  async curve(mint: string): Promise<BondingCurve> {
    return (await this.loadCurve(parseMint(mint))).bondingCurve;
  }
}

// ---------------------------------------------------------------------------
// pure helpers (unit-tested)
// ---------------------------------------------------------------------------

function emptyResult(
  venue: "pumpfun",
  kind: "create" | "buy" | "sell",
  sent: { signature: string; slot: number },
  mi: MintInfo,
  vault: string,
): TxResult {
  return {
    venue,
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

async function createIxs(
  global: Global,
  feeConfig: FeeConfig,
  meta: TokenMeta,
  mint: PublicKey,
  user: PublicKey,
  creator: PublicKey,
  initialBuyLamports: bigint,
): Promise<{ ixs: TransactionInstruction[]; tokens: bigint }> {
  const common = { mint, name: meta.name, symbol: meta.symbol, uri: meta.uri, creator, user, mayhemMode: false };
  if (initialBuyLamports === 0n) return { ixs: [await PUMP_SDK.createV2Instruction(common)], tokens: 0n };
  const quoteAmount = toBN(initialBuyLamports);
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: quoteAmount,
    quoteMint: NATIVE_MINT,
  });
  // slippage 0: the first buy may cost at most exactly initialBuyLamports.
  const ixs = await PUMP_SDK.createV2AndBuyV2Instructions({ global, ...common, amount, quoteAmount, slippage: 0 });
  return { ixs, tokens: toBig(amount) };
}

/** create_v2 (+ first buy of `units` quote units) for a non-SOL quote mint. */
async function createQuoteIxs(
  global: Global,
  feeConfig: FeeConfig,
  meta: TokenMeta,
  mint: PublicKey,
  user: PublicKey,
  creator: PublicKey,
  units: bigint,
  quote: Pick<QuoteAsset, "mint" | "tokenProgram">,
): Promise<{ ixs: TransactionInstruction[]; tokens: bigint }> {
  // One creator fee rate for every launch: quotes outside Global's whitelist (QuoteControl, e.g. ZEC)
  // take an explicit rate at create; we set the schedule's own creator rate there.
  const whitelisted = global.whitelistedQuoteMints?.some((m) => m.equals(quote.mint)) ?? false;
  const creatorFeeBps = !whitelisted && global.creatorFeeConfigurable ? toBN(BigInt(PUMP_QUOTE_CREATOR_FEE_BPS)) : undefined;
  const common = {
    mint, name: meta.name, symbol: meta.symbol, uri: meta.uri, creator, user, mayhemMode: false, quoteMint: quote.mint, quoteTokenProgram: quote.tokenProgram,
    ...(creatorFeeBps ? { creatorFeeBps } : {}),
  };
  if (units === 0n) return { ixs: [await PUMP_SDK.createV2Instruction(common)], tokens: 0n };
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: toBN(units), quoteMint: quote.mint, ...(creatorFeeBps ? { creatorFeeBps } : {}) });
  const ixs = await PUMP_SDK.createV2AndBuyV2Instructions({ global, ...common, amount, quoteAmount: toBN(units), slippage: 0 });
  return { ixs, tokens: toBig(amount) };
}

/** Lamports -> quote units with the leg margin (pool A drift between quote and landing). */
export function pumpMargin(units: bigint): bigint {
  return (units * (10_000n - PUMP_QUOTE_MARGIN_BPS)) / 10_000n;
}

/** Spot price (quote per whole token, 18 digits) and cap (quote units) of a quote curve. */
export function priceAndCapIn(curve: BondingCurve, decimals: number, quoteDecimals: number): { price18: bigint; capUnits: bigint } {
  const vq = toBig(curve.virtualQuoteReserves);
  const vt = toBig(curve.virtualTokenReserves);
  const supply = toBig(curve.tokenTotalSupply);
  if (vt === 0n) return { price18: 0n, capUnits: 0n };
  return { price18: (vq * 10n ** BigInt(decimals) * 10n ** 18n) / (vt * 10n ** BigInt(quoteDecimals)), capUnits: (vq * supply) / vt };
}

export function curveStatus(curve: BondingCurve): CurveStatus {
  return curve.complete || isBondingCurveMigrated(curve) ? "graduated" : "curve";
}

function assertTradable(curve: BondingCurve, mint: string): void {
  if (curveStatus(curve) === "graduated") {
    throw new AdapterError("graduated", `${mint} has left the bonding curve; trade it on PumpSwap / Jupiter`);
  }
  if (curve.isCashbackCoin) {
    throw new AdapterError("bad_request", "cashback coins need v2 trades; not supported");
  }
}

/** Tokens (base units) that `buy_exact_quote_in_v3` gives for `lamportsIn`, fees included. */
export function quoteBuy(
  global: Global,
  feeConfig: FeeConfig,
  curve: BondingCurve,
  curveBaseTokenBalance: bigint,
  lamportsIn: bigint,
): bigint {
  return toBig(
    getBuyV3TokenAmountFromQuoteAmount({
      global,
      feeConfig,
      mintSupply: curve.tokenTotalSupply,
      bondingCurve: curve,
      amount: toBN(lamportsIn),
      curveBaseTokenBalance: toBN(curveBaseTokenBalance),
    }),
  );
}

/** Lamports `sell_v3` pays for `amount` tokens, net of fees. */
export function quoteSell(global: Global, feeConfig: FeeConfig, curve: BondingCurve, amount: bigint): bigint {
  return toBig(
    getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: curve.tokenTotalSupply,
      bondingCurve: curve,
      amount: toBN(amount),
    }),
  );
}

export function priceAndCap(curve: BondingCurve, decimals: number): { priceSol: string; marketCapSol: string } {
  const vq = toBig(curve.virtualQuoteReserves);
  const vt = toBig(curve.virtualTokenReserves);
  const cap =
    vt === 0n
      ? 0n
      : toBig(
          bondingCurveMarketCap({
            mintSupply: curve.tokenTotalSupply,
            virtualQuoteReserves: curve.virtualQuoteReserves,
            virtualTokenReserves: curve.virtualTokenReserves,
          }),
        );
  return { priceSol: spotPriceSol(vq, vt, decimals), marketCapSol: formatUnits(cap, 9) };
}

/**
 * Lamports of a trade from its TradeEvent: what the vault paid (buy) or got
 * (sell), venue fees included, rent and network fee excluded.
 *
 * The event's `solAmount` is the curve leg; fees are on top for a buy and
 * deducted for a sell:
 * - `fee` is the whole protocol fee. `buybackFee` is a SLICE of it (paid out
 *   in the trade, the rest stays on the curve for a sweep), so it is NOT added
 *   again. Verified on devnet: sell `sol - fee - creatorFee` equals the vault's
 *   balance delta exactly with buybackFee = 10 % of fee.
 * - `creatorFee` goes to the creator (or holder rewards; `holderRewards`
 *   repeats the same amount and is not added).
 * - `cashback` (legacy cashback coins, v2 trades only) leaves the vault into
 *   its volume accumulator in the trade; it is claimable later, but it is not
 *   part of what this trade paid / returned now, so it is charged like a fee.
 *   Cashback coins are refused by `assertTradable`; this keeps the amount
 *   right if one ever slips through.
 */
export function tradeLamports(ev: {
  isBuy: boolean;
  solAmount: { toString(base?: number): string };
  fee: { toString(base?: number): string };
  creatorFee: { toString(base?: number): string };
  cashback?: { toString(base?: number): string } | null;
}): bigint {
  const n = (x: { toString(base?: number): string } | null | undefined) => (x ? BigInt(x.toString(10)) : 0n);
  const sol = n(ev.solAmount);
  const fees = n(ev.fee) + n(ev.creatorFee) + n(ev.cashback);
  if (ev.isBuy) return sol + fees;
  // A sell never pays out less than zero (fees larger than the curve leg).
  return sol > fees ? sol - fees : 0n;
}

const MAX_NAME = 32;
const MAX_SYMBOL = 10;
const MAX_URI = 200;

export function validateMeta(meta: TokenMeta): void {
  const bytes = (s: string) => Buffer.byteLength(s, "utf8");
  if (!meta.name || bytes(meta.name) > MAX_NAME) throw new AdapterError("bad_request", `name: 1..${MAX_NAME} bytes`);
  if (!meta.symbol || bytes(meta.symbol) > MAX_SYMBOL) {
    throw new AdapterError("bad_request", `symbol: 1..${MAX_SYMBOL} bytes`);
  }
  if (!meta.uri || bytes(meta.uri) > MAX_URI) throw new AdapterError("bad_request", `uri: 1..${MAX_URI} bytes`);
}

export function parseMint(mint: string): PublicKey {
  try {
    return new PublicKey(mint);
  } catch {
    throw new AdapterError("bad_request", "invalid mint address");
  }
}

export { PUMP_PROGRAM_ID };

/** TradeEvent.creatorFee (lamports) when the event carries it; null if the field is missing. */
export function creatorFeeOf(ev: { creatorFee?: { toString(base?: number): string } | null }): bigint | null {
  const v = ev.creatorFee?.toString(10);
  return v !== undefined && /^\d+$/.test(v) ? BigInt(v) : null;
}
