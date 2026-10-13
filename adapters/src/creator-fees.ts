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
  LaunchpadPool,
  PlatformConfig,
  claimCreatorFee,
  claimPlatformFeeFromVault,
  getPdaCreatorFeeVaultAuth,
  getPdaCreatorVault,
  getPdaLaunchpadPoolId,
  getPdaPlatformFeeVaultAuth,
  getPdaPlatformVault,
} from "@raydium-io/raydium-sdk-v2";
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
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
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
import { anchorEventPayloads, tokenDelta } from "./events";
import { deriveCreatorKeypair } from "./keys";
import { toBig } from "./math";
import { DBC_PROGRAM_ID, dbcCoder } from "./meteora";
import { MEMEFUN_EVENTS, MEMEFUN_PROGRAM_ID, claimCreatorFeesIx, curvePda as memeCurvePda, decodeCurve as decodeMemeCurve, type MemeCurve } from "./memefun";

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

export type FeeVenueId = "pumpfun" | "meteora-dbc" | "raydium-launchlab" | "memefun";
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
  /**
   * Fee collected in a quote token (RELAYER v8 A8): `units` of `mint` would reach the vault's
   * quote ATA (they become quote STOCK). `lamports` is then 0; the sweeper values `units`.
   */
  quote?: { mint: string; units: bigint };
}

/** One fee transaction for one target (the sweeper adds the pool prefix and signs). */
export interface FeeTxPlan {
  target: FeeTarget;
  instructions: TransactionInstruction[];
  /** The only signer besides the paying vault. */
  authority: Keypair;
  computeUnits: number;
  /** Lamports that reach the vault when the tx lands as built (quote targets: quote units). */
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
  /**
   * What this target's landed tx actually paid to the vault: lamports, or quote units when
   * `target.quote` is set. null = unreadable (never guessed).
   */
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
// quote-token fees (RELAYER v8 A8)
// ---------------------------------------------------------------------------

/** Rent of a 165-byte SPL token account (the same on mainnet and devnet). */
export const TOKEN_ACCOUNT_RENT = 2_039_280n;

/** Amount of an SPL / Token-2022 token account (0 when missing). */
export function tokenAccountAmount(acc: Pick<AccountInfo<Buffer>, "data"> | null | undefined): bigint {
  if (!acc || acc.data.length < 72) return 0n;
  return acc.data.readBigUInt64LE(64);
}

/** Decimals of a mint account (SPL / Token-2022 base layout). */
export function mintDecimals(acc: Pick<AccountInfo<Buffer>, "data">): number {
  if (acc.data.length < 45) throw new Error("not a mint account");
  return acc.data.readUInt8(44);
}

/**
 * Authority's quote ATA -> the paying vault's quote ATA (created when missing, the vault pays):
 * the fee becomes the vault's quote STOCK. Signed by the authority (the tx's only fee authority).
 */
export function quoteToVaultIxs(o: { authority: PublicKey; vault: PublicKey; mint: PublicKey; program: PublicKey; units: bigint; decimals: number }): TransactionInstruction[] {
  const from = getAssociatedTokenAddressSync(o.mint, o.authority, true, o.program);
  const to = getAssociatedTokenAddressSync(o.mint, o.vault, true, o.program);
  return [
    createAssociatedTokenAccountIdempotentInstruction(o.vault, to, o.vault, o.mint, o.program),
    createTransferCheckedInstruction(from, o.mint, to, o.authority, o.units, o.decimals, [], o.program),
  ];
}

/** The fee payer of a landed tx (every fee tx is paid by the receiving vault). */
export function feePayerOf(tx: VersionedTransactionResponse): PublicKey {
  return tx.transaction.message.staticAccountKeys[0]!;
}

/** Quote units that reached the paying vault in a successful tx (balance delta of its ATAs). */
export function quoteReceived(tx: VersionedTransactionResponse, mint: PublicKey): bigint | null {
  if (tx.meta?.err) return null;
  if (!tx.meta?.postTokenBalances) return null;
  const d = tokenDelta(tx, feePayerOf(tx), mint);
  return d >= 0n ? d : null;
}

/** Balance change (post - pre) of one token ACCOUNT of a tx; null when the account is not in its balances. */
export function tokenAccountDelta(tx: VersionedTransactionResponse, account: PublicKey): bigint | null {
  const keys = tx.transaction.message.getAccountKeys(tx.meta?.loadedAddresses ? { accountKeysFromLookups: tx.meta.loadedAddresses } : undefined);
  let idx = -1;
  for (let i = 0; i < keys.length; i++) if (keys.get(i)?.equals(account)) idx = i;
  if (idx < 0) return null;
  const pre = tx.meta?.preTokenBalances?.find((b) => b.accountIndex === idx);
  const post = tx.meta?.postTokenBalances?.find((b) => b.accountIndex === idx);
  if (!pre && !post) return null;
  return BigInt(post?.uiTokenAmount.amount ?? "0") - BigInt(pre?.uiTokenAmount.amount ?? "0");
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

const COLLECT_CREATOR_FEE_V2_DISC = Buffer.from(
  (pumpIdl.instructions as ReadonlyArray<{ name: string; discriminator: number[] }>).find((i) => i.name === "collect_creator_fee_v2")!
    .discriminator,
);

/**
 * pump `collect_creator_fee_v2` (token quote): the creator vault's quote ATA -> the creator's
 * quote ATA (which must exist). Permissionless (IDL 4.0.0: no signer).
 */
export function collectCreatorFeeV2Ix(creator: PublicKey, quoteMint: PublicKey, quoteProgram: PublicKey): TransactionInstruction {
  const vault = creatorVaultPda(creator);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(quoteMint, creator, true, quoteProgram), isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(quoteMint, vault, true, quoteProgram), isSigner: false, isWritable: true },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: quoteProgram, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: PUMP_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: COLLECT_CREATOR_FEE_V2_DISC,
  });
}

