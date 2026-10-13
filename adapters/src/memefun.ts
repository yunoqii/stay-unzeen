import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type Signer,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { LookupTables, staticAccounts } from "./alt";
import { AdapterError, classifyError, type AdapterErrorCode } from "./errors";
import { anchorEventPayloads } from "./events";
import { parseMetaplexMetadata } from "./intel/metrics";
import { fixedPrice, type PriorityPrice } from "./fees";
import type { CreatorKeyring } from "./keys";
import { formatUnits } from "./math";
import type { CreateResult, PreparedCreate, PreparedTrade } from "./pumpfun";
import { parseMint, validateMeta } from "./pumpfun";
import type { TxPipeline } from "./sender";
import { broadcastAndConfirm, fetchTx, isSendFailure, signTx, type SendFailure, type SignedTx } from "./tx";
import type { CreateOptions, CurveStatus, Quote, TokenMeta, TradeOptions, TxResult } from "./types";

/**
 * meme.fun adapter (venue "memefun"): one Anchor program, mainnet and devnet under the same ID
 * (`MEME4gf…`, IDL 0.1.0 read on chain 13.10, `anchor:idl` account; layouts below are hand
 * decoded from it, test/fixtures/memefun-idl.json checks them). SOL only (WSOL leg), mint is
 * Token-2022, supply 1B with 6 decimals, the curve never migrates (status always "curve").
 *
 * - create: `create_token` signed by fresh `mint`, `bonding_curve_token_account` and `sol_vault`
 *   keypairs and by the launch's FRESH HD creator, who is the payer of the accounts it creates.
 *   The vault funds the creator in the same tx with EXACTLY what the create spends (measured by
 *   simulation), so the creator ends at 0 lamports. The vault is fee payer and first buyer.
 *   Link: vault <-> creator is the same tx relation every launch already shows (vault pays, the
 *   creator signs); the transfer amount = account rent of a create (public).
 * - buy / sell: WSOL leg wrapped / unwrapped around the instruction, vault = user.
 * - pricing: meme.fun publishes no curve formula ("quote by simulating the instruction"); quotes,
 *   expected outputs, price and cap come from `simulateTransaction` of the real instruction
 *   (TradeEvent in the logs). Nothing is signed for a simulation; no meme.fun HTTP API is used.
 * - uri: the program requires content-addressed metadata (IPFS / Arweave, error 6017): checked
 *   before anything is signed (needs the Pinata metadata store).
 */

export const MEMEFUN_PROGRAM_ID = new PublicKey("MEME4gfGe6itEpxgM1xaBVmiFF5XuCTc4oVXUE5w56F");
const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

const IX = {
  create_token: Buffer.from([84, 52, 204, 228, 24, 140, 234, 75]),
  buy: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
  sell: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),
  claim_creator_fees: Buffer.from([0, 23, 125, 234, 156, 118, 134, 89]),
};
export const MEMEFUN_EVENTS = {
  CreateEvent: Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]),
  TradeEvent: Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
  ClaimEvent: Buffer.from([93, 15, 70, 170, 48, 140, 212, 219]),
};
const CURVE_DISC = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);

/** IDL 0.1.0 errors -> adapter codes. */
const MEMEFUN_ERRORS: { code: number; name: string }[] = [
  [6000, "Unauthorized"], [6001, "CooldownActive"], [6002, "EarlyBuyCapExceeded"], [6003, "MaxWalletExceeded"], [6004, "CurveComplete"],
  [6005, "CurveNotComplete"], [6006, "AlreadyMigrated"], [6007, "InsufficientTokens"], [6008, "InsufficientSol"], [6009, "SlippageExceeded"],
  [6010, "ArithmeticOverflow"], [6011, "InvalidFee"], [6012, "InvalidConfig"], [6013, "ReserveAccountMismatch"], [6014, "CreatorMismatch"],
  [6015, "VestingNotMatured"], [6016, "NothingToClaim"], [6017, "MetadataNotContentAddressed"], [6018, "SelfReferentialAccount"],
].map(([code, name]) => ({ code: code as number, name: name as string }));
const MEMEFUN_ERROR_BY_NAME: Record<string, AdapterErrorCode> = {
  SlippageExceeded: "slippage",
  InsufficientSol: "insufficient_sol",
  InsufficientTokens: "insufficient_tokens",
  EarlyBuyCapExceeded: "slippage",
  MaxWalletExceeded: "slippage",
  CooldownActive: "venue_unavailable",
  InvalidConfig: "bad_request",
  MetadataNotContentAddressed: "bad_request",
};

