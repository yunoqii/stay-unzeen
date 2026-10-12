import type { BondingCurve, Global } from "@pump-fun/pump-sdk";
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getDefaultAccountState,
  getExtensionData,
  getExtensionTypes,
  getMintCloseAuthority,
  getPermanentDelegate,
  getTransferFeeConfig,
  getTransferHook,
  unpackMint,
} from "@solana/spl-token";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import type { RiskyExtension } from "./types";

/**
 * Pure metric computations of the cheap tier (token-intel.md §1). No I/O:
 * the indexer fetches accounts in uniform batches and hands them here.
 */

export const METAPLEX_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export function metaplexMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_METADATA_PROGRAM_ID,
  )[0];
}

/** num/den as a percentage string with 2 decimals, clamped to [0, 100]. */
export function pct(num: bigint, den: bigint): string {
  if (den <= 0n || num <= 0n) return "0.00";
  let bp = (num * 10_000n) / den;
  if (bp > 10_000n) bp = 10_000n;
  const s = bp.toString().padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

export interface OnchainMetadata {
  name: string;
  symbol: string;
  uri: string;
  immutable: boolean;
}

export interface MintFacts {
  program: "spl-token" | "token-2022";
  tokenProgram: PublicKey;
  supply: bigint;
  decimals: number;
  mintRevoked: boolean;
  freezeRevoked: boolean;
  riskyExtensions: RiskyExtension[];
  /** Token-2022 on-mint metadata (pump create_v2), if any. */
  tokenMetadata: OnchainMetadata | null;
}

/** Mint account -> authorities, dangerous Token-2022 extensions, on-mint metadata. Null if not an SPL mint. */
export function mintFacts(address: PublicKey, info: AccountInfo<Buffer> | null): MintFacts | null {
  if (!info) return null;
  const owner = info.owner;
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) return null;
  let m;
  try {
    m = unpackMint(address, info, owner);
  } catch {
    return null;
  }
  const risky: RiskyExtension[] = [];
  let tokenMetadata: OnchainMetadata | null = null;
  if (owner.equals(TOKEN_2022_PROGRAM_ID) && m.tlvData.length > 0) {
    const types = safe(() => getExtensionTypes(m.tlvData)) ?? [];
    const pd = safe(() => getPermanentDelegate(m));
    if (pd && !pd.delegate.equals(PublicKey.default)) risky.push("permanentDelegate");
    const th = safe(() => getTransferHook(m));
    if (th && !th.programId.equals(PublicKey.default)) risky.push("transferHook");
    const tf = safe(() => getTransferFeeConfig(m));
    if (tf && (tf.olderTransferFee.transferFeeBasisPoints > 0 || tf.newerTransferFee.transferFeeBasisPoints > 0 || !tf.transferFeeConfigAuthority.equals(PublicKey.default))) {
      risky.push("transferFee");
    }
    const das = safe(() => getDefaultAccountState(m));
    if (das && das.state === AccountState.Frozen) risky.push("defaultFrozen");
    const mca = safe(() => getMintCloseAuthority(m));
    if (mca && !mca.closeAuthority.equals(PublicKey.default)) risky.push("mintClose");
    if (types.includes(ExtensionType.PausableConfig)) risky.push("pausable");
    const md = safe(() => getExtensionData(ExtensionType.TokenMetadata, m.tlvData));
    if (md) tokenMetadata = parseTokenMetadata(md);
  }
  return {
    program: owner.equals(TOKEN_2022_PROGRAM_ID) ? "token-2022" : "spl-token",
    tokenProgram: owner,
    supply: m.supply,
    decimals: m.decimals,
    mintRevoked: m.mintAuthority === null,
    freezeRevoked: m.freezeAuthority === null,
    riskyExtensions: risky,
    tokenMetadata,
  };
}

function safe<T>(f: () => T): T | null {
  try {
    return f() ?? null;
  } catch {
    return null;
  }
}

class Reader {
  o = 0;
  constructor(private readonly b: Buffer) {}
  u8(): number {
    if (this.o + 1 > this.b.length) throw new RangeError("eof");
    return this.b[this.o++]!;
  }
  u32(): number {
    if (this.o + 4 > this.b.length) throw new RangeError("eof");
    const v = this.b.readUInt32LE(this.o);
    this.o += 4;
    return v;
  }
  key(): PublicKey {
    if (this.o + 32 > this.b.length) throw new RangeError("eof");
    const k = new PublicKey(this.b.subarray(this.o, this.o + 32));
    this.o += 32;
    return k;
  }
  str(max = 1024): string {
    const n = this.u32();
    if (n > max || this.o + n > this.b.length) throw new RangeError("bad string");
    const s = this.b.subarray(this.o, this.o + n).toString("utf8");
    this.o += n;
    return s.replace(/\0+$/g, "").trim();
  }
  skip(n: number): void {
    if (this.o + n > this.b.length) throw new RangeError("eof");
    this.o += n;
  }
}

/** Token-2022 TokenMetadata TLV value: update_authority (zero = none), mint, name, symbol, uri, … */
export function parseTokenMetadata(data: Buffer): OnchainMetadata | null {
  try {
    const r = new Reader(data);
    const ua = r.key();
    r.key(); // mint
    const name = r.str(256);
    const symbol = r.str(64);
    const uri = r.str(512);
    return { name, symbol, uri, immutable: ua.equals(PublicKey.default) };
  } catch {
    return null;
  }
}