/** Quote-curve creator fee of one pump creator: curve bucket + creator vault ATA + leftovers on its own ATA. */
export interface PumpQuoteFeeState {
  bucket: bigint;
  vaultAta: bigint;
  vaultAtaExists: boolean;
  creatorAta: bigint;
  creatorAtaExists: boolean;
}

export function pumpQuoteUnits(s: PumpQuoteFeeState): bigint {
  return s.bucket + s.vaultAta + s.creatorAta;
}

/**
 * sweep (bucket -> creator vault ATA) + the creator's quote ATA (vault pays, kept for good:
 * a fee accrued between build and landing stays there for the next pass) + collect_v2 +
 * creator ATA -> vault ATA for exactly the units known at build.
 */
export async function pumpQuoteFeeInstructions(o: {
  mint: PublicKey;
  creator: PublicKey;
  quoteMint: PublicKey;
  quoteProgram: PublicKey;
  decimals: number;
  vault: PublicKey;
  state: PumpQuoteFeeState;
}): Promise<TransactionInstruction[]> {
  const ixs: TransactionInstruction[] = [];
  if (o.state.bucket > 0n) {
    ixs.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer: o.vault, mint: o.mint, creator: o.creator, quoteMint: o.quoteMint, quoteTokenProgram: o.quoteProgram }));
  }
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(o.vault, getAssociatedTokenAddressSync(o.quoteMint, o.creator, true, o.quoteProgram), o.creator, o.quoteMint, o.quoteProgram));
  if (o.state.bucket > 0n || o.state.vaultAta > 0n) ixs.push(collectCreatorFeeV2Ix(o.creator, o.quoteMint, o.quoteProgram));
  ixs.push(...quoteToVaultIxs({ authority: o.creator, vault: o.vault, mint: o.quoteMint, program: o.quoteProgram, units: pumpQuoteUnits(o.state), decimals: o.decimals }));
  return ixs;
}

