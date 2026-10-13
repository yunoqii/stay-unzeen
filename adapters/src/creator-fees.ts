import BN from "bn.js";
import {
  PUMP_EVENT_AUTHORITY_PDA,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurvePda,
  creatorVaultPda,
  isLegacyQuoteMint,
  normalizeQuoteMint,
  pumpIdl,
  type BondingCurve,
} from "@pump-fun/pump-sdk";
import {
  DynamicBondingCurveIdl,
  createDbcProgram,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  getTokenProgram,
  type PoolConfig,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountInfo,
  type Keypair,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { anchorEventPayloads } from "./events";
import { deriveCreatorKeypair } from "./keys";
import { toBig } from "./math";
import { DBC_PROGRAM_ID, dbcCoder } from "./meteora";

/**
 * Creator / partner fee collection of the pool's launches (docs/ARCHITECTURE.md
 * "Сбор комиссий (claim)", review-day2 H7).
 *
 * This file only knows venues: what is claimable for ONE fee authority on ONE
 * launch and the instructions that move it to a pool vault. Scheduling,
 * ordering, vault rotation and bookkeeping live in relayer/fee-sweeper.ts.
 *
 * Invariant (H7): one target = one fee authority (a fresh creator address of
 * ONE launch, or the DBC partner key on ONE pool) = one transaction. Nothing in
 * here ever builds instructions for two authorities at once.
 *
 * - pump.fun (SDK 4.0.0): v3 trades leave the creator fee on the curve
 *   (`BondingCurve.creatorFee`); `sweep_creator_fee` (permissionless) moves it
 *   into `creatorVaultPda(creator)`, `collect_creator_fee` pays everything above
 *   the vault's rent to the creator wallet, and a system transfer (signed by the
 *   creator) moves it to the pool vault. The creator wallet ends at 0 lamports.
 * - Meteora DBC (SDK 1.5.13): `claim_creator_trading_fee` (creator signs) and
 *   `claim_trading_fee` (partner = fee claimer of Unzeen's config) pay the
 *   quote fee as wSOL into a temporary token account of the authority that is
 *   closed in the same tx straight to the pool vault (rent and fee); the empty
 *   base-token account the program requires is closed too. The vault pays and
 *   receives, the authority never holds SOL.
 */

export type FeeVenueId = "pumpfun" | "meteora-dbc";
export type FeeKind = "creator" | "partner";

/** Something claimable for one authority on one launch. */
export interface FeeTarget {
  venue: FeeVenueId;
  kind: FeeKind;
  mint: string;
  /** Public key of the signing fee authority (creator address or DBC partner). */
  authority: string;
  /** Lamports that would reach the pool vault now. */
  lamports: bigint;
  /** Lamports the transaction locks for good (pump: creator vault rent when it does not exist yet). */
  lockedRent: bigint;
  /** Lamports the paying vault must front inside the tx (temporary token account rent), returned by the tx. */
  frontLamports: bigint;
}

/** One fee transaction for one target (the sweeper adds the pool prefix and signs). */
export interface FeeTxPlan {
  target: FeeTarget;
  instructions: TransactionInstruction[];
  /** The only signer besides the paying vault. */
  authority: Keypair;
  computeUnits: number;
  /** Lamports that reach the vault when the tx lands as built. */
  expectedLamports: bigint;
}

export interface FeeVenue {
  readonly venue: FeeVenueId;
  /** Everything claimable right now across the pool's launches on this venue. */
  discover(): Promise<FeeTarget[]>;
  /**
   * Re-reads the target and builds its transaction with `vault` as fee payer
   * and receiver. Null when nothing is claimable any more (or the authority
   * no longer owns the launch).
   */
  build(target: FeeTarget, vault: PublicKey): Promise<FeeTxPlan | null>;
  /** Lamports this target's landed tx actually paid to the vault (from events); null = unreadable. */
  collected(tx: VersionedTransactionResponse, target: FeeTarget): bigint | null;
}

// ---------------------------------------------------------------------------
// fee authorities
// ---------------------------------------------------------------------------

/**
 * Public key -> keypair of every creator address the pool ever derived
 * (indexes 0..count-1 of the creator master seed). Holds no mapping to users
 * or tokens: which launch a creator belongs to is read from chain.
 */
export class CreatorDirectory {
  private readonly byKey = new Map<string, Keypair>();

  constructor(seed: Uint8Array, count: number) {
    if (!Number.isInteger(count) || count < 0) throw new RangeError("creator count must be >= 0");
    for (let i = 0; i < count; i++) {
      const kp = deriveCreatorKeypair(seed, i);
      this.byKey.set(kp.publicKey.toBase58(), kp);
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  get(pubkey: string): Keypair | undefined {
    return this.byKey.get(pubkey);
  }

  has(pubkey: string): boolean {
    return this.byKey.has(pubkey);
  }

  /** Public keys of the given list that are NOT derivable here (counter behind the public list). */
  missing(pubkeys: Iterable<string>): string[] {
    return [...pubkeys].filter((k) => !this.byKey.has(k));
  }
}

// ---------------------------------------------------------------------------
// cost / threshold
// ---------------------------------------------------------------------------

/** Base fee per signature (lamports). */
export const LAMPORTS_PER_SIGNATURE = 5_000n;

/** Network cost of one fee tx: signatures + compute price x limit + pool tip. */
export function feeTxCost(o: { signatures: number; computeUnits: number; microLamportsPerCu: number; tipLamports: bigint }): bigint {
  const prio = (BigInt(o.computeUnits) * BigInt(o.microLamportsPerCu) + 999_999n) / 1_000_000n;
  return BigInt(o.signatures) * LAMPORTS_PER_SIGNATURE + prio + o.tipLamports;
}

export interface ThresholdPolicy {
  /** Never collect less than this (lamports). */
  minLamports: bigint;
  /** And never less than `costMultiple` x (tx cost + rent the tx locks). */
  costMultiple: bigint;
}

export const DEFAULT_THRESHOLD: ThresholdPolicy = { minLamports: 2_000_000n, costMultiple: 5n };

/** Smallest claimable amount worth a transaction: strictly above its cost, whatever the policy says. */
export function sweepThreshold(cost: bigint, lockedRent: bigint, p: ThresholdPolicy = DEFAULT_THRESHOLD): bigint {
  const spend = cost + lockedRent;
  const byCost = spend * (p.costMultiple > 1n ? p.costMultiple : 1n);
  const floor = spend + 1n;
  return [p.minLamports, byCost, floor].reduce((a, b) => (a > b ? a : b));
}

// ---------------------------------------------------------------------------
// pump.fun
// ---------------------------------------------------------------------------

/** Compute limit of sweep + collect + transfer (measured on devnet, ~3x headroom). */
export const PUMP_FEE_CU = 120_000;
/** Compute limit of the DBC claim with its temporary token accounts. */
export const DBC_FEE_CU = 150_000;

const COLLECT_CREATOR_FEE_DISC = Buffer.from(
  (pumpIdl.instructions as ReadonlyArray<{ name: string; discriminator: number[] }>).find((i) => i.name === "collect_creator_fee")!
    .discriminator,
);
const COLLECT_EVENT_DISC = Buffer.from(
  (pumpIdl.events as ReadonlyArray<{ name: string; discriminator: number[] }>).find((e) => e.name === "CollectCreatorFeeEvent")!
    .discriminator,
);

/** pump `collect_creator_fee`: everything above the creator vault's rent -> creator wallet. Permissionless. */
export function collectCreatorFeeIx(creator: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: false, isWritable: true },
      { pubkey: creatorVaultPda(creator), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: COLLECT_CREATOR_FEE_DISC,
  });
}

/** What one pump creator has waiting, from its curve, creator vault and wallet. */
export interface PumpFeeState {
  /** Unswept creator fee on the curve (v3 trades). */
  bucket: bigint;
  /** Creator vault lamports above its rent floor (0 when the vault does not exist). */
  vaultAboveRent: bigint;
  vaultExists: boolean;
  /** Lamports already sitting on the creator wallet (normally 0). */
  wallet: bigint;
  /**
   * Lamports the vault gives the creator wallet in the same tx: pump's
   * `collect_creator_fee` pays nothing unless the wallet stays rent-exempt
   * afterwards ("Creator account does not have enough rent-exemption
   * lamports", devnet 2026-10-12), and a fresh creator holds 0.
   * E15 (review-day8): this rent STAYS on the creator wallet for good (~0.00089
   * SOL per launch, pool cost). Returning it made the final transfer exact, so
   * a fee accrued between build and landing left a remainder below rent and
   * the tx failed "insufficient funds for rent". Now the wallet ends at
   * `walletRent` + whatever accrued late; that excess goes next pass (`wallet`).
   */
  topUp: bigint;
  /** Rent floor the creator wallet keeps (0-byte system account). */
  walletRent: bigint;
}

export function pumpFeeState(
  curve: Pick<BondingCurve, "creatorFee">,
  vault: Pick<AccountInfo<Buffer>, "lamports" | "data"> | null,
  vaultRent: bigint,
  walletLamports: bigint,
  walletRent: bigint = vaultRent,
): PumpFeeState {
  const lamports = vault ? BigInt(vault.lamports) : 0n;
  return {
    bucket: toBig(curve.creatorFee),
    vaultAboveRent: vault && lamports > vaultRent ? lamports - vaultRent : 0n,
    vaultExists: vault !== null,
    wallet: walletLamports,
    topUp: walletLamports >= walletRent ? 0n : walletRent - walletLamports,
    walletRent,
  };
}

/** Lamports that reach the vault (fees + what the wallet held above its rent floor); the rent top-up is not counted. */
export function pumpTransferAmount(s: PumpFeeState): bigint {
  return s.bucket + s.vaultAboveRent + (s.wallet > s.walletRent ? s.wallet - s.walletRent : 0n);
}

/**
 * Lamports the final creator -> vault transfer moves: everything above the
 * rent floor as known at build time (E15). The wallet keeps >= its rent, so a
 * late accrual only stays there instead of failing the tx.
 */
export function pumpReturnAmount(s: PumpFeeState): bigint {
  return pumpTransferAmount(s);
}

/**
 * sweep (only when the curve holds fees) + rent loan vault -> creator (when
 * the wallet is below rent) + collect + transfer everything creator -> vault.
 * The vault pays the network fee and, when the creator vault does not exist
 * yet, its rent (`sweep_creator_fee` creates it).
 */
export async function pumpFeeInstructions(o: {
  mint: PublicKey;
  creator: PublicKey;
  quoteMint: PublicKey;
  vault: PublicKey;
  state: PumpFeeState;
}): Promise<TransactionInstruction[]> {
  const ixs: TransactionInstruction[] = [];
  if (o.state.bucket > 0n) {
    ixs.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer: o.vault, mint: o.mint, creator: o.creator, quoteMint: o.quoteMint }));
  }
  if (o.state.topUp > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: o.vault, toPubkey: o.creator, lamports: o.state.topUp }));
  ixs.push(collectCreatorFeeIx(o.creator));
  const back = pumpReturnAmount(o.state);
  if (back > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: o.creator, toPubkey: o.vault, lamports: back }));
  return ixs;
}