export const MEMEFUN_DECIMALS = 6;
export const MEMEFUN_SUPPLY = 1_000_000_000_000_000n;
/** Fixed CU per class (measured on devnet 13.10, ~2x headroom). */
export const CU_MEME_CREATE = 400_000;
export const CU_MEME_TRADE = 200_000;
const FEE_HEADROOM = 100_000n;
/** Funding offered to the creator in the measuring simulation (more than any create spends). */
const SIM_CREATOR_FUND = 100_000_000n;
/** A small buy whose price stands for the spot price (market / quote). */
const PROBE_LAMPORTS = 1_000_000n;

// ---------------------------------------------------------------------------
// accounts, events (pure)
// ---------------------------------------------------------------------------

export function curvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], MEMEFUN_PROGRAM_ID)[0];
}
export function globalPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("global")], MEMEFUN_PROGRAM_ID)[0];
}
export function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX)[0];
}

export interface MemeCurve {
  mint: PublicKey;
  creator: PublicKey;
  reserveTokenAccount: PublicKey;
  solVault: PublicKey;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  creatorFeesOwed: bigint;
  protocolFeesOwed: bigint;
}

/** BondingCurve (IDL 0.1.0): disc 8 | 4 x pubkey | 6 x u64 | bump u8 | i64 | bool | 2 x u64 | CurveConfig. */
export function decodeCurve(data: Buffer): MemeCurve {
  if (data.length < 8 + 128 + 48 + 1 + 8 + 1 + 16 || !data.subarray(0, 8).equals(CURVE_DISC)) throw new AdapterError("internal", "not a meme.fun bonding curve");
  const pk = (o: number) => new PublicKey(data.subarray(o, o + 32));
  const u = (o: number) => data.readBigUInt64LE(o);
  const o = 8 + 128;
  return {
    mint: pk(8),
    creator: pk(40),
    reserveTokenAccount: pk(72),
    solVault: pk(104),
    virtualSolReserves: u(o),
    virtualTokenReserves: u(o + 8),
    realSolReserves: u(o + 16),
    realTokenReserves: u(o + 24),
    tokenTotalSupply: u(o + 32),
    // created_slot u64 @ o+40, bump u8 @ o+48, mcap_high_since i64 @ o+49, creator_fees_ended bool @ o+57
    creatorFeesOwed: u(o + 58),
    protocolFeesOwed: u(o + 66),
  };
}

export interface MemeTradeEvent {
  mint: PublicKey;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: PublicKey;
  realSolReserves: bigint;
}

/** TradeEvent: mint 32 | sol u64 | token u64 | is_buy bool | user 32 | 4 x u64 reserves | ts i64 | slot u64. */
export function decodeTradeEvent(p: Buffer): MemeTradeEvent | null {
  if (p.length < 32 + 16 + 1 + 32 + 32) return null;
  return {
    mint: new PublicKey(p.subarray(0, 32)),
    solAmount: p.readBigUInt64LE(32),
    tokenAmount: p.readBigUInt64LE(40),
    isBuy: p.readUInt8(48) !== 0,
    user: new PublicKey(p.subarray(49, 81)),
    realSolReserves: p.readBigUInt64LE(81 + 16),
  };
}

/** CreateEvent: mint | bonding_curve | creator | name | symbol | uri (borsh strings) | ... */
export function decodeCreateEvent(p: Buffer): { mint: PublicKey; creator: PublicKey; name: string; symbol: string; uri: string } | null {
  try {
    let o = 96;
    const str = () => {
      const n = p.readUInt32LE(o);
      const s = p.subarray(o + 4, o + 4 + n).toString("utf8");
      o += 4 + n;
      return s;
    };
    const name = str();
    const symbol = str();
    const uri = str();
    return { mint: new PublicKey(p.subarray(0, 32)), creator: new PublicKey(p.subarray(64, 96)), name, symbol, uri };
  } catch {
    return null;
  }
}