/** Metaplex Token Metadata account (legacy pump `create`): name, symbol, uri, is_mutable. */
export function parseMetaplexMetadata(data: Buffer): OnchainMetadata | null {
  try {
    const r = new Reader(data);
    if (r.u8() !== 4) return null; // Key::MetadataV1
    r.key(); // update authority
    r.key(); // mint
    const name = r.str(64);
    const symbol = r.str(32);
    const uri = r.str(512);
    r.skip(2); // seller_fee_basis_points
    if (r.u8() === 1) {
      const n = r.u32();
      if (n > 5) return null;
      r.skip(n * 34); // Creator { address, verified, share }
    }
    r.u8(); // primary_sale_happened
    const isMutable = r.u8() === 1;
    return { name, symbol, uri, immutable: !isMutable };
  } catch {
    return null;
  }
}

/** Bonding curve progress: 1 − real_token_reserves / Global.initial_real_token_reserves. */
export function curveProgress(curve: BondingCurve, global: Global): { progressPct: string; graduated: boolean } {
  if (curve.complete) return { progressPct: "100.00", graduated: true };
  const initial = BigInt(global.initialRealTokenReserves.toString(10));
  const real = BigInt(curve.realTokenReserves.toString(10));
  if (initial <= 0n) return { progressPct: "0.00", graduated: false };
  const sold = real >= initial ? 0n : initial - real;
  return { progressPct: pct(sold, initial), graduated: false };
}

/** PumpSwap Pool account fields we need (layout from pump-swap-sdk 1.20 IDL). */
export interface PumpPoolFacts {
  lpMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  /** Pool.lp_supply: LP minted at creation, not reduced by burns. */
  lpSupply: bigint;
}

export function parsePumpPool(data: Buffer): PumpPoolFacts | null {
  // 8 disc | bump u8 | index u16 | creator | base_mint | quote_mint | lp_mint | base_vault | quote_vault | lp_supply u64
  const LP_MINT = 8 + 1 + 2 + 32 * 3;
  if (data.length < LP_MINT + 32 * 3 + 8) return null;
  return {
    lpMint: new PublicKey(data.subarray(LP_MINT, LP_MINT + 32)),
    baseVault: new PublicKey(data.subarray(LP_MINT + 32, LP_MINT + 64)),
    quoteVault: new PublicKey(data.subarray(LP_MINT + 64, LP_MINT + 96)),
    lpSupply: data.readBigUInt64LE(LP_MINT + 96),
  };
}

/** burned% = 1 − lpMint.supply / pool.lp_supply (PUMP_SWAP_README). */
export function lpBurnedPct(poolLpSupply: bigint, lpMintSupply: bigint): string | undefined {
  if (poolLpSupply <= 0n) return undefined;
  const burned = lpMintSupply >= poolLpSupply ? 0n : poolLpSupply - lpMintSupply;
  return pct(burned, poolLpSupply);
}

export interface LargestAccount {
  /** Token account address. */
  address: string;
  amount: bigint;
}

export interface HolderInput {
  largest: readonly LargestAccount[];
  /** token account -> owner (from getMultipleAccounts of the largest accounts). */
  owners: ReadonlyMap<string, string>;
  supply: bigint;
  /** Owners that are venue infrastructure: bonding curve PDA, AMM pool PDA. */
  excludedOwners: ReadonlySet<string>;
  /** Token accounts that are venue infrastructure: curve ATA, pool base vault, mayhem vault. */
  excludedAccounts: ReadonlySet<string>;
  /** Pool vault owners (Unzeen): reported separately, never in the concentration. */
  poolVaults: ReadonlySet<string>;
  /** Dev owners (CreateEvent.user / BondingCurve.creator); empty for Unzeen launches (T1). */
  devOwners: ReadonlySet<string>;
  /** Dev balance read directly (ATAs), used when the dev is not among the largest accounts. */
  devBalance: bigint | null;
}

export interface HolderStats {
  top10Pct: string;
  devPct: string | null;
  unzeenPoolPct: string;
}

/**
 * Top-10 OWNERS (accounts of one owner are summed) after removing the
 * curve, the AMM pool, the mayhem vault and every Unzeen vault.
 */
export function holderStats(h: HolderInput): HolderStats {
  const byOwner = new Map<string, bigint>();
  let pool = 0n;
  let devSeen = 0n;
  for (const a of h.largest) {
    if (h.excludedAccounts.has(a.address)) continue;
    const owner = h.owners.get(a.address) ?? a.address;
    if (h.excludedOwners.has(owner)) continue;
    if (h.poolVaults.has(owner)) {
      pool += a.amount;
      continue;
    }
    if (h.devOwners.has(owner)) devSeen += a.amount;
    byOwner.set(owner, (byOwner.get(owner) ?? 0n) + a.amount);
  }
  const top = [...byOwner.values()].sort((x, y) => (y > x ? 1 : y < x ? -1 : 0)).slice(0, 10);
  const top10 = top.reduce((s, v) => s + v, 0n);
  let devPct: string | null = null;
  if (h.devOwners.size > 0) {
    const dev = h.devBalance !== null && h.devBalance > devSeen ? h.devBalance : devSeen;
    devPct = pct(dev, h.supply);
  }
  return { top10Pct: pct(top10, h.supply), devPct, unzeenPoolPct: pct(pool, h.supply) };
}