/** Source of candidate mints (pool pins, recorded creates, operator list). Public data only. */
export interface MintSource {
  mints(): Promise<string[]>;
}

export class StaticMintSource implements MintSource {
  constructor(private readonly list: readonly string[]) {}
  async mints(): Promise<string[]> {
    return [...this.list];
  }
}

/** Union of several sources, deduplicated; a failing source is skipped (reported via `onError`). */
export class UnionMintSource implements MintSource {
  constructor(
    private readonly sources: readonly MintSource[],
    private readonly onError: (e: unknown) => void = () => undefined,
  ) {}
  async mints(): Promise<string[]> {
    const out = new Set<string>();
    for (const s of this.sources) {
      try {
        for (const m of await s.mints()) out.add(m);
      } catch (e) {
        this.onError(e);
      }
    }
    return [...out];
  }
}

type Rpc = Pick<Connection, "getMultipleAccountsInfo" | "getMinimumBalanceForRentExemption">;

const BATCH = 100;

async function multi(rpc: Rpc, keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += BATCH) {
    out.push(...(await rpc.getMultipleAccountsInfo(keys.slice(i, i + BATCH), "confirmed")));
  }
  return out;
}

/**
 * pump.fun creator fees of the pool's launches. pump `create_v2` takes the
 * creator as an argument (it is not an account of any tx until a fee claim),
 * so launches are found from candidate mints (pins / creates the relayer
 * recorded): a curve whose `creator` is one of our derived addresses is ours.
 */