/** Content-addressed metadata (program error 6017 otherwise): ipfs:// / ar:// or an IPFS / Arweave gateway URL. */
export function isContentAddressed(uri: string): boolean {
  return /^(ipfs|ar):\/\/[A-Za-z0-9]/.test(uri) || /^https:\/\/[^/]+\/ipfs\/[A-Za-z0-9]{20,}/.test(uri) || /^https:\/\/(arweave\.net|[a-z0-9-]+\.arweave\.net)\/[A-Za-z0-9_-]{20,}/.test(uri) || /^https:\/\/[a-z0-9]{40,}\.ipfs\.[^/]+\//.test(uri);
}

// ---------------------------------------------------------------------------
// instructions (pure)
// ---------------------------------------------------------------------------

function borshString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
}
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
};
const meta = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({ pubkey, isSigner, isWritable });

export function createTokenIx(a: { mint: PublicKey; reserve: PublicKey; solVault: PublicKey; creator: PublicKey; name: string; symbol: string; uri: string }): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMEFUN_PROGRAM_ID,
    keys: [
      meta(a.mint, true, true),
      meta(curvePda(a.mint), true),
      meta(a.reserve, true, true),
      meta(a.solVault, true, true),
      meta(NATIVE_MINT, false),
      meta(TOKEN_PROGRAM_ID, false),
      meta(a.creator, true, true),
      meta(TOKEN_2022_PROGRAM_ID, false),
      meta(metadataPda(a.mint), true),
      meta(METAPLEX, false),
      meta(SYSVAR_INSTRUCTIONS_PUBKEY, false),
      meta(SystemProgram.programId, false),
      meta(SYSVAR_RENT_PUBKEY, false),
      meta(globalPda(), false),
    ],
    data: Buffer.concat([IX.create_token, borshString(a.name), borshString(a.symbol), borshString(a.uri)]),
  });
}

interface CurveAccounts {
  mint: PublicKey;
  reserve: PublicKey;
  solVault: PublicKey;
}

/** wrap `lamports` -> buy -> unwrap; the user's Token-2022 ATA is created by the program when empty. */
export function buyIxs(c: CurveAccounts, user: PublicKey, lamports: bigint, minOut: bigint): TransactionInstruction[] {
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, user, true);
  const ata = getAssociatedTokenAddressSync(c.mint, user, true, TOKEN_2022_PROGRAM_ID);
  return [
    createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: user, toPubkey: wsol, lamports }),
    createSyncNativeInstruction(wsol),
    new TransactionInstruction({
      programId: MEMEFUN_PROGRAM_ID,
      keys: [
        meta(curvePda(c.mint), true),
        meta(c.reserve, true),
        meta(c.solVault, true),
        meta(ata, true),
        meta(wsol, true),
        meta(c.mint, false),
        meta(NATIVE_MINT, false),
        meta(user, true, true),
        meta(TOKEN_2022_PROGRAM_ID, false),
        meta(TOKEN_PROGRAM_ID, false),
        meta(ASSOCIATED_TOKEN_PROGRAM_ID, false),
        meta(SystemProgram.programId, false),
      ],
      data: Buffer.concat([IX.buy, u64(lamports), u64(minOut)]),
    }),
    createCloseAccountInstruction(wsol, user, user),
  ];
}

/** wSOL ATA (payout) -> sell -> unwrap. */
export function sellIxs(c: CurveAccounts, user: PublicKey, amount: bigint, minLamports: bigint): TransactionInstruction[] {
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, user, true);
  const ata = getAssociatedTokenAddressSync(c.mint, user, true, TOKEN_2022_PROGRAM_ID);
  return [
    createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT),
    new TransactionInstruction({
      programId: MEMEFUN_PROGRAM_ID,
      keys: [
        meta(curvePda(c.mint), true),
        meta(c.reserve, true),
        meta(c.solVault, true),
        meta(ata, true),
        meta(wsol, true),
        meta(c.mint, false),
        meta(NATIVE_MINT, false),
        meta(user, true, true),
        meta(TOKEN_2022_PROGRAM_ID, false),
        meta(TOKEN_PROGRAM_ID, false),
      ],
      data: Buffer.concat([IX.sell, u64(amount), u64(minLamports)]),
    }),
    createCloseAccountInstruction(wsol, user, user),
  ];
}