export function pumpQuoteState(curve: Pick<BondingCurve, "creatorFee">, vaultAta: Pick<AccountInfo<Buffer>, "data"> | null, creatorAta: Pick<AccountInfo<Buffer>, "data"> | null): PumpQuoteFeeState {
  return {
    bucket: toBig(curve.creatorFee),
    vaultAta: tokenAccountAmount(vaultAta),
    vaultAtaExists: vaultAta !== null,
    creatorAta: tokenAccountAmount(creatorAta),
    creatorAtaExists: creatorAta !== null,
  };
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
    const quoted: { mint: PublicKey; curve: BondingCurve; creator: PublicKey; quoteMint: PublicKey }[] = [];
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
      const q = normalizeQuoteMint(curve.quoteMint);
      if (!isLegacyQuoteMint(q)) {
        // RELAYER v8 A8: quote-curve fees are collected in the quote (USDC / ZEC SPL).
        this.lastSkipped.nonSol++;
        quoted.push({ mint: mints[i]!, curve, creator: curve.creator, quoteMint: q });
        return;
      }
      ours.push({ mint: mints[i]!, curve, creator: curve.creator });
    });
    const out: FeeTarget[] = [];
    if (ours.length > 0) {
      const accs = await multi(this.rpc, ours.flatMap((o) => [creatorVaultPda(o.creator), o.creator]));
      const rent = await this.vaultRent();
      ours.forEach((o, i) => {
        const vault = accs[2 * i] ?? null;
        const wallet = BigInt(accs[2 * i + 1]?.lamports ?? 0);
        if (o.curve.complete) this.lastSkipped.graduated++; // curve leg only; PumpSwap creator fees are not collected here
        out.push(this.target(o.mint, o.creator, pumpFeeState(o.curve, vault, rent, wallet), rent));
      });
    }
    if (quoted.length > 0) {
      const qMints = [...new Map(quoted.map((q) => [q.quoteMint.toBase58(), q.quoteMint])).values()];
      const programs = new Map((await multi(this.rpc, qMints)).map((a, i) => [qMints[i]!.toBase58(), a?.owner ?? null]));
      const keys = quoted.flatMap((q) => {
        const prog = programs.get(q.quoteMint.toBase58()) ?? TOKEN_PROGRAM_ID;
        return [getAssociatedTokenAddressSync(q.quoteMint, creatorVaultPda(q.creator), true, prog), getAssociatedTokenAddressSync(q.quoteMint, q.creator, true, prog)];
      });
      const accs = await multi(this.rpc, keys);
      quoted.forEach((q, i) => {
        if (!programs.get(q.quoteMint.toBase58())) return; // quote mint unreadable: next run
        out.push(this.quoteTarget(q.mint, q.creator, q.quoteMint, pumpQuoteState(q.curve, accs[2 * i] ?? null, accs[2 * i + 1] ?? null)));
      });
    }
    return out;
  }

  async build(t: FeeTarget, vault: PublicKey): Promise<FeeTxPlan | null> {
    const kp = this.creators.get(t.authority);
    if (!kp) return null;
    if (t.quote) return this.buildQuote(t, kp, vault);
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

  /** Quote curve: re-read, rebuild for the units known now. */
  private async buildQuote(t: FeeTarget, kp: Keypair, vault: PublicKey): Promise<FeeTxPlan | null> {
    const mint = new PublicKey(t.mint);
    const creator = kp.publicKey;
    const [curveInfo] = await this.rpc.getMultipleAccountsInfo([bondingCurvePda(mint)], "confirmed");
    if (!curveInfo) return null;
    const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
    if (!curve.creator.equals(creator)) return null; // CTO: not ours any more
    const quoteMint = normalizeQuoteMint(curve.quoteMint);
    if (isLegacyQuoteMint(quoteMint) || quoteMint.toBase58() !== t.quote!.mint) return null;
    const [mintInfo] = await this.rpc.getMultipleAccountsInfo([quoteMint], "confirmed");
    if (!mintInfo) return null;
    const prog = mintInfo.owner;
    const [vAta, cAta] = await this.rpc.getMultipleAccountsInfo(
      [getAssociatedTokenAddressSync(quoteMint, creatorVaultPda(creator), true, prog), getAssociatedTokenAddressSync(quoteMint, creator, true, prog)],
      "confirmed",
    );
    const state = pumpQuoteState(curve, vAta ?? null, cAta ?? null);
    const fresh = this.quoteTarget(mint, creator, quoteMint, state);
    if (fresh.quote!.units <= 0n) return null;
    const instructions = await pumpQuoteFeeInstructions({ mint, creator, quoteMint, quoteProgram: prog, decimals: mintDecimals(mintInfo), vault, state });
    return { target: fresh, instructions, authority: kp, computeUnits: PUMP_FEE_CU, expectedLamports: fresh.quote!.units };
  }

  private quoteTarget(mint: PublicKey, creator: PublicKey, quoteMint: PublicKey, s: PumpQuoteFeeState): FeeTarget {
    return {
      venue: this.venue,
      kind: "creator",
      mint: mint.toBase58(),
      authority: creator.toBase58(),
      lamports: 0n,
      // the creator's quote ATA stays (late accruals land there), the creator vault ATA when the sweep creates it
      lockedRent: (s.creatorAtaExists ? 0n : TOKEN_ACCOUNT_RENT) + (!s.vaultAtaExists && s.bucket > 0n ? TOKEN_ACCOUNT_RENT : 0n),
      frontLamports: 0n,
      quote: { mint: quoteMint.toBase58(), units: pumpQuoteUnits(s) },
    };
  }

  collected(tx: VersionedTransactionResponse, t: FeeTarget): bigint | null {
    if (t.quote) return quoteReceived(tx, new PublicKey(t.quote.mint));
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
  /** Non-SOL quote (RELAYER v8 A8): decimals of the quote mint. */
  quoteDecimals?: number;
}): Promise<TransactionInstruction[]> {
  const baseProgram = getTokenProgram(o.config.tokenType);
  const quoteProgram = getTokenProgram(o.config.quoteTokenFlag);
  const sol = o.config.quoteMint.equals(NATIVE_MINT);
  if (sol && !quoteProgram.equals(TOKEN_PROGRAM_ID)) throw new Error("DBC fee claim: unexpected wSOL program");
  if (!sol && o.quoteDecimals === undefined) throw new Error("DBC fee claim: quote decimals needed for a token quote");
  const quoteMint = o.config.quoteMint;
  const baseAta = getAssociatedTokenAddressSync(o.state.baseMint, o.authority, true, baseProgram);
  const wsolAta = getAssociatedTokenAddressSync(quoteMint, o.authority, true, quoteProgram);
  const accounts = {
    poolAuthority: deriveDbcPoolAuthority(),
    pool: o.pool,
    tokenAAccount: baseAta,
    tokenBAccount: wsolAta,
    baseVault: o.state.baseVault,
    quoteVault: o.state.quoteVault,
    baseMint: o.state.baseMint,
    quoteMint,
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
    createAssociatedTokenAccountIdempotentInstruction(o.vault, wsolAta, o.authority, quoteMint, quoteProgram),
    claim,
    // Token quote: the claim pays exactly `quoteAmount` (fees only grow), so the temporary
    // account is emptied into the vault's quote ATA and closed like the wSOL one.
    ...(sol ? [] : quoteToVaultIxs({ authority: o.authority, vault: o.vault, mint: quoteMint, program: quoteProgram, units: o.quoteAmount, decimals: o.quoteDecimals! })),
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
/** One Unzeen DBC config: the SOL one, or a quote one (RELAYER v8 A8: fees in that quote). */
export interface DbcFeeConfig {
  address: PublicKey;
  quoteMint: PublicKey;
  /** Quote decimals (SOL: 9). */
  decimals: number;
}

export class DbcFeeVenue implements FeeVenue {
  readonly venue = "meteora-dbc" as const;
  private readonly cfgs = new Map<string, PoolConfig>();
  private readonly configs: DbcFeeConfig[];

  constructor(
    private readonly lister: DbcPoolLister,
    /** SOL config only (historic form), or every Unzeen config with its quote. */
    configs: PublicKey | readonly DbcFeeConfig[],
    private readonly creators: CreatorDirectory,
    /** Partner key (fee claimer of the configs); null = partner side not collected here. */
    private readonly partner: Keypair | null,
  ) {
    this.configs = configs instanceof PublicKey ? [{ address: configs, quoteMint: NATIVE_MINT, decimals: 9 }] : [...configs];
  }

  /** Historic accessor: the SOL config. */
  get configAddress(): PublicKey {
    return (this.configs.find((c) => c.quoteMint.equals(NATIVE_MINT)) ?? this.configs[0]!).address;
  }

  async discover(): Promise<FeeTarget[]> {
    const out: FeeTarget[] = [];
    for (const c of this.configs) {
      const config = await this.config(c.address);
      const partnerOk = this.partner !== null && config.feeClaimer.equals(this.partner.publicKey);
      for (const { state } of await this.lister.pools(c.address)) {
        if (!state.config.equals(c.address)) continue;
        const mint = state.baseMint.toBase58();
        const creator = state.creator.toBase58();
        if (this.creators.has(creator)) out.push(this.target(c, "creator", mint, creator, dbcClaimable(state, "creator")));
        if (partnerOk) out.push(this.target(c, "partner", mint, this.partner!.publicKey.toBase58(), dbcClaimable(state, "partner")));
      }
    }
    return out;
  }

  async build(t: FeeTarget, vault: PublicKey): Promise<FeeTxPlan | null> {
    const authority = t.kind === "creator" ? this.creators.get(t.authority) : this.partner;
    if (!authority || authority.publicKey.toBase58() !== t.authority) return null;
    const c = this.configOf(t);
    if (!c) return null;
    const config = await this.config(c.address);
    const mint = new PublicKey(t.mint);
    const pool = this.poolAddress(mint, c);
    const state = await this.lister.pool(pool);
    if (!state || !state.config.equals(c.address)) return null;
    if (t.kind === "creator" && !state.creator.equals(authority.publicKey)) return null; // pool creator transferred
    if (t.kind === "partner" && !config.feeClaimer.equals(authority.publicKey)) return null;
    const amount = dbcClaimable(state, t.kind);
    if (amount <= 0n) return null;
    const sol = c.quoteMint.equals(NATIVE_MINT);
    const instructions = await dbcFeeInstructions({
      kind: t.kind,
      pool,
      state,
      config,
      authority: authority.publicKey,
      vault,
      quoteAmount: amount,
      ...(sol ? {} : { quoteDecimals: c.decimals }),
    });
    return {
      target: this.target(c, t.kind, t.mint, t.authority, amount),
      instructions,
      authority,
      computeUnits: DBC_FEE_CU,
      expectedLamports: amount,
    };
  }

  collected(tx: VersionedTransactionResponse, t: FeeTarget): bigint | null {
    if (tx.meta?.err) return null;
    const c = this.configOf(t);
    if (!c) return null;
    const pool = this.poolAddress(new PublicKey(t.mint), c);
    const disc = t.kind === "creator" ? EVT_CLAIM_CREATOR : EVT_CLAIM_PARTNER;
    const name = t.kind === "creator" ? "EvtClaimCreatorTradingFee" : "EvtClaimTradingFee";
    for (const p of anchorEventPayloads(tx, DBC_PROGRAM_ID, disc)) {
      try {
        const ev = dbcCoder().events.decode(Buffer.concat([disc, p]).toString("base64"));
        // The Anchor coder names events in camelCase ("evtClaimCreatorTradingFee"), the IDL in PascalCase.
        if (ev?.name.toLowerCase() !== name.toLowerCase()) continue;
        const d = ev.data as { pool: PublicKey; tokenQuoteAmount: BN };
        if (d.pool.equals(pool)) return toBig(d.tokenQuoteAmount);
      } catch {
        // layout drift
      }
    }
    return null;
  }

  poolAddress(mint: PublicKey, c: DbcFeeConfig = this.configs.find((x) => x.address.equals(this.configAddress))!): PublicKey {
    // Same PDA as MeteoraDbcAdapter.poolAddress (quote mint + Unzeen config).
    return deriveDbcPoolAddress(c.quoteMint, mint, c.address);
  }

  /** Config of a target: by its quote (SOL targets: the SOL config). */
  private configOf(t: FeeTarget): DbcFeeConfig | undefined {
    const q = t.quote ? new PublicKey(t.quote.mint) : NATIVE_MINT;
    return this.configs.find((c) => c.quoteMint.equals(q));
  }

  private target(c: DbcFeeConfig, kind: FeeKind, mint: string, authority: string, amount: bigint): FeeTarget {
    const base = { venue: this.venue, kind, mint, authority, lockedRent: 0n, frontLamports: DBC_FRONT_LAMPORTS };
    return c.quoteMint.equals(NATIVE_MINT) ? { ...base, lamports: amount } : { ...base, lamports: 0n, quote: { mint: c.quoteMint.toBase58(), units: amount } };
  }

  private async config(address: PublicKey): Promise<PoolConfig> {
    const k = address.toBase58();
    let c = this.cfgs.get(k);
    if (!c) {
      c = await this.lister.config(address);
      this.cfgs.set(k, c);
    }
    return c;
  }
}

// ---------------------------------------------------------------------------
// Raydium LaunchLab (RELAYER v8 A8)
// ---------------------------------------------------------------------------

/** Compute limit of a LaunchLab fee claim with its token accounts. */
export const LL_FEE_CU = 150_000;

/**
 * Raydium LaunchLab fees of the pool's launches:
 * - creator side: every launch's creator fee vault (PDA per creator + quote mint, filled on
 *   each trade); `claim_creator_fee` (the fresh creator signs) pays it to the creator's quote
 *   ATA, which the vault creates; SOL (wSOL) is unwrapped straight to the vault by closing
 *   that ATA, a token quote is transferred to the vault's quote ATA (stock).
 * - partner side: Unzeen's own platform only (stonk / bonk fees are theirs); its fee vault per
 *   quote mint (all launches of the platform together), claimed by the platform claim wallet
 *   (= the partner key) with `claim_platform_fee_from_vault`. Pool income: `mint` of the
 *   target is the QUOTE mint (there is no single launch).
 * Candidate launches come from the mint source (pins); a pool is ours when its creator is.
 */
export class LaunchLabFeeVenue implements FeeVenue {
  readonly venue = "raydium-launchlab" as const;

  constructor(
    private readonly rpc: Rpc,
    private readonly program: PublicKey,
    /** Quote mints served (wSOL first), with decimals. */
    private readonly quotes: readonly { mint: PublicKey; decimals: number }[],
    private readonly creators: CreatorDirectory,
    private readonly mints: MintSource,
    /** Partner key = Unzeen platform claim wallet; null = partner side off. */
    private readonly partner: Keypair | null,
    /** Unzeen's platform id; null = not created on this network. */
    private readonly platform: PublicKey | null,
  ) {}

  async discover(): Promise<FeeTarget[]> {
    const out: FeeTarget[] = [];
    const mints = [...new Set(await this.mints.mints())].map((m) => new PublicKey(m));
    const pairs = mints.flatMap((m) => this.quotes.map((q) => ({ mint: m, quote: q.mint })));
    const pools = await multi(this.rpc, pairs.map((p) => getPdaLaunchpadPoolId(this.program, p.mint, p.quote).publicKey));
    const ours: { mint: PublicKey; quote: PublicKey; creator: PublicKey }[] = [];
    pools.forEach((acc, i) => {
      if (!acc || !acc.owner.equals(this.program)) return;
      let creator: PublicKey;
      try {
        creator = LaunchpadPool.decode(acc.data).creator;
      } catch {
        return;
      }
      if (this.creators.has(creator.toBase58())) ours.push({ ...pairs[i]!, creator });
    });
    if (ours.length > 0) {
      const accs = await multi(this.rpc, ours.flatMap((o) => [this.creatorVault(o.creator, o.quote), getAssociatedTokenAddressSync(o.quote, o.creator, true)]));
      ours.forEach((o, i) => out.push(this.target("creator", o.mint.toBase58(), o.creator, o.quote, accs[2 * i] ?? null, accs[2 * i + 1] ?? null)));
    }
    if (this.partner && this.platform && (await this.partnerOk())) {
      const accs = await multi(this.rpc, this.quotes.flatMap((q) => [this.platformVault(q.mint), getAssociatedTokenAddressSync(q.mint, this.partner!.publicKey, true)]));
      this.quotes.forEach((q, i) => out.push(this.target("partner", q.mint.toBase58(), this.partner!.publicKey, q.mint, accs[2 * i] ?? null, accs[2 * i + 1] ?? null)));
    }
    return out;
  }

  async build(t: FeeTarget, vault: PublicKey): Promise<FeeTxPlan | null> {
    const quote = t.quote ? new PublicKey(t.quote.mint) : NATIVE_MINT;
    const q = this.quotes.find((x) => x.mint.equals(quote));
    if (!q) return null;
    let authority: Keypair | undefined;
    let feeVault: PublicKey;
    let claim: (recipient: PublicKey) => TransactionInstruction;
    if (t.kind === "creator") {
      authority = this.creators.get(t.authority);
      if (!authority) return null;
      const [poolAcc] = await this.rpc.getMultipleAccountsInfo([getPdaLaunchpadPoolId(this.program, new PublicKey(t.mint), quote).publicKey], "confirmed");
      if (!poolAcc || !LaunchpadPool.decode(poolAcc.data).creator.equals(authority.publicKey)) return null;
      feeVault = this.creatorVault(authority.publicKey, quote);
      const a = authority.publicKey;
      claim = (r) => claimCreatorFee(this.program, a, getPdaCreatorFeeVaultAuth(this.program).publicKey, feeVault, r, quote, TOKEN_PROGRAM_ID);
    } else {
      if (!this.partner || !this.platform || this.partner.publicKey.toBase58() !== t.authority || !(await this.partnerOk())) return null;
      authority = this.partner;
      feeVault = this.platformVault(quote);
      const a = authority.publicKey;
      const platform = this.platform;
      claim = (r) => claimPlatformFeeFromVault(this.program, platform, a, getPdaPlatformFeeVaultAuth(this.program).publicKey, feeVault, r, quote, TOKEN_PROGRAM_ID);
    }
    const ata = getAssociatedTokenAddressSync(quote, authority.publicKey, true);
    const [fv, own] = await this.rpc.getMultipleAccountsInfo([feeVault, ata], "confirmed");
    const fresh = this.target(t.kind, t.mint, authority.publicKey, quote, fv ?? null, own ?? null);
    const amount = fresh.quote ? fresh.quote.units : fresh.lamports;
    if (amount <= 0n) return null;
    const ixs: TransactionInstruction[] = [createAssociatedTokenAccountIdempotentInstruction(vault, ata, authority.publicKey, quote, TOKEN_PROGRAM_ID)];
    if (tokenAccountAmount(fv) > 0n) ixs.push(claim(ata));
    if (quote.equals(NATIVE_MINT)) {
      // wSOL: closing pays everything (claimed + rent) to the vault, whatever accrued late.
      ixs.push(createCloseAccountInstruction(ata, vault, authority.publicKey, [], TOKEN_PROGRAM_ID));
    } else {
      // Token quote: exactly the units known now; a late accrual stays on the kept ATA (next pass).
      ixs.push(...quoteToVaultIxs({ authority: authority.publicKey, vault, mint: quote, program: TOKEN_PROGRAM_ID, units: amount, decimals: q.decimals }));
    }
    return { target: fresh, instructions: ixs, authority, computeUnits: LL_FEE_CU, expectedLamports: amount };
  }

  collected(tx: VersionedTransactionResponse, t: FeeTarget): bigint | null {
    if (tx.meta?.err) return null;
    if (t.quote) return quoteReceived(tx, new PublicKey(t.quote.mint));
    // SOL: what left the program's fee vault (the closed wSOL account pays it to the vault).
    const feeVault = t.kind === "creator" ? this.creatorVault(new PublicKey(t.authority), NATIVE_MINT) : this.platform ? this.platformVault(NATIVE_MINT) : null;
    if (!feeVault) return null;
    const d = tokenAccountDelta(tx, feeVault);
    return d === null ? 0n : -d; // fee vault not touched: nothing claimed (leftover-only pass)
  }

  private creatorVault(creator: PublicKey, quote: PublicKey): PublicKey {
    return getPdaCreatorVault(this.program, creator, quote).publicKey;
  }

  private platformVault(quote: PublicKey): PublicKey {
    return getPdaPlatformVault(this.program, this.platform!, quote).publicKey;
  }

  private partnerChecked: boolean | null = null;
  /** Unzeen's platform must name our partner key as its claim wallet. */
  private async partnerOk(): Promise<boolean> {
    if (this.partnerChecked !== null) return this.partnerChecked;
    const [acc] = await this.rpc.getMultipleAccountsInfo([this.platform!], "confirmed");
    this.partnerChecked = !!acc && acc.owner.equals(this.program) && PlatformConfig.decode(acc.data).platformClaimFeeWallet.equals(this.partner!.publicKey);
    return this.partnerChecked;
  }

  private target(kind: FeeKind, mint: string, authority: PublicKey, quote: PublicKey, feeVault: Pick<AccountInfo<Buffer>, "data"> | null, own: Pick<AccountInfo<Buffer>, "data"> | null): FeeTarget {
    const base = { venue: this.venue, kind, mint, authority: authority.toBase58() };
    if (quote.equals(NATIVE_MINT)) {
      // wSOL ATA created and closed in the tx: rent fronted, returned.
      return { ...base, lamports: tokenAccountAmount(feeVault) + tokenAccountAmount(own), lockedRent: 0n, frontLamports: TOKEN_ACCOUNT_RENT };
    }
    return {
      ...base,
      lamports: 0n,
      lockedRent: own ? 0n : TOKEN_ACCOUNT_RENT, // the authority's quote ATA stays
      frontLamports: 0n,
      quote: { mint: quote.toBase58(), units: tokenAccountAmount(feeVault) + tokenAccountAmount(own) },
    };
  }
}

// ---------------------------------------------------------------------------
// meme.fun
// ---------------------------------------------------------------------------

/** Compute limit of a meme.fun creator-fee claim (ATA + claim + close). */
export const MEME_FEE_CU = 100_000;

/**
 * meme.fun creator fees: accrued in the curve's WSOL vault (`creator_fees_owed`), paid by
 * `claim_creator_fees` (the fresh creator signs) into the creator's WSOL ATA, which the vault
 * creates and which is closed to the vault in the same tx (fees + rent back). SOL only.
 */
export class MemeFunFeeVenue implements FeeVenue {
  readonly venue = "memefun" as const;

  constructor(
    private readonly rpc: Rpc,
    private readonly creators: CreatorDirectory,
    private readonly mints: MintSource,
  ) {}

  async discover(): Promise<FeeTarget[]> {
    const mints = [...new Set(await this.mints.mints())].map((m) => new PublicKey(m));
    const accs = await multi(this.rpc, mints.map((m) => memeCurvePda(m)));
    const out: FeeTarget[] = [];
    accs.forEach((a, i) => {
      if (!a || !a.owner.equals(MEMEFUN_PROGRAM_ID)) return;
      let c: MemeCurve;
      try {
        c = decodeMemeCurve(a.data);
      } catch {
        return;
      }
      if (this.creators.has(c.creator.toBase58())) out.push(this.target(mints[i]!, c));
    });
    return out;
  }

  async build(t: FeeTarget, vault: PublicKey): Promise<FeeTxPlan | null> {
    const kp = this.creators.get(t.authority);
    if (!kp) return null;
    const mint = new PublicKey(t.mint);
    const [a] = await this.rpc.getMultipleAccountsInfo([memeCurvePda(mint)], "confirmed");
    if (!a || !a.owner.equals(MEMEFUN_PROGRAM_ID)) return null;
    const c = decodeMemeCurve(a.data);
    if (!c.creator.equals(kp.publicKey) || c.creatorFeesOwed <= 0n) return null;
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, kp.publicKey, true);
    const instructions = [
      createAssociatedTokenAccountIdempotentInstruction(vault, wsol, kp.publicKey, NATIVE_MINT),
      claimCreatorFeesIx(mint, c.solVault, kp.publicKey, wsol),
      createCloseAccountInstruction(wsol, vault, kp.publicKey),
    ];
    return { target: this.target(mint, c), instructions, authority: kp, computeUnits: MEME_FEE_CU, expectedLamports: c.creatorFeesOwed };
  }

  collected(tx: VersionedTransactionResponse, t: FeeTarget): bigint | null {
    if (tx.meta?.err) return null;
    for (const p of anchorEventPayloads(tx, MEMEFUN_PROGRAM_ID, MEMEFUN_EVENTS.ClaimEvent)) {
      // ClaimEvent: mint 32 | user 32 | amount u64 | ts i64
      if (p.length < 72) continue;
      if (new PublicKey(p.subarray(0, 32)).toBase58() === t.mint && new PublicKey(p.subarray(32, 64)).toBase58() === t.authority) return p.readBigUInt64LE(64);
    }
    return null;
  }

  private target(mint: PublicKey, c: MemeCurve): FeeTarget {
    return { venue: this.venue, kind: "creator", mint: mint.toBase58(), authority: c.creator.toBase58(), lamports: c.creatorFeesOwed, lockedRent: 0n, frontLamports: TOKEN_ACCOUNT_RENT };
  }
}