export class PumpFeeVenue implements FeeVenue {
  readonly venue = "pumpfun" as const;
  private rent0: bigint | null = null;
  /** Diagnostics of the last discover (counts only). */
  lastSkipped = { graduated: 0, nonSol: 0 };

  constructor(
    private readonly rpc: Rpc,
    private readonly creators: CreatorDirectory,
    private readonly mints: MintSource,
  ) {}

  async discover(): Promise<FeeTarget[]> {
    const mints = [...new Set(await this.mints.mints())].map((m) => new PublicKey(m));
    const curves = await multi(this.rpc, mints.map((m) => bondingCurvePda(m)));
    const ours: { mint: PublicKey; curve: BondingCurve; creator: PublicKey }[] = [];
    this.lastSkipped = { graduated: 0, nonSol: 0 };
    curves.forEach((info, i) => {
      if (!info || !info.owner.equals(PUMP_PROGRAM_ID)) return;
      let curve: BondingCurve;
      try {
        curve = PUMP_SDK.decodeBondingCurve(info);
      } catch {
        return;
      }
      if (!this.creators.has(curve.creator.toBase58())) return;
      if (!isLegacyQuoteMint(normalizeQuoteMint(curve.quoteMint))) {
        this.lastSkipped.nonSol++;
        return;
      }
      ours.push({ mint: mints[i]!, curve, creator: curve.creator });
    });
    if (ours.length === 0) return [];
    const accs = await multi(this.rpc, ours.flatMap((o) => [creatorVaultPda(o.creator), o.creator]));
    const rent = await this.vaultRent();
    return ours.map((o, i) => {
      const vault = accs[2 * i] ?? null;
      const wallet = BigInt(accs[2 * i + 1]?.lamports ?? 0);
      if (o.curve.complete) this.lastSkipped.graduated++; // curve leg only; PumpSwap creator fees are not collected here
      return this.target(o.mint, o.creator, pumpFeeState(o.curve, vault, rent, wallet), rent);
    });
  }

