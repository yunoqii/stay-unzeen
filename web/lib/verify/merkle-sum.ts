// Verify (docs/API.md v0.7, v0.10, core/protocol/src/verify.rs): Merkle-sum trees of liabilities, snapshot
// digest, operator and vault signatures. Everything here runs in the browser; nothing is sent anywhere.
//
//   leaf = SHA256("unzeen/verify/v1/leaf" ‖ chainId[2] ‖ u32(snapshotId) ‖ asset[32] ‖ anonPubkey[32]
//                 ‖ u8(piece) ‖ u64(value) ‖ blind[32])
//   node = SHA256("unzeen/verify/v1/node" ‖ L.hash ‖ u128(L.sum) ‖ R.hash ‖ u128(R.sum)), sum = L.sum + R.sum
//   rootsDigest = SHA256("unzeen/verify/v1/snapshot" ‖ chainId ‖ u32(id) ‖ u64(takenAtSec) ‖ u32(N)
//                 ‖ u64(solanaSlot) ‖ u32(zcashHeight) ‖ u64(zecReserveZat) ‖ u32(trees)
//                 ‖ per tree, ascending asset bytes: asset ‖ root.hash ‖ u128(root.sum))
//   rootsDigest v2 (API v0.17, digestVersion 2) = SHA256("unzeen/verify/v2/snapshot" ‖ the v1 fields
//                 ‖ u32(Q) ‖ per quote asset, ascending mint bytes: mint[32] ‖ u8(decimals) ‖ u8(bridged)
//                 ‖ u8(counted) ‖ u64(dustBelow))      no quoteAssets -> Q = 0
//   v3 (API v0.20, digestVersion 3, Robinhood Chain): "unzeen/verify/v3/{leaf,node,snapshot}" tags, the leaf
//                 value is u128 (16 bytes), an ERC-20 asset is 12 zero bytes ‖ its 20-byte address; the
//                 snapshot fields are those of v2 (solanaSlot carries the chain's block number)
//   operator.sig = ed25519(attestation key, rootsDigest bytes)
//   vault.sig    = ed25519(vault key, utf8("unzeen/verify/v1/vault\n" + chainId + "\n" + snapshotId + "\n" + address))
//
// All integers big-endian. Sums are bigints end to end: no float ever touches a balance.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { verifyOperatorEip191, verifyVaultEip712 } from "./evm-sig";
import type { AssetId, VerifyPathNode, VerifyProof, VerifyProofPiece, VerifyQuoteAsset, VerifySnapshot, VerifyVault } from "@/lib/api/types";

const enc = new TextEncoder();
export const LEAF_TAG = enc.encode("unzeen/verify/v1/leaf");
export const NODE_TAG = enc.encode("unzeen/verify/v1/node");
export const SNAPSHOT_TAG = enc.encode("unzeen/verify/v1/snapshot");
/** API v0.17: the v2 digest also signs the snapshot's quoteAssets. */
export const SNAPSHOT_TAG_V2 = enc.encode("unzeen/verify/v2/snapshot");
/** API v0.20: v3 tags (u128 leaf values, ERC-20 assets). */
export const LEAF_TAG_V3 = enc.encode("unzeen/verify/v3/leaf");
export const NODE_TAG_V3 = enc.encode("unzeen/verify/v3/node");
export const SNAPSHOT_TAG_V3 = enc.encode("unzeen/verify/v3/snapshot");

export type DigestVersion = 1 | 2 | 3;
export const ZEC_ASSET = new Uint8Array(32);
const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

export interface SumNode {
  hash: Uint8Array;
  sum: bigint;
}

// ---- encoding ----

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function beBytes(v: bigint, len: number): Uint8Array {
  if (v < BigInt(0) || v >> BigInt(8 * len) !== BigInt(0)) throw new RangeError(`value does not fit in ${len} bytes`);
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & BigInt(0xff));
    v >>= BigInt(8);
  }
  return out;
}

const u8 = (v: number) => beBytes(BigInt(v), 1);
const u32 = (v: number) => beBytes(BigInt(v), 4);
const u64 = (v: bigint | number) => beBytes(BigInt(v), 8);
const u128 = (v: bigint) => beBytes(v, 16);