/** claim_creator_fees: curve vault -> `destination` (a WSOL token account); the creator signs. */
export function claimCreatorFeesIx(mint: PublicKey, solVault: PublicKey, creator: PublicKey, destination: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMEFUN_PROGRAM_ID,
    keys: [meta(curvePda(mint), true), meta(solVault, true), meta(creator, false, true), meta(destination, true), meta(NATIVE_MINT, false), meta(TOKEN_PROGRAM_ID, false)],
    data: IX.claim_creator_fees,
  });
}

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------

export interface MemeFunAdapterOptions {
  connection: Connection;
  defaultVault: Signer;
  vaults?: readonly Signer[];
  creators: CreatorKeyring;
  stateDir: string;
  priorityMicroLamports?: number | PriorityPrice;
  pipeline?: TxPipeline | null;
  lookupTables?: LookupTables;
}

export class MemeFunAdapter {
  readonly id = "memefun" as const;
  private readonly connection: Connection;
  private readonly defaultVault: Signer;
  private readonly vaultKeys: Set<string>;
  private readonly creators: CreatorKeyring;
  private readonly priority: PriorityPrice;
  private readonly pipeline: TxPipeline | null;
  private readonly alts: LookupTables;

  constructor(o: MemeFunAdapterOptions) {
    this.connection = o.connection;
    this.defaultVault = o.defaultVault;
    this.vaultKeys = new Set([o.defaultVault, ...(o.vaults ?? [])].map((v) => v.publicKey.toBase58()));
    this.creators = o.creators;
    const p = o.priorityMicroLamports ?? 0;
    this.priority = typeof p === "number" ? fixedPrice(p) : p;
    this.pipeline = o.pipeline ?? null;
    this.alts = o.lookupTables ?? new LookupTables(o.connection, o.stateDir, this.priority, this.pipeline);
  }

  // ---- read side ----------------------------------------------------------

  async loadCurve(mint: PublicKey): Promise<MemeCurve> {
    const acc = await this.rpc(() => this.connection.getAccountInfo(curvePda(mint), "confirmed"));
    if (!acc || !acc.owner.equals(MEMEFUN_PROGRAM_ID)) throw new AdapterError("not_found", `no meme.fun curve for ${mint.toBase58()}`);
    return decodeCurve(acc.data);
  }

  async status(_mint: string): Promise<CurveStatus> {
    await this.loadCurve(parseMint(_mint));
    return "curve"; // the curve is the token's only venue for life (no migration)
  }

  /** Tokens for `lamports` (buy) / net lamports for `tokens` (sell), by simulating the real instruction. */
  async quote(mint: string, side: "buy" | "sell", amount: bigint): Promise<Quote> {
    if (amount <= 0n) throw new AdapterError("bad_request", "amount must be > 0");
    const m = parseMint(mint);
    const c = await this.loadCurve(m);
    const v = this.defaultVault.publicKey;
    const ev = side === "buy" ? await this.simulateTrade(buyIxs(this.accounts(c), v, amount, 1n), v, CU_MEME_TRADE) : await this.simulateTrade(sellIxs(this.accounts(c), v, amount, 0n), v, CU_MEME_TRADE);
    const mk = await this.market(mint);
    return { venue: this.id, mint, side, amountIn: amount, amountOut: side === "buy" ? ev.tokenAmount : ev.solAmount, priceSol: mk.priceSol, marketCapSol: mk.marketCapSol, status: "curve", decimals: MEMEFUN_DECIMALS };
  }

  /** Spot price = price of a 0.001 SOL buy (simulated); cap = price x supply. */
  async market(mint: string): Promise<{ priceSol: string; marketCapSol: string; status: CurveStatus }> {
    const m = parseMint(mint);
    const c = await this.loadCurve(m);
    const v = this.defaultVault.publicKey;
    const ev = await this.simulateTrade(buyIxs(this.accounts(c), v, PROBE_LAMPORTS, 1n), v, CU_MEME_TRADE);
    if (ev.tokenAmount <= 0n) throw new AdapterError("venue_unavailable", "meme.fun price probe returned nothing");
    // lamports per base unit -> SOL per whole token (18 decimals)
    const price18 = (PROBE_LAMPORTS * 10n ** BigInt(MEMEFUN_DECIMALS) * 10n ** 18n) / (ev.tokenAmount * 10n ** 9n);
    const cap = (price18 * c.tokenTotalSupply) / 10n ** BigInt(MEMEFUN_DECIMALS);
    return { priceSol: formatUnits(price18, 18), marketCapSol: formatUnits(cap, 18), status: "curve" };
  }