  async build(t: FeeTarget, vault: PublicKey): Promise<FeeTxPlan | null> {
    const kp = this.creators.get(t.authority);
    if (!kp) return null;
    const mint = new PublicKey(t.mint);
    const creator = kp.publicKey;
    const [curveInfo, vaultInfo, walletInfo] = await this.rpc.getMultipleAccountsInfo(
      [bondingCurvePda(mint), creatorVaultPda(creator), creator],
      "confirmed",
    );
    if (!curveInfo) return null;
    const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
    if (!curve.creator.equals(creator)) return null; // creator changed (CTO): not ours any more
    const rent = await this.vaultRent();
    const state = pumpFeeState(curve, vaultInfo ?? null, rent, BigInt(walletInfo?.lamports ?? 0));
    const fresh = this.target(mint, creator, state, rent);
    if (fresh.lamports <= 0n) return null;
    const instructions = await pumpFeeInstructions({ mint, creator, quoteMint: curve.quoteMint, vault, state });
    return { target: fresh, instructions, authority: kp, computeUnits: PUMP_FEE_CU, expectedLamports: pumpTransferAmount(state) };
  }

  collected(tx: VersionedTransactionResponse, t: FeeTarget): bigint | null {
    if (tx.meta?.err) return null;
    // E15: the creator wallet keeps its rent (+ any late accrual), so the vault got
    // exactly the creator -> vault system transfer of this (successful) tx.
    const creator = new PublicKey(t.authority);
    const keys = tx.transaction.message.getAccountKeys(
      tx.meta?.loadedAddresses ? { accountKeysFromLookups: tx.meta.loadedAddresses } : undefined,
    );
    const events = anchorEventPayloads(tx, PUMP_PROGRAM_ID, COLLECT_EVENT_DISC).map((p) => {
      try {
        return PUMP_SDK.decodeCollectCreatorFeeEventBc(p);
      } catch {
        return null;
      }
    });
    if (!events.some((e) => e?.creator.equals(creator))) return null;
    let back = 0n;
    for (const ci of tx.transaction.message.compiledInstructions) {
      if (!keys.get(ci.programIdIndex)?.equals(SystemProgram.programId)) continue;
      const d = Buffer.from(ci.data);
      if (d.length !== 12 || d.readUInt32LE(0) !== 2) continue;
      if (keys.get(ci.accountKeyIndexes[0]!)?.equals(creator)) back += d.readBigUInt64LE(4);
    }
    return back;
  }

