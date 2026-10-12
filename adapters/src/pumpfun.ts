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
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  type AddressLookupTableAccount,
  type Connection,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";
import { LookupTables, staticAccounts } from "./alt";
import { AdapterError, classifyError, type ProgramErrorInfo } from "./errors";
import { extractTradeEvents, lamportDelta, tokenDelta } from "./events";
import type { CreatorKeyring } from "./keys";
import { formatUnits, spotPriceSol, toBN, toBig } from "./math";
import { fetchTx, isSendFailure, sendAndConfirm } from "./tx";
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
  priorityMicroLamports?: number;
}

interface MintInfo {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
}

interface CurveState extends MintInfo {
  bondingCurve: BondingCurve;
  curveBaseTokenBalance: bigint;
}

export class PumpFunAdapter implements LaunchpadAdapter {
  readonly id = "pumpfun" as const;
  private readonly connection: Connection;
  private readonly online: OnlinePumpSdk;
  private readonly defaultVault: Signer;
  private readonly vaultKeys: Set<string>;
  private readonly creators: CreatorKeyring;
  private readonly priority: number;
  private readonly alts: LookupTables;
  private params: { at: number; global: Global; feeConfig: FeeConfig } | null = null;

  constructor(o: PumpFunAdapterOptions) {
    this.connection = o.connection;
    this.online = new OnlinePumpSdk(o.connection);
    this.defaultVault = o.defaultVault;
    this.vaultKeys = new Set([o.defaultVault, ...(o.vaults ?? [])].map((v) => v.publicKey.toBase58()));
    this.creators = o.creators;
    this.priority = o.priorityMicroLamports ?? 0;
    this.alts = new LookupTables(o.connection, o.stateDir, this.priority);
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
    validateMeta(meta);
    if (initialBuyLamports < 0n) throw new AdapterError("bad_request", "initialBuyLamports must be >= 0");
    const vault = opts.vault ?? this.defaultVault;
    const creatorIndex = opts.creatorIndex ?? this.creators.allocate();
    const creator = this.creators.publicKey(creatorIndex);
    if (this.vaultKeys.has(creator.toBase58())) {
      // Should be impossible (different key material); never let a vault be a public creator.
      throw new AdapterError("internal", "creator collides with a vault");
    }
    const { global, feeConfig } = await this.loadParams();
    if (!global.createV2Enabled) throw new AdapterError("venue_unavailable", "pump.fun create_v2 is disabled");

    await this.requireSol(
      vault.publicKey,
      initialBuyLamports + CREATE_RENT_HEADROOM + ACCUMULATOR_RENT_HEADROOM + ALT_RENT_HEADROOM,
    );

    const mintKp = Keypair.generate();
    const build = (mint: PublicKey, user: PublicKey, creatorPk: PublicKey) =>
      createIxs(global, feeConfig, meta, mint, user, creatorPk, initialBuyLamports);
    const ixs = await build(mintKp.publicKey, vault.publicKey, creator);
    // create_v2 + buy is ~1476 bytes as legacy (> 1232): needs a v0 tx + lookup table.
    const table = await this.lookupTable(vault, ixs, build, global);

    const sent = await this.send(ixs, vault, [mintKp], CU_CREATE, [table]);
    const res = await this.result("create", sent, vault.publicKey, {
      mint: mintKp.publicKey,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      decimals: 6,
    });
    // Read decimals from chain rather than assuming pump's 6.
    const mi = await this.loadMint(mintKp.publicKey).catch(() => null);
    return { ...res, decimals: mi?.decimals ?? res.decimals, creator: creator.toBase58(), creatorIndex };
  }

  async buy(mint: string, lamportsIn: bigint, minOut: bigint, opts: TradeOptions = {}): Promise<TxResult> {
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

    const expected = quoteBuy(global, feeConfig, state.bondingCurve, toBig(state.curveBaseTokenBalance), lamportsIn);
    if (expected < minOut) {
      throw new AdapterError("slippage", `quote ${expected} < minOut ${minOut}`);
    }
    const rent = state.associatedUserAccountInfo ? 0n : ACCUMULATOR_RENT_HEADROOM + (await this.ataRent());
    await this.requireSol(vault.publicKey, lamportsIn + rent);

    const ixs = await PUMP_SDK.buyExactQuoteInV3Instructions({
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      mint: mintPk,
      user: vault.publicKey,
      amount: toBN(minOut), // slippage 0 => min_tokens_out = max(minOut, 1)
      quoteAmount: toBN(lamportsIn), // spendable_quote_in, fees included
      slippage: 0,
      tokenProgram: mi.tokenProgram,
      quoteTokenProgram: state.quoteTokenProgram,
    });
    const sent = await this.send(ixs, vault, [], CU_TRADE);
    return this.result("buy", sent, vault.publicKey, mi);
  }