/** Strict unsigned integer string -> bigint, or null (no signs, no decimals, no exponent). */
export function parseUint(s: unknown, max: bigint = U128_MAX): bigint | null {
  if (typeof s !== "string" || !/^\d{1,40}$/.test(s)) return null;
  const v = BigInt(s);
  return v <= max ? v : null;
}

const isHex32 = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/i.test(s);
const hex32 = (s: string) => hexToBytes(s.toLowerCase());

function chainBytes(chainId: string): Uint8Array {
  if (!/^[0-9a-f]{4}$/.test(chainId)) throw new Error("chainId must be 2 bytes lower-case hex");
  return hexToBytes(chainId);
}

/**
 * 32 bytes of an asset: ZEC = zeros, a mint = its base58 bytes. Null when the id is neither (v0.10: there
 * is no SOL tree any more; creator fees owed sit in the creator's ZEC leaf).
 */
export function assetBytes(asset: AssetId): Uint8Array | null {
  if (asset === "ZEC") return ZEC_ASSET;
  // v0.20: an ERC-20 (Robinhood Chain) = 12 zero bytes ‖ the 20-byte address (any letter case).
  if (/^0x[0-9a-fA-F]{40}$/.test(asset)) {
    const out = new Uint8Array(32);
    out.set(hexToBytes(asset.slice(2).toLowerCase()), 12);
    return out;
  }
  try {
    const b = base58.decode(asset);
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// ---- hashes ----

export interface LeafInput {
  chainId: string;
  snapshotId: number;
  asset: Uint8Array;
  anonPubkey: Uint8Array;
  piece: number;
  value: bigint;
  blind: Uint8Array;
}

export function leafHash(x: LeafInput, v: DigestVersion = 1): Uint8Array {
  if (x.asset.length !== 32 || x.anonPubkey.length !== 32 || x.blind.length !== 32) throw new Error("leaf: 32-byte fields expected");
  if (v === 3) {
    if (x.value > U128_MAX) throw new RangeError("leaf value exceeds u128");
    return sha256(concat([LEAF_TAG_V3, chainBytes(x.chainId), u32(x.snapshotId), x.asset, x.anonPubkey, u8(x.piece), u128(x.value), x.blind]));
  }
  if (x.value > U64_MAX) throw new RangeError("leaf value exceeds u64");
  return sha256(concat([LEAF_TAG, chainBytes(x.chainId), u32(x.snapshotId), x.asset, x.anonPubkey, u8(x.piece), u64(x.value), x.blind]));
}

/** The parent commits to BOTH child sums: moving value between children changes the hash. */
export function nodeOf(l: SumNode, r: SumNode, v: DigestVersion = 1): SumNode {
  return { hash: sha256(concat([v === 3 ? NODE_TAG_V3 : NODE_TAG, l.hash, u128(l.sum), r.hash, u128(r.sum)])), sum: l.sum + r.sum };
}

/** One step of the climb, bottom-up. */
export interface TraceStep {
  level: number;
  /** Where the sibling sits: right when the leafIndex bit at this level is 0. */
  siblingSide: "left" | "right";
  sibling: { hash: string; sum: bigint };
  /** Parent computed here (hash hex, sum = ours + sibling's). */
  node: { hash: string; sum: bigint };
}

/** Climb from a leaf to the root. Throws on malformed path entries. */
export function climb(leaf: SumNode, leafIndex: number, path: VerifyPathNode[], v: DigestVersion = 1): { root: SumNode; steps: TraceStep[] } {
  let cur = leaf;
  let idx = leafIndex;
  const steps: TraceStep[] = [];
  path.forEach((s, level) => {
    const sum = parseUint(s.sum);
    if (!isHex32(s.hash) || sum === null) throw new Error(`malformed path entry at level ${level}`);
    const sib: SumNode = { hash: hex32(s.hash), sum };
    const right = (idx & 1) === 0;
    cur = right ? nodeOf(cur, sib, v) : nodeOf(sib, cur, v);
    if (cur.sum > U128_MAX) throw new RangeError("sum overflows u128");
    steps.push({ level, siblingSide: right ? "right" : "left", sibling: { hash: s.hash.toLowerCase(), sum }, node: { hash: bytesToHex(cur.hash), sum: cur.sum } });
    idx = Math.floor(idx / 2);
  });
  return { root: cur, steps };
}

/** Digest version of a snapshot: no field = 1 (before API v0.17); 3 = Robinhood Chain (v0.20). Anything else is refused. */
export function digestVersionOf(s: Pick<VerifySnapshot, "digestVersion">): DigestVersion {
  const v = s.digestVersion ?? 1;
  if (v !== 1 && v !== 2 && v !== 3) throw new Error(`unknown digestVersion ${String(v).slice(0, 16)}: this page can't recompute it`);
  return v;
}

/** v2 bytes of one quote asset: mint[32] ‖ u8(decimals) ‖ u8(bridged) ‖ u8(counted) ‖ u64(dustBelow). */
export function quoteAssetBytes(q: Pick<VerifyQuoteAsset, "mint" | "decimals" | "bridged" | "counted" | "dustBelow">): Uint8Array {
  const mint = q.mint === "ZEC" ? null : assetBytes(q.mint);
  if (!mint) throw new Error(`quote asset mint "${String(q.mint).slice(0, 48)}" is not a base58 mint`);
  if (!Number.isInteger(q.decimals) || q.decimals < 0 || q.decimals > 255) throw new Error(`quote asset ${q.mint}: decimals is not a u8`);
  if (typeof q.bridged !== "boolean" || typeof q.counted !== "boolean") throw new Error(`quote asset ${q.mint}: bridged / counted must be booleans`);
  const dust = parseUint(q.dustBelow, U64_MAX);
  if (dust === null) throw new Error(`quote asset ${q.mint}: dustBelow is not a u64`);
  return concat([mint, u8(q.decimals), u8(q.bridged ? 1 : 0), u8(q.counted ? 1 : 0), u64(dust)]);
}

export function rootsDigest(
  s: Pick<VerifySnapshot, "chainId" | "id" | "takenAt" | "leaves" | "solanaSlot" | "zcashHeight" | "zecReserve" | "trees" | "digestVersion" | "quoteAssets">,
): string {
  const version = digestVersionOf(s);
  const reserve = parseUint(s.zecReserve.amountZat, U64_MAX);
  if (reserve === null) throw new Error("zecReserve.amountZat is not a u64");
  const trees = s.trees.map((t) => {
    const asset = assetBytes(t.asset);
    const sum = parseUint(t.sum);
    if (!asset) throw new Error(`unknown asset id "${String(t.asset).slice(0, 48)}": not ZEC, a base58 mint or a 0x token, so the digest can't be recomputed`);
    if (!isHex32(t.root) || sum === null) throw new Error(`malformed tree ${t.asset}`);
    return { asset, root: hex32(t.root), sum };
  });
  trees.sort((a, b) => cmpBytes(a.asset, b.asset));
  const parts: Uint8Array[] = [
    version === 3 ? SNAPSHOT_TAG_V3 : version === 2 ? SNAPSHOT_TAG_V2 : SNAPSHOT_TAG,
    chainBytes(s.chainId),
    u32(s.id),
    u64(Math.floor(s.takenAt / 1000)),
    u32(s.leaves),
    u64(s.solanaSlot),
    u32(s.zcashHeight),
    u64(reserve),
    u32(trees.length),
  ];
  for (const t of trees) parts.push(t.asset, t.root, u128(t.sum));
  if (version >= 2) {
    // Sorted by mint bytes (the first 32 bytes of each entry); a v1 digest never covers quoteAssets.
    const qs = (s.quoteAssets ?? []).map(quoteAssetBytes).sort((a, b) => cmpBytes(a.subarray(0, 32), b.subarray(0, 32)));
    parts.push(u32(qs.length), ...qs);
  }
  return bytesToHex(sha256(concat(parts)));
}

export const vaultMessage = (chainId: string, snapshotId: number, address: string) =>
  `unzeen/verify/v1/vault\n${chainId}\n${snapshotId}\n${address}`;

/** Strict ed25519 (no ZIP-215 leniency), base58 key and signature. Never throws. */
export function verifyEd25519(pubkeyB58: string, sigB58: string, msg: Uint8Array): boolean {
  try {
    const pk = base58.decode(pubkeyB58);
    const sig = base58.decode(sigB58);
    if (pk.length !== 32 || sig.length !== 64) return false;
    return ed25519.verify(sig, msg, pk, { zip215: false });
  } catch {
    return false;
  }
}

export function verifyVault(chainId: string, snapshotId: number, v: Pick<VerifyVault, "address" | "sig">): boolean {
  return verifyEd25519(v.address, v.sig, enc.encode(vaultMessage(chainId, snapshotId, v.address)));
}

// ---- snapshot check ----

export type OperatorCheck =
  /** Signature valid and the key is the one pinned in this build. */
  | "verified"
  /** Signature valid, but this build has no pinned key to compare with. */
  | "unpinned"
  /** Signature valid, but by a different key than the pinned one. */
  | "wrong_key"
  | "bad_signature"
  /** Not signed yet. v0.10: the operator signs right after the snapshot, before the memo-tx. */
  | "pending";

export interface SnapshotCheck {
  /** Digest recomputed here from the snapshot fields. */
  digest: string;
  /** Recomputed digest equals the one the server sent. */
  digestOk: boolean;
  operator: OperatorCheck;
  /** address -> signature valid */
  vaults: Record<string, boolean>;
  allVaultsOk: boolean;
  /** Addresses listed more than once (review E12): counted once, and the snapshot is flagged. */
  duplicateVaults: string[];
  anchor: "anchored" | "mismatch" | "pending";
  error?: string;
}

export function checkSnapshot(s: VerifySnapshot, pinnedOperator: string | null): SnapshotCheck {
  let digest = "";
  let error: string | undefined;
  try {
    digest = rootsDigest(s);
  } catch (e) {
    error = e instanceof Error ? e.message : "malformed snapshot";
  }
  const digestOk = !!digest && digest === s.rootsDigest.toLowerCase();
  let operator: OperatorCheck = "pending";
  if (s.operator) {
    // Always over the digest computed HERE, never over the one the server claims.
    // v0.20 Robinhood Chain (digest v3): the operator is an EVM address signing the digest bytes (EIP-191).
    const evm = digestVersionOf(s) === 3;
    const sigOk = !!digest && (evm ? verifyOperatorEip191(s.operator.pubkey, digest, s.operator.sig) : verifyEd25519(s.operator.pubkey, s.operator.sig, hexToBytes(digest)));
    const same = evm ? pinnedOperator?.toLowerCase() === s.operator.pubkey.toLowerCase() : pinnedOperator === s.operator.pubkey;
    operator = !sigOk ? "bad_signature" : !pinnedOperator ? "unpinned" : same ? "verified" : "wrong_key";
  }
  const vaults: Record<string, boolean> = {};
  const duplicateVaults: string[] = [];
  const v3 = (() => {
    try {
      return digestVersionOf(s) === 3;
    } catch {
      return false;
    }
  })();
  const evmChain = s.chainId === "0111" ? 4663 : s.chainId === "0212" ? 46630 : null;
  const seenLower = new Set<string>();
  for (const v of s.vaults) {
    // EVM addresses differ only in letter case: one vault.
    const key = v3 ? v.address.toLowerCase() : v.address;
    if (v.address in vaults || seenLower.has(key)) {
      if (!duplicateVaults.includes(v.address)) duplicateVaults.push(v.address);
      continue;
    }
    seenLower.add(key);
    // v3: every vault signs an EIP-712 statement { snapshotId, address, blockNumber = solanaSlot } on its chain.
    vaults[v.address] = v3 ? evmChain !== null && verifyVaultEip712(evmChain, s.id, v.address, s.solanaSlot, v.sig) : verifyVault(s.chainId, s.id, v);
  }
  return {
    digest,
    digestOk,
    operator,
    vaults,
    duplicateVaults,
    // A vault listed twice would count its balance twice: never "all good" then.
    allVaultsOk: s.vaults.length > 0 && duplicateVaults.length === 0 && Object.values(vaults).every(Boolean),
    anchor: !s.anchor ? "pending" : s.anchor.matches ? "anchored" : "mismatch",
    error,
  };
}

// ---- solvency ----

export interface SolvencyRow {
  asset: AssetId;
  decimals: number;
  liabilities: bigint;
  /** Mint: Σ vault tokens. ZEC: proven SOL part + attested ZEC part, in zatoshis. */
  assets: bigint;
  /** ZEC only: spare SOL converted at rateLamportsPerZecSell (zat). Proven on Solana. */
  provenZat?: bigint;
  /** ZEC only: the operator's statement (zat). */
  attestedZat?: bigint;
  /**
   * ZEC only (v0.13): ZEC SPL on the signed vaults, counted 1:1 (quoteAssets with counted: true, dust
   * below dustBelow per vault left out). Proven on Solana, but a bridged asset: the bridge issuer's risk.
   */
  bridgedZat?: bigint;
  covered: boolean;
  /**
   * "proven": mint covered by signed vaults. "proven_attested": ZEC (spare vault SOL proven + ZEC attested).
   * "unknown": an asset id this page can't map to 32 bytes (not ZEC or a base58 mint): not checkable.
   */
  kind: "proven" | "proven_attested" | "unknown";
  /** Signatures of every vault check out (otherwise the assets side means nothing). */
  vaultsSigned: boolean;
  /** The tree's granule from the snapshot (never assumed: review E1). */
  granule?: string;
}

const ZAT_PER_ZEC = BigInt(100_000_000);

/** Vaults whose signature verified, each address once (review E12). Only these count towards any cover. */
function signedVaults(s: VerifySnapshot, check: Pick<SnapshotCheck, "vaults">) {
  const seen = new Set<string>();
  return s.vaults.filter((v) => {
    if (seen.has(v.address)) return false;
    seen.add(v.address);
    return check.vaults[v.address];
  });
}

export interface QuoteHolding {
  mint: string;
  quote: "ZEC" | "USDC" | "USD1";
  decimals: number;
  bridged: boolean;
  /** Counts towards the ZEC cover (only ZEC SPL, API v0.13). USDC / USD1: shown, never counted. */
  counted: boolean;
  /** Σ over the signed vaults, base units. */
  total: bigint;
  /** What the cover takes: Σ of vault balances at or above dustBelow; 0 when not counted. */
  countedAmount: bigint;
  /** In zatoshis (counted ZEC SPL only, rescaled from its decimals). */
  countedZat: bigint;
}

/** v0.13 quote assets of the pool on the signed vaults (snapshot.quoteAssets). Empty without the field. */
export function quoteHoldings(s: VerifySnapshot, check: Pick<SnapshotCheck, "vaults">): QuoteHolding[] {
  const signed = signedVaults(s, check);
  const seen = new Set<string>();
  const out: QuoteHolding[] = [];
  for (const q of s.quoteAssets ?? []) {
    if (seen.has(q.mint)) continue; // a mint listed twice counts once
    seen.add(q.mint);
    const dust = parseUint(q.dustBelow) ?? BigInt(0);
    // Only ZEC SPL is ever counted, whatever the flag says for another quote.
    const counted = q.counted === true && q.quote === "ZEC";
    let total = BigInt(0);
    let countedAmount = BigInt(0);
    for (const v of signed) {
      const bal = v.tokens.filter((t) => t.mint === q.mint).reduce((n, t) => n + (parseUint(t.amount) ?? BigInt(0)), BigInt(0));
      total += bal;
      if (counted && bal >= dust) countedAmount += bal;
    }
    const d = Number.isInteger(q.decimals) && q.decimals >= 0 && q.decimals <= 18 ? q.decimals : 8;
    const countedZat = d >= 8 ? countedAmount / BigInt(10) ** BigInt(d - 8) : countedAmount * BigInt(10) ** BigInt(8 - d);
    out.push({ mint: q.mint, quote: q.quote, decimals: d, bridged: q.bridged, counted, total, countedAmount, countedZat });
  }
  return out;
}

export function solvency(s: VerifySnapshot, check: Pick<SnapshotCheck, "vaults">): SolvencyRow[] {
  // Only vaults whose signature verified count towards the cover, each address once (review E12).
  const signed = signedVaults(s, check);
  const vaultsSigned = signed.length === s.vaults.length && s.vaults.length > 0;
  const tokenTotals = new Map<string, bigint>();
  let lamports = BigInt(0);
  for (const v of signed) {
    lamports += parseUint(v.lamports) ?? BigInt(0);
    for (const t of v.tokens) tokenTotals.set(t.mint, (tokenTotals.get(t.mint) ?? BigInt(0)) + (parseUint(t.amount) ?? BigInt(0)));
  }
  // v0.10: committedLamports = only the gas of queued token withdrawals. Creator fees owed are already
  // inside the creators' ZEC leaves (converted at rateLamportsPerZecBuy), so all spare SOL backs ZEC.
  const committed = parseUint(s.committedLamports) ?? BigInt(0);
  const spare = lamports > committed ? lamports - committed : BigInt(0);
  const rows = s.trees.map((t): SolvencyRow => {
    const liabilities = parseUint(t.sum) ?? BigInt(0);
    if (!assetBytes(t.asset)) return { asset: t.asset, decimals: t.decimals, liabilities, assets: BigInt(0), covered: false, kind: "unknown", vaultsSigned };
    if (t.asset === "ZEC") {
      const rate = parseUint(s.rateLamportsPerZecSell ?? "");
      const provenZat = rate && rate > BigInt(0) ? (spare * ZAT_PER_ZEC) / rate : BigInt(0);
      const attestedZat = parseUint(s.zecReserve.amountZat) ?? BigInt(0);
      // v0.13: ZEC SPL 1:1 ("bridged"); USDC / USD1 never count (conservative).
      const bridgedZat = quoteHoldings(s, check).reduce((n, q) => n + q.countedZat, BigInt(0));
      const assets = provenZat + attestedZat + bridgedZat;
      return { asset: t.asset, decimals: t.decimals, liabilities, assets, provenZat, attestedZat, bridgedZat, covered: liabilities <= assets, kind: "proven_attested", vaultsSigned };
    }
    const assets = tokenTotals.get(t.asset) ?? BigInt(0);
    return { asset: t.asset, decimals: t.decimals, liabilities, assets, covered: liabilities <= assets, kind: "proven", vaultsSigned };
  }).map((r, i) => ({ ...r, granule: s.trees[i].granule }));
  // ZEC first, then mints by liability size (stable for equal sizes), unknown ids last.
  const rank = (a: SolvencyRow) => (a.asset === "ZEC" ? 0 : a.kind === "unknown" ? 2 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || (a.liabilities === b.liabilities ? 0 : a.liabilities > b.liabilities ? -1 : 1));
}

/** Coverage in basis points (10000 = 100 %), capped for display. */
export function coverageBps(assets: bigint, liabilities: bigint): number {
  if (liabilities === BigInt(0)) return 10_000;
  const bps = (assets * BigInt(10_000)) / liabilities;
  return Number(bps > BigInt(99_999) ? BigInt(99_999) : bps);
}

// ---- owner proof ----

export interface PieceResult {
  piece: number;
  leafIndex: number;
  value: bigint;
  leaf: string;
  steps: TraceStep[];
  /** Computed root hash equals the tree root. */
  rootMatches: boolean;
  /** Computed root sum equals the tree sum. */
  sumMatches: boolean;
  ok: boolean;
  error?: string;
}

export interface AssetResult {
  asset: AssetId;
  decimals: number;
  /** Σ of this key's pieces (what the pool committed to owe it). */
  committed: bigint;
  pieces: PieceResult[];
  ok: boolean;
  error?: string;
}

export interface ProofCheck {
  ok: boolean;
  assets: AssetResult[];
  error?: string;
}

function checkPiece(s: VerifySnapshot, asset: Uint8Array, granule: bigint, root: { hash: string; sum: bigint }, pk: Uint8Array, p: VerifyProofPiece): PieceResult {
  const v = digestVersionOf(s);
  // v3: leaf values are u128 (ERC-20 amounts with 18 decimals pass u64 fast).
  const value = parseUint(p.value, v === 3 ? U128_MAX : U64_MAX);
  const base = { piece: p.piece, leafIndex: p.leafIndex, value: value ?? BigInt(0), leaf: "", steps: [] as TraceStep[], rootMatches: false, sumMatches: false, ok: false };
  if (value === null) return { ...base, error: v === 3 ? "value is not a u128" : "value is not a u64" };
  if (granule > BigInt(0) && value % granule !== BigInt(0)) return { ...base, error: "value is not a multiple of the granule" };
  if (!isHex32(p.blind)) return { ...base, error: "blind is not 32 bytes" };
  if (!Number.isInteger(p.piece) || p.piece < 0 || p.piece > 255) return { ...base, error: "bad piece number" };
  // A proof must climb exactly log2(N) levels, from a position inside the tree.
  const depth = Math.log2(s.leaves);
  if (!Number.isInteger(depth) || p.path.length !== depth) return { ...base, error: `path has ${p.path.length} levels, the tree has ${depth}` };
  if (!Number.isInteger(p.leafIndex) || p.leafIndex < 0 || p.leafIndex >= s.leaves) return { ...base, error: "leaf index outside the tree" };
  const leaf = leafHash({ chainId: s.chainId, snapshotId: s.id, asset, anonPubkey: pk, piece: p.piece, value, blind: hex32(p.blind) }, v);
  try {
    const { root: r, steps } = climb({ hash: leaf, sum: value }, p.leafIndex, p.path, v);
    const rootMatches = bytesToHex(r.hash) === root.hash;
    const sumMatches = r.sum === root.sum;
    return { ...base, leaf: bytesToHex(leaf), steps, rootMatches, sumMatches, ok: rootMatches && sumMatches };
  } catch (e) {
    return { ...base, leaf: bytesToHex(leaf), error: e instanceof Error ? e.message : "bad path" };
  }
}

/**
 * Recompute every piece of an owner proof from the key's own pubkey up to the roots of the public
 * snapshot. The snapshot must be the one the proof is for.
 */
export function checkProof(s: VerifySnapshot, proof: VerifyProof, anonPubkeyB58: string): ProofCheck {
  if (proof.snapshotId !== s.id) return { ok: false, assets: [], error: `proof is for snapshot #${proof.snapshotId}, not #${s.id}` };
  let pk: Uint8Array;
  try {
    pk = base58.decode(anonPubkeyB58);
    if (pk.length !== 32) throw new Error();
  } catch {
    return { ok: false, assets: [], error: "bad anon pubkey" };
  }
  const assets = proof.proofs.map((ap): AssetResult => {
    const tree = s.trees.find((t) => t.asset === ap.asset);
    const bytes = assetBytes(ap.asset);
    const fail = (error: string): AssetResult => ({ asset: ap.asset, decimals: ap.decimals, committed: BigInt(0), pieces: [], ok: false, error });
    if (!tree) return fail("no tree for this asset in the snapshot");
    if (!bytes) return fail("unknown asset id: not ZEC, a base58 mint or a 0x token");
    const rootSum = parseUint(tree.sum);
    if (!isHex32(tree.root) || rootSum === null) return fail("malformed tree root");
    const granule = parseUint(tree.granule) ?? BigInt(0);
    const pieces = ap.pieces.map((p) => checkPiece(s, bytes, granule, { hash: tree.root.toLowerCase(), sum: rootSum }, pk, p));
    // Two pieces on one leaf would count one commitment twice.
    const distinct = new Set(ap.pieces.map((p) => p.leafIndex)).size === ap.pieces.length && new Set(ap.pieces.map((p) => p.piece)).size === ap.pieces.length;
    const committed = pieces.reduce((n, p) => n + (p.ok ? p.value : BigInt(0)), BigInt(0));
    const ok = pieces.length > 0 && distinct && pieces.every((p) => p.ok);
    return { asset: ap.asset, decimals: tree.decimals, committed, pieces, ok, error: distinct ? undefined : "two pieces share a leaf" };
  });
  return { ok: assets.every((a) => a.ok), assets };
}

/** What "Download proof" writes: everything needed to re-check offline, nothing more (no pad). */
export function proofFile(s: VerifySnapshot, proof: VerifyProof, anonPubkey: string) {
  return {
    format: "unzeen-verify-proof/v1",
    note: "Your balance proof. Keep it private: it reveals your balance at this snapshot.",
    anonPubkey,
    snapshot: s,
    proof: { snapshotId: proof.snapshotId, proofs: proof.proofs, truncated: proof.truncated },
  };
}