  private target(mint: PublicKey, creator: PublicKey, s: PumpFeeState, rent: bigint): FeeTarget {
    return {
      venue: this.venue,
      kind: "creator",
      mint: mint.toBase58(),
      authority: creator.toBase58(),
      lamports: pumpTransferAmount(s),
      // creator vault rent (when sweep creates it) + the wallet rent top-up (E15: stays on the creator)
      lockedRent: (!s.vaultExists && s.bucket > 0n ? rent : 0n) + s.topUp,
      frontLamports: 0n,
    };
  }

  private async vaultRent(): Promise<bigint> {
    this.rent0 ??= BigInt(await this.rpc.getMinimumBalanceForRentExemption(0));
    return this.rent0;
  }
}

// ---------------------------------------------------------------------------
// Meteora DBC
// ---------------------------------------------------------------------------

type DbcProgram = ReturnType<typeof createDbcProgram>["program"];
let offlineDbc: DbcProgram | null = null;
function dbcProgram(): DbcProgram {
  // Instruction building only: the connection is never used.
  offlineDbc ??= createDbcProgram(new Connection("http://127.0.0.1:8899")).program;
  return offlineDbc;
}

type PoolState = VirtualPool["poolState"];

/** Token-account rent of the temporary accounts (Token-2022 base ATA with extensions + wSOL). */
export const DBC_FRONT_LAMPORTS = 5_000_000n;

/**
 * claim (creator or partner) into temporary token accounts of the authority,
 * then close both to the vault: wSOL account (rent + quote fee) and the empty
 * base-token account (rent). Base fee is claimed as 0 (Unzeen's config takes
 * fees in SOL only), so the base account is empty and can be closed.
 */