  async tokenSymbol(mint: string): Promise<string | null> {
    const md = await this.rpc(() => this.connection.getAccountInfo(metadataPda(parseMint(mint)))).catch(() => null);
    if (!md) return null;
    return parseMetaplexMetadata(md.data)?.symbol ?? null;
  }

  // ---- write side ---------------------------------------------------------

  async prepareCreate(m: TokenMeta, initialBuy: bigint, minOut: bigint, opts: CreateOptions = {}): Promise<PreparedCreate> {
    validateMeta(m);
    if (Buffer.byteLength(m.symbol, "utf8") > 10) throw new AdapterError("bad_request", "symbol: at most 10 bytes on meme.fun");
    if (!isContentAddressed(m.uri)) throw new AdapterError("venue_unavailable", "meme.fun needs IPFS / Arweave metadata (set PINATA_JWT)");
    if (opts.quote && opts.quote.toUpperCase() !== "SOL") throw new AdapterError("venue_unavailable", "meme.fun is SOL only");
    if (opts.mintKeypair) throw new AdapterError("bad_request", "fair launch is pump.fun only");
    if (initialBuy < 0n || minOut < 0n) throw new AdapterError("bad_request", "amounts must be >= 0");
    const vault = opts.vault ?? this.defaultVault;
    await this.requireSol(vault.publicKey, initialBuy + 30_000_000n);
    const creatorIndex = opts.creatorIndex ?? (await this.creators.allocate());
    const creatorKp = this.creators.keypair(creatorIndex);
    if (this.vaultKeys.has(creatorKp.publicKey.toBase58())) throw new AdapterError("internal", "creator collides with a vault");
    const mintKp = Keypair.generate();
    const reserveKp = Keypair.generate();
    const solVaultKp = Keypair.generate();
    const accs = { mint: mintKp.publicKey, reserve: reserveKp.publicKey, solVault: solVaultKp.publicKey };

    const build = (fund: bigint, minTokens: bigint, a: CurveAccounts = accs, payer = vault.publicKey, creator = creatorKp.publicKey): TransactionInstruction[] => [
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: creator, lamports: fund }),
      createTokenIx({ ...a, creator, name: m.name, symbol: m.symbol, uri: m.uri }),
      ...(initialBuy > 0n ? buyIxs(a, payer, initialBuy, minTokens) : []),
    ];
    // 1) measure: what the create takes from the creator (it must end at exactly 0) and what the first buy gets
    const sim = await this.simulate(build(SIM_CREATOR_FUND, 1n), vault.publicKey, CU_MEME_CREATE, [creatorKp.publicKey]);
    const left = BigInt(sim.accounts[0]?.lamports ?? 0);
    const spent = SIM_CREATOR_FUND - left;
    if (spent <= 0n || spent >= SIM_CREATOR_FUND) throw new AdapterError("venue_unavailable", "meme.fun create cost could not be measured");
    const expected = initialBuy > 0n ? (sim.trade?.tokenAmount ?? 0n) : 0n;
    if (initialBuy > 0n && expected < minOut) throw new AdapterError("slippage", `first buy quote ${expected} < minOut ${minOut}`);
    await this.requireSol(vault.publicKey, initialBuy + spent + 10_000_000n);

    const ixs = build(spent, minOut > 0n ? minOut : 1n);
    const table = await this.lookupTable(vault, ixs, () => {
      const r = () => Keypair.generate().publicKey;
      return build(spent, 1n, { mint: r(), reserve: r(), solVault: r() }, vault.publicKey, r());
    });
    const signed = await this.sign(ixs, vault, CU_MEME_CREATE, [creatorKp, mintKp, reserveKp, solVaultKp], [table]);
    return { ...signed, kind: "create", mint: mintKp.publicKey.toBase58(), vault: vault.publicKey.toBase58(), creator: creatorKp.publicKey.toBase58(), creatorIndex, expectedOut: expected };
  }

  async prepareBuy(mint: string, lamportsIn: bigint, minOut: bigint, opts: TradeOptions = {}): Promise<PreparedTrade> {
    if (lamportsIn <= 0n || minOut < 0n) throw new AdapterError("bad_request", "bad buy amounts");
    const vault = opts.vault ?? this.defaultVault;
    const c = await this.loadCurve(parseMint(mint));
    await this.requireSol(vault.publicKey, lamportsIn + 5_000_000n);
    const ixs = buyIxs(this.accounts(c), vault.publicKey, lamportsIn, minOut > 0n ? minOut : 1n);
    const ev = await this.simulateTrade(ixs, vault.publicKey, CU_MEME_TRADE);
    if (ev.tokenAmount < minOut) throw new AdapterError("slippage", `quote ${ev.tokenAmount} < minOut ${minOut}`);
    const signed = await this.sign(ixs, vault, CU_MEME_TRADE);
    return { ...signed, kind: "buy", mint, vault: vault.publicKey.toBase58(), expectedOut: ev.tokenAmount };
  }

  async prepareSell(mint: string, amount: bigint, minLamports: bigint, opts: TradeOptions = {}): Promise<PreparedTrade> {
    if (amount <= 0n || minLamports < 0n) throw new AdapterError("bad_request", "bad sell amounts");
    const vault = opts.vault ?? this.defaultVault;
    const m = parseMint(mint);
    const c = await this.loadCurve(m);
    const ata = getAssociatedTokenAddressSync(m, vault.publicKey, true, TOKEN_2022_PROGRAM_ID);
    const info = await this.rpc(() => this.connection.getAccountInfo(ata, "confirmed"));
    const held = info ? unpackAccount(ata, info, TOKEN_2022_PROGRAM_ID).amount : 0n;
    if (held < amount) throw new AdapterError("insufficient_tokens", `vault holds ${held} < ${amount}`);
    await this.requireSol(vault.publicKey, 2_200_000n);
    const ixs = sellIxs(this.accounts(c), vault.publicKey, amount, minLamports);
    const ev = await this.simulateTrade(ixs, vault.publicKey, CU_MEME_TRADE);
    if (ev.solAmount < minLamports) throw new AdapterError("slippage", `quote ${ev.solAmount} < minOut ${minLamports}`);
    const signed = await this.sign(ixs, vault, CU_MEME_TRADE);
    return { ...signed, kind: "sell", mint, vault: vault.publicKey.toBase58(), expectedOut: ev.solAmount };
  }

  async submit(p: SignedTx): Promise<{ signature: string; slot: number }> {
    try {
      return await broadcastAndConfirm(this.connection, p, this.pipeline?.broadcaster);
    } catch (e) {
      throw this.sendError(e);
    }
  }

  // ---- results ------------------------------------------------------------

  async createResult(signature: string, vault: string): Promise<CreateResult | null> {
    const tx = await fetchTx(this.connection, signature, 10).catch(() => null);
    if (!tx) return null;
    const created = anchorEventPayloads(tx, MEMEFUN_PROGRAM_ID, MEMEFUN_EVENTS.CreateEvent).map(decodeCreateEvent).find((e) => e !== null);
    if (!created) return null;
    const trade = this.trades(tx).find((e) => e.mint.equals(created.mint) && e.isBuy && e.user.toBase58() === vault);
    return {
      venue: this.id,
      kind: "create",
      signature,
      slot: tx.slot,
      mint: created.mint.toBase58(),
      vault,
      creator: created.creator.toBase58(),
      name: created.name,
      symbol: created.symbol,
      uri: created.uri,
      tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
      tokenAmount: trade?.tokenAmount ?? 0n,
      solAmount: trade?.solAmount ?? 0n,
      networkFee: BigInt(tx.meta?.fee ?? 0),
      blockTime: tx.blockTime ?? null,
      decimals: MEMEFUN_DECIMALS,
      amountsKnown: true,
      fromEvent: true,
      creatorFee: null, // the event carries no fee split: core estimates (0.98 % below 350 SOL real liquidity)
    };
  }

  async tradeResult(kind: "buy" | "sell", signature: string, vault: string, mint: string): Promise<TxResult | null> {
    const tx = await fetchTx(this.connection, signature, 10).catch(() => null);
    if (!tx) return null;
    const ev = this.trades(tx).find((e) => e.mint.toBase58() === mint && e.isBuy === (kind === "buy") && e.user.toBase58() === vault);
    if (!ev) return null;
    return {
      venue: this.id,
      kind,
      signature,
      slot: tx.slot,
      mint,
      vault,
      tokenAmount: ev.tokenAmount,
      solAmount: ev.solAmount,
      networkFee: BigInt(tx.meta?.fee ?? 0),
      blockTime: tx.blockTime ?? null,
      decimals: MEMEFUN_DECIMALS,
      amountsKnown: true,
      fromEvent: true,
    };
  }

  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    return classifyError(err, logs, MEMEFUN_ERRORS, MEMEFUN_PROGRAM_ID.toBase58(), MEMEFUN_ERROR_BY_NAME, "meme.fun");
  }

  // ---- internals ----------------------------------------------------------

  private accounts(c: MemeCurve): CurveAccounts {
    return { mint: c.mint, reserve: c.reserveTokenAccount, solVault: c.solVault };
  }

  private trades(tx: VersionedTransactionResponse): MemeTradeEvent[] {
    return anchorEventPayloads(tx, MEMEFUN_PROGRAM_ID, MEMEFUN_EVENTS.TradeEvent).map(decodeTradeEvent).filter((e): e is MemeTradeEvent => e !== null);
  }

  /** simulateTransaction (no signatures checked, nothing sent) of `ixs` paid by `payer`. */
  private async simulate(ixs: TransactionInstruction[], payer: PublicKey, cu: number, watch: PublicKey[] = []): Promise<{ trade: MemeTradeEvent | null; accounts: ({ lamports: number } | null)[] }> {
    const { blockhash } = await this.rpc(() => this.connection.getLatestBlockhash("confirmed"));
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs] }).compileToV0Message();
    const r = await this.rpc(() =>
      this.connection.simulateTransaction(new VersionedTransaction(msg), {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        ...(watch.length ? { accounts: { encoding: "base64" as const, addresses: watch.map((k) => k.toBase58()) } } : {}),
      }),
    );
    if (r.value.err) throw this.classify(new Error(`simulation failed: ${JSON.stringify(r.value.err)}`), r.value.logs ?? null);
    const fake = { meta: { logMessages: r.value.logs ?? [], err: null }, transaction: { message: { staticAccountKeys: [], compiledInstructions: [] } } } as unknown as VersionedTransactionResponse;
    const trade = this.trades(fake)[0] ?? null;
    return { trade, accounts: (r.value.accounts ?? []).map((a) => (a ? { lamports: a.lamports } : null)) };
  }

  private async simulateTrade(ixs: TransactionInstruction[], payer: PublicKey, cu: number): Promise<MemeTradeEvent> {
    const s = await this.simulate(ixs, payer, cu);
    if (!s.trade) throw new AdapterError("venue_unavailable", "meme.fun simulation emitted no TradeEvent");
    return s.trade;
  }

  private async requireSol(vault: PublicKey, need: bigint): Promise<void> {
    const bal = BigInt(await this.rpc(() => this.connection.getBalance(vault, "confirmed")));
    if (bal < need + FEE_HEADROOM) throw new AdapterError("insufficient_sol", `vault has ${bal} lamports, needs ~${need + FEE_HEADROOM}`);
  }

  private async lookupTable(vault: Signer, ixs: TransactionInstruction[], other: () => TransactionInstruction[]): Promise<AddressLookupTableAccount> {
    try {
      return await this.alts.ensure(vault, [...staticAccounts(ixs, other()), ...(this.pipeline?.tip?.accounts ?? [])]);
    } catch (e) {
      throw this.classify(e);
    }
  }

  private async sign(ixs: TransactionInstruction[], payer: Signer, cu: number, extra: Signer[] = [], lookupTables?: AddressLookupTableAccount[]): Promise<SignedTx> {
    try {
      return await signTx(this.connection, ixs, payer, extra, { computeUnits: cu, priorityMicroLamports: this.priority.microLamports(), tip: this.pipeline?.tip ?? null, ...(lookupTables ? { lookupTables } : {}) });
    } catch (e) {
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