  async sell(mint: string, amount: bigint, minLamports: bigint, opts: TradeOptions = {}): Promise<TxResult> {
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

    const expected = quoteSell(global, feeConfig, state.bondingCurve, amount);
    if (expected < minLamports) {
      throw new AdapterError("slippage", `quote ${expected} < minLamports ${minLamports}`);
    }
    await this.requireSol(vault.publicKey, 0n);

    const ixs = await PUMP_SDK.sellV3Instructions({
      bondingCurve: state.bondingCurve,
      mint: mintPk,
      user: vault.publicKey,
      amount: toBN(amount),
      quoteAmount: toBN(minLamports), // slippage 0 => min_sol_output = minLamports
      slippage: 0,
      tokenProgram: mi.tokenProgram,
      quoteTokenProgram: state.quoteTokenProgram,
    });
    const sent = await this.send(ixs, vault, [], CU_TRADE);
    return this.result("sell", sent, vault.publicKey, mi);
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
      throw new AdapterError("bad_request", `${mint.toBase58()} is not an SPL mint`);
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
    if (!isLegacyQuoteMint(normalizeQuoteMint(bondingCurve.quoteMint))) {
      throw new AdapterError("bad_request", "only SOL-quoted pump.fun curves are supported");
    }
    const curveBaseTokenBalance = ataInfo ? unpackAccount(curveAta, ataInfo, mi.tokenProgram).amount : 0n;
    return { ...mi, bondingCurve, curveBaseTokenBalance };
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
    // Static accounts = those shared with a build for unrelated random keys.
    const r = () => Keypair.generate().publicKey;
    const other = await build(r(), r(), r());
    const feeRecipients = [global.feeRecipient, ...global.feeRecipients, ...global.buybackFeeRecipients].filter(
      (p) => !p.equals(PublicKey.default),
    );
    try {
      return await this.alts.ensure(vault, [...staticAccounts(ixs, other), ...feeRecipients]);
    } catch (e) {
      throw classifyError(e, null, PUMP_ERRORS, PUMP_PROGRAM_ID.toBase58());
    }
  }

  private async send(
    ixs: TransactionInstruction[],
    payer: Signer,
    extra: Signer[],
    cu: number,
    lookupTables?: AddressLookupTableAccount[],
  ): Promise<{ signature: string; slot: number }> {
    try {
      return await sendAndConfirm(this.connection, ixs, payer, extra, {
        computeUnits: cu,
        priorityMicroLamports: this.priority,
        ...(lookupTables ? { lookupTables } : {}),
      });
    } catch (e) {
      if (isSendFailure(e)) {
        const err = classifyError(e.error, e.logs, PUMP_ERRORS, PUMP_PROGRAM_ID.toBase58());
        if (e.signature && !err.signature) {
          throw new AdapterError(err.code, err.message, {
            ...(err.programError ? { programError: err.programError } : {}),
            signature: e.signature,
            cause: e.error,
          });
        }
        throw err;
      }
      throw classifyError(e, null, PUMP_ERRORS, PUMP_PROGRAM_ID.toBase58());
    }
  }

  /** Reads the confirmed tx and turns it into exact executed amounts. */
  private async result(
    kind: "create" | "buy" | "sell",
    sent: { signature: string; slot: number },
    vault: PublicKey,
    mi: MintInfo,
  ): Promise<TxResult> {
    const base: TxResult = {
      venue: this.id,
      kind,
      signature: sent.signature,
      slot: sent.slot,
      mint: mi.mint.toBase58(),
      vault: vault.toBase58(),
      tokenAmount: 0n,
      solAmount: 0n,
      networkFee: 0n,
      decimals: mi.decimals,
    };
    const tx = await fetchTx(this.connection, sent.signature).catch(() => null);
    if (!tx) return base; // landed, but details unavailable: caller may re-read later
    const fee = BigInt(tx.meta?.fee ?? 0);
    const ev = extractTradeEvents(tx, PUMP_PROGRAM_ID).find((e) => e.mint.equals(mi.mint) && e.user.equals(vault));
    const tokDelta = tokenDelta(tx, vault, mi.mint);
    const tokenAmount = tokDelta < 0n ? -tokDelta : tokDelta;
    let solAmount: bigint;
    if (ev) {
      solAmount = tradeLamports(ev);
    } else {
      // Fallback: vault delta minus network fee (includes rent on first buys).
      const d = lamportDelta(tx, vault) + fee;
      solAmount = d < 0n ? -d : d;
    }
    return { ...base, slot: tx.slot, tokenAmount, solAmount, networkFee: fee };
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

  /** Exposed for scripts: the raw on-chain curve (for display / debugging). */
  async curve(mint: string): Promise<BondingCurve> {
    return (await this.loadCurve(parseMint(mint))).bondingCurve;
  }
}

// ---------------------------------------------------------------------------
// pure helpers (unit-tested)
// ---------------------------------------------------------------------------

async function createIxs(
  global: Global,
  feeConfig: FeeConfig,
  meta: TokenMeta,
  mint: PublicKey,
  user: PublicKey,
  creator: PublicKey,
  initialBuyLamports: bigint,
): Promise<TransactionInstruction[]> {
  const common = { mint, name: meta.name, symbol: meta.symbol, uri: meta.uri, creator, user, mayhemMode: false };
  if (initialBuyLamports === 0n) return [await PUMP_SDK.createV2Instruction(common)];
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
  return PUMP_SDK.createV2AndBuyV2Instructions({ global, ...common, amount, quoteAmount, slippage: 0 });
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
 * The event's `solAmount` is the curve leg; fees are on top for a buy and
 * deducted for a sell.
 */
export function tradeLamports(ev: {
  isBuy: boolean;
  solAmount: { toString(base?: number): string };
  fee: { toString(base?: number): string };
  creatorFee: { toString(base?: number): string };
}): bigint {
  const sol = BigInt(ev.solAmount.toString(10));
  const fees = BigInt(ev.fee.toString(10)) + BigInt(ev.creatorFee.toString(10));
  return ev.isBuy ? sol + fees : sol - fees;
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