export async function dbcFeeInstructions(o: {
  kind: FeeKind;
  pool: PublicKey;
  state: Pick<PoolState, "baseMint" | "baseVault" | "quoteVault" | "config">;
  config: Pick<PoolConfig, "tokenType" | "quoteMint" | "quoteTokenFlag">;
  authority: PublicKey;
  vault: PublicKey;
  quoteAmount: bigint;
}): Promise<TransactionInstruction[]> {
  const baseProgram = getTokenProgram(o.config.tokenType);
  const quoteProgram = getTokenProgram(o.config.quoteTokenFlag);
  if (!o.config.quoteMint.equals(NATIVE_MINT) || !quoteProgram.equals(TOKEN_PROGRAM_ID)) {
    throw new Error("DBC fee claim: only SOL-quoted pools are supported");
  }
  const baseAta = getAssociatedTokenAddressSync(o.state.baseMint, o.authority, true, baseProgram);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, o.authority, true, quoteProgram);
  const accounts = {
    poolAuthority: deriveDbcPoolAuthority(),
    pool: o.pool,
    tokenAAccount: baseAta,
    tokenBAccount: wsolAta,
    baseVault: o.state.baseVault,
    quoteVault: o.state.quoteVault,
    baseMint: o.state.baseMint,
    quoteMint: NATIVE_MINT,
    tokenBaseProgram: baseProgram,
    tokenQuoteProgram: quoteProgram,
  };
  const program = dbcProgram();
  const claim =
    o.kind === "creator"
      ? await program.methods
          .claimCreatorTradingFee(new BN(0), new BN(o.quoteAmount.toString()))
          .accountsPartial({ ...accounts, creator: o.authority })
          .instruction()
      : await program.methods
          .claimTradingFee(new BN(0), new BN(o.quoteAmount.toString()))
          .accountsPartial({ ...accounts, config: o.state.config, feeClaimer: o.authority })
          .instruction();
  return [
    createAssociatedTokenAccountIdempotentInstruction(o.vault, baseAta, o.authority, o.state.baseMint, baseProgram),
    createAssociatedTokenAccountIdempotentInstruction(o.vault, wsolAta, o.authority, NATIVE_MINT, quoteProgram),
    claim,
    createCloseAccountInstruction(wsolAta, o.vault, o.authority, [], quoteProgram),
    createCloseAccountInstruction(baseAta, o.vault, o.authority, [], baseProgram),
  ];
}

/** Claimable SOL of one side of a pool (QuoteToken collect mode: fees are in the quote). */
export function dbcClaimable(state: Pick<PoolState, "creatorQuoteFee" | "partnerQuoteFee">, kind: FeeKind): bigint {
  return toBig(kind === "creator" ? state.creatorQuoteFee : state.partnerQuoteFee);
}

function evtDisc(name: string): Buffer {
  const ev = (DynamicBondingCurveIdl.events as ReadonlyArray<{ name: string; discriminator: number[] }>).find((e) => e.name === name);
  if (!ev) throw new Error(`DBC IDL has no event ${name}`);
  return Buffer.from(ev.discriminator);
}
const EVT_CLAIM_CREATOR = evtDisc("EvtClaimCreatorTradingFee");
const EVT_CLAIM_PARTNER = evtDisc("EvtClaimTradingFee");

/** Pool accounts of a config (getProgramAccounts); injectable for tests. */
export interface DbcPoolLister {
  pools(config: PublicKey): Promise<{ address: PublicKey; state: PoolState }[]>;
  pool(address: PublicKey): Promise<PoolState | null>;
  config(address: PublicKey): Promise<PoolConfig>;
}

/** Live lister over RPC (`getProgramAccounts` filtered by config at offset 72, as the SDK does). */
export class RpcDbcPoolLister implements DbcPoolLister {
  constructor(private readonly connection: Pick<Connection, "getProgramAccounts" | "getAccountInfo">) {}

  async pools(config: PublicKey): Promise<{ address: PublicKey; state: PoolState }[]> {
    const res = await this.connection.getProgramAccounts(DBC_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 72, bytes: config.toBase58() } }],
    });
    const out: { address: PublicKey; state: PoolState }[] = [];
    for (const r of res) {
      try {
        const v = dbcCoder().accounts.decode("virtualPool", r.account.data) as VirtualPool;
        out.push({ address: r.pubkey, state: v.poolState });
      } catch {
        // other account types under the same offset: ignore
      }
    }
    return out;
  }

  async pool(address: PublicKey): Promise<PoolState | null> {
    const info = await this.connection.getAccountInfo(address, "confirmed");
    if (!info || !info.owner.equals(DBC_PROGRAM_ID)) return null;
    return (dbcCoder().accounts.decode("virtualPool", info.data) as VirtualPool).poolState;
  }

  async config(address: PublicKey): Promise<PoolConfig> {
    const info = await this.connection.getAccountInfo(address, "confirmed");
    if (!info || !info.owner.equals(DBC_PROGRAM_ID)) throw new Error("DBC config account not found");
    return dbcCoder().accounts.decode("poolConfig", info.data) as PoolConfig;
  }
}

/**
 * Meteora DBC creator + partner fees of all pools of Unzeen's config. Pools
 * are listed by config (no candidate mints needed); the creator side is
 * claimed only for pools whose creator is one of our derived addresses, the
 * partner side only when our partner key is the config's fee claimer.
 */
export class DbcFeeVenue implements FeeVenue {
  readonly venue = "meteora-dbc" as const;
  private cfg: PoolConfig | null = null;

  constructor(
    private readonly lister: DbcPoolLister,
    private readonly configAddress: PublicKey,
    private readonly creators: CreatorDirectory,
    /** Partner key (fee claimer of the config); null = partner side not collected here. */
    private readonly partner: Keypair | null,
  ) {}

  async discover(): Promise<FeeTarget[]> {
    const config = await this.config();
    const partnerOk = this.partner !== null && config.feeClaimer.equals(this.partner.publicKey);
    const out: FeeTarget[] = [];
    for (const { state } of await this.lister.pools(this.configAddress)) {
      if (!state.config.equals(this.configAddress)) continue;
      const mint = state.baseMint.toBase58();
      const creator = state.creator.toBase58();
      if (this.creators.has(creator)) out.push(this.target("creator", mint, creator, dbcClaimable(state, "creator")));
      if (partnerOk) out.push(this.target("partner", mint, this.partner!.publicKey.toBase58(), dbcClaimable(state, "partner")));
    }
    return out;
  }

  async build(t: FeeTarget, vault: PublicKey): Promise<FeeTxPlan | null> {
    const authority = t.kind === "creator" ? this.creators.get(t.authority) : this.partner;
    if (!authority || authority.publicKey.toBase58() !== t.authority) return null;
    const config = await this.config();
    const mint = new PublicKey(t.mint);
    const pool = this.poolAddress(mint);
    const state = await this.lister.pool(pool);
    if (!state || !state.config.equals(this.configAddress)) return null;
    if (t.kind === "creator" && !state.creator.equals(authority.publicKey)) return null; // pool creator transferred
    if (t.kind === "partner" && !config.feeClaimer.equals(authority.publicKey)) return null;
    const amount = dbcClaimable(state, t.kind);
    if (amount <= 0n) return null;
    const instructions = await dbcFeeInstructions({
      kind: t.kind,
      pool,
      state,
      config,
      authority: authority.publicKey,
      vault,
      quoteAmount: amount,
    });
    return {
      target: this.target(t.kind, t.mint, t.authority, amount),
      instructions,
      authority,
      computeUnits: DBC_FEE_CU,
      expectedLamports: amount,
    };
  }

  collected(tx: VersionedTransactionResponse, t: FeeTarget): bigint | null {
    if (tx.meta?.err) return null;
    const pool = this.poolAddress(new PublicKey(t.mint));
    const disc = t.kind === "creator" ? EVT_CLAIM_CREATOR : EVT_CLAIM_PARTNER;
    const name = t.kind === "creator" ? "EvtClaimCreatorTradingFee" : "EvtClaimTradingFee";
    for (const p of anchorEventPayloads(tx, DBC_PROGRAM_ID, disc)) {
      try {
        const ev = dbcCoder().events.decode(Buffer.concat([disc, p]).toString("base64"));
        if (ev?.name !== name) continue;
        const d = ev.data as { pool: PublicKey; tokenQuoteAmount: BN };
        if (d.pool.equals(pool)) return toBig(d.tokenQuoteAmount);
      } catch {
        // layout drift
      }
    }
    return null;
  }

  poolAddress(mint: PublicKey): PublicKey {
    // Same PDA as MeteoraDbcAdapter.poolAddress (SOL quote, Unzeen config).
    return deriveDbcPoolAddress(NATIVE_MINT, mint, this.configAddress);
  }

  private target(kind: FeeKind, mint: string, authority: string, lamports: bigint): FeeTarget {
    return { venue: this.venue, kind, mint, authority, lamports, lockedRent: 0n, frontLamports: DBC_FRONT_LAMPORTS };
  }

  private async config(): Promise<PoolConfig> {
    this.cfg ??= await this.lister.config(this.configAddress);
    return this.cfg;
  }
}
