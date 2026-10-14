#!/usr/bin/env node
// Unzeen: check a Verify proof offline. No dependencies: Node.js >= 18 (node:crypto) only.
//
//   node verify-proof.mjs unzeen-proof-0202-101.json --operator <base58 attestation key>
//   node verify-proof.mjs unzeen-proof-0202-101.json --trust-any-operator     (not recommended)
//
// The input is the file from "Download proof" on /verify: { anonPubkey, snapshot, proof }.
// Checks, exactly as the page does (docs/API.md, "Verify"):
//   1. rootsDigest recomputed from the snapshot fields (digestVersion 2, API v0.17: under the v2 tag and
//      also over quoteAssets, so the operator signature covers which quote mints count; no field = v1);
//   2. operator.sig = ed25519 over the 32 digest bytes, by the attestation key you pinned with
//      --operator (also published in the README). Without --operator a signature is NOT accepted,
//      unless you pass --trust-any-operator on purpose;
//   3. every vault.sig = ed25519 over "unzeen/verify/v1/vault\n<chainId>\n<id>\n<address>", each
//      vault address counted once;
//   4. every piece of your balance climbs its Merkle-sum path to the tree root (hash and sum); pieces
//      and leaf positions are distinct and inside the tree, values are multiples of the tree's granule;
//   5. solvency: mints by signed vault balances; ZEC by spare vault SOL (Σ lamports − committedLamports,
//      converted at rateLamportsPerZecSell: proven) + ZEC SPL on the vaults (API v0.13 quoteAssets with
//      counted: true, 1:1, each vault balance below dustBelow left out: bridged) + reserve (attested by the
//      operator). USDC / USD1 quote assets are never counted. Creator fees owed are inside the creators'
//      ZEC leaves (API v0.10, v0.14), there is no SOL tree.
// Asset ids: "ZEC" (32 zero bytes), a base58 mint (32 bytes), or on Robinhood Chain an ERC-20 "0x…" (12 zero
// bytes ‖ the 20-byte address). Any other id (including "SOL") is reported as a failed check, never a crash.
// A signed snapshot may not be anchored yet (v0.10: the operator signs before the memo-tx).
// Then compare the digest with the memo of the anchor tx in any Solana explorer or RPC you trust.
//
// Robinhood Chain snapshots (API v0.20, digestVersion 3, chain ids 0111 / 0212):
//   - leaf values are u128 (16 bytes), tags "unzeen/verify/v3/{leaf,node,snapshot}", the snapshot fields are v2's
//     (solanaSlot carries the block number);
//   - operator.sig = EIP-191 personal message over the 32 digest bytes, by the attestation ADDRESS (0x…);
//   - vault.sig = EIP-712 Snapshot{string snapshotId, address address, uint256 blockNumber}, domain
//     { name: "unzeen-verify", version: "1", chainId: 4663 | 46630 }, by the vault address itself;
//   - the anchor is a Robinhood Chain tx whose input data is the 32 digest bytes; native balances are wei. keccak-256 and secp256k1 recovery are implemented below (still no dependencies).
//   node verify-proof.mjs unzeen-proof-0111-1.json --operator 0x<attestation address>

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";

/** Attestation keys pinned per chain id, filled in for releases. Empty = pass --operator. */
export const PINNED_OPERATOR = { "0202": "", "0101": "", "0111": "", "0212": "" };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s) {
  if (typeof s !== "string") throw new Error("bad base58");
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Buffer.from(out);
}

const be = (v, len) => {
  v = BigInt(v);
  if (v < 0n || v >> BigInt(8 * len)) throw new Error(`value does not fit in ${len} bytes`);
  const b = Buffer.alloc(len);
  for (let i = len - 1; i >= 0; i--, v >>= 8n) b[i] = Number(v & 0xffn);
  return b;
};
const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const tag = (t, v = 1) => Buffer.from(`unzeen/verify/v${v === 3 ? 3 : 1}/${t}`);

// ---- keccak-256 (Ethereum's, not NIST SHA3) ----
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);
function keccakF(a) {
  for (let r = 0; r < 24; r++) {
    const c = [0, 1, 2, 3, 4].map((x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) a[x + y] = b[x + y] ^ (~b[(x + 1) % 5 + y] & M64 & b[(x + 2) % 5 + y]);
    a[0] ^= RC[r];
  }
}
export function keccak256(data) {
  const rate = 136;
  const msg = Buffer.concat([Buffer.from(data), Buffer.from([0x01])]);
  const padded = Buffer.alloc(Math.ceil(msg.length / rate) * rate);
  msg.copy(padded);
  padded[padded.length - 1] |= 0x80;
  const a = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) a[i] ^= padded.readBigUInt64LE(off + 8 * i);
    keccakF(a);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(a[i], 8 * i);
  return out;
}

// ---- secp256k1 public-key recovery (affine, BigInt) ----
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = { x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n };
const mod = (a, m) => ((a % m) + m) % m;
function inv(a, m) {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1) {
    const q = r0 / r1;
    [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1];
  }
  return mod(s0, m);
}
function add(p, q) {
  if (!p) return q;
  if (!q) return p;
  if (p.x === q.x && mod(p.y + q.y, P) === 0n) return null;
  const l = p.x === q.x ? mod(3n * p.x * p.x * inv(2n * p.y, P), P) : mod((q.y - p.y) * inv(q.x - p.x, P), P);
  const x = mod(l * l - p.x - q.x, P);
  return { x, y: mod(l * (p.x - x) - p.y, P) };
}
function mul(p, k) {
  let r = null;
  for (let q = p; k > 0n; k >>= 1n, q = add(q, q)) if (k & 1n) r = add(r, q);
  return r;
}
const powm = (b, e, m) => {
  let r = 1n;
  for (b = mod(b, m); e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m;
  return r;
};
/** Lower-case 0x address that produced a 65-byte r‖s‖v signature over a 32-byte hash, or null. */
export function recoverAddress(hash, sigHex) {
  try {
    const sig = Buffer.from(String(sigHex).replace(/^0x/i, ""), "hex");
    if (sig.length !== 65) return null;
    const r = BigInt("0x" + sig.subarray(0, 32).toString("hex"));
    const s = BigInt("0x" + sig.subarray(32, 64).toString("hex"));
    let v = sig[64];
    if (v >= 27) v -= 27;
    if ((v !== 0 && v !== 1) || r <= 0n || r >= N || s <= 0n || s > N >> 1n) return null; // low-s only, like core
    let y = powm(mod(r * r * r + 7n, P), (P + 1n) / 4n, P);
    if (mod(y * y - (r * r * r + 7n), P) !== 0n) return null;
    if (Number(y & 1n) !== v) y = P - y;
    const e = BigInt("0x" + Buffer.from(hash).toString("hex"));
    const ri = inv(r, N);
    const q = add(mul({ x: r, y }, mod(s * ri, N)), mul(G, mod(-e * ri, N)));
    if (!q) return null;
    const pub = Buffer.concat([be(q.x, 32), be(q.y, 32)]);
    return "0x" + keccak256(pub).subarray(12).toString("hex");
  } catch {
    return null;
  }
}
const sameAddr = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
/** EIP-191 over raw bytes. */
export const personalHash = (bytes) => keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${bytes.length}`), Buffer.from(bytes)]));
/** EIP-712 digest of a vault's Snapshot statement. */
export function vaultTypedDigest(chainId, snapshotId, address, blockNumber) {
  const k = (t) => keccak256(Buffer.from(t));
  const domain = keccak256(Buffer.concat([k("EIP712Domain(string name,string version,uint256 chainId)"), k("unzeen-verify"), k("1"), be(chainId, 32)]));
  const struct = keccak256(Buffer.concat([k("Snapshot(string snapshotId,address address,uint256 blockNumber)"), k(String(snapshotId)), Buffer.concat([Buffer.alloc(12), Buffer.from(address.slice(2), "hex")]), be(blockNumber, 32)]));
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), domain, struct]));
}
const EVM_CHAIN = { "0111": 4663, "0212": 46630 };
const isUint = (v) => typeof v === "string" && /^\d{1,40}$/.test(v);
const isHex32 = (v) => typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);

/** 32 bytes of an asset id, or null for an id that is not ZEC or a 32-byte base58 mint. */
export function asset32(a) {
  if (a === "ZEC") return Buffer.alloc(32);
  if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) return Buffer.concat([Buffer.alloc(12), Buffer.from(a.slice(2), "hex")]);
  try {
    const b = b58decode(a);
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}
const mustAsset = (a) => {
  const b = asset32(a);
  if (!b) throw new Error(`unknown asset id "${String(a).slice(0, 48)}"`);
  return b;
};

export function leafHash(chainId, snapshotId, asset, pubkey, piece, value, blind, v = 1) {
  return sha(tag("leaf", v), Buffer.from(chainId, "hex"), be(snapshotId, 4), mustAsset(asset), pubkey, be(piece, 1), be(value, v === 3 ? 16 : 8), Buffer.from(blind, "hex"));
}
export const node = (l, r, v = 1) => ({ hash: sha(tag("node", v), l.hash, be(l.sum, 16), r.hash, be(r.sum, 16)), sum: l.sum + r.sum });

/** v2 bytes of a quote asset: mint[32] ‖ u8(decimals) ‖ u8(bridged) ‖ u8(counted) ‖ u64(dustBelow). */
export function quoteBytes(q) {
  const mint = q && q.mint !== "ZEC" ? asset32(q.mint) : null;
  if (!mint) throw new Error(`quote asset mint "${String(q && q.mint).slice(0, 48)}" is not a base58 mint`);
  if (!Number.isInteger(q.decimals) || q.decimals < 0 || q.decimals > 255) throw new Error(`quote asset ${q.mint}: decimals is not a u8`);
  if (typeof q.bridged !== "boolean" || typeof q.counted !== "boolean") throw new Error(`quote asset ${q.mint}: bridged / counted must be booleans`);
  if (!isUint(q.dustBelow)) throw new Error(`quote asset ${q.mint}: dustBelow is not a u64`);
  return Buffer.concat([mint, Buffer.from([q.decimals, q.bridged ? 1 : 0, q.counted ? 1 : 0]), be(q.dustBelow, 8)]);
}

export function rootsDigest(s) {
  const version = s.digestVersion ?? 1;
  if (version !== 1 && version !== 2 && version !== 3) throw new Error(`unknown digestVersion ${String(version).slice(0, 16)}`);
  const trees = s.trees.map((t) => ({ a: mustAsset(t.asset), root: Buffer.from(t.root, "hex"), sum: BigInt(t.sum) })).sort((x, y) => Buffer.compare(x.a, y.a));
  const parts = [version === 3 ? Buffer.from("unzeen/verify/v3/snapshot") : version === 2 ? Buffer.from("unzeen/verify/v2/snapshot") : tag("snapshot"), Buffer.from(s.chainId, "hex"), be(s.id, 4), be(Math.floor(s.takenAt / 1000), 8), be(s.leaves, 4), be(s.solanaSlot, 8), be(s.zcashHeight, 4), be(s.zecReserve.amountZat, 8), be(trees.length, 4)];
  for (const t of trees) parts.push(t.a, t.root, be(t.sum, 16));
  if (version >= 2) {
    const qs = (Array.isArray(s.quoteAssets) ? s.quoteAssets : []).map(quoteBytes).sort((x, y) => Buffer.compare(x.subarray(0, 32), y.subarray(0, 32)));
    parts.push(be(qs.length, 4), ...qs);
  }
  return sha(...parts).toString("hex");
}

export function ed25519Ok(pubB58, sigB58, msg) {
  try {
    const pk = b58decode(pubB58);
    const sig = b58decode(sigB58);
    if (pk.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pk.toString("base64url") }, format: "jwk" });
    return edVerify(null, msg, key, sig);
  } catch {
    return false;
  }
}

/**
 * @param file      the downloaded proof file
 * @param operator  base58 attestation key to require (else the pinned one for the chain id, if any)
 * @param opts      { trustAnyOperator: true } accepts any signing key, with a warning
 */
export function check(file, operator, opts = {}) {
  const { snapshot: s, proof: p, anonPubkey } = file;
  const out = [];
  const ok = (cond, what) => (out.push(`${cond ? "OK  " : "FAIL"} ${what}`), cond);
  let all = true;

  // 1. digest
  let digest = "";
  try {
    digest = rootsDigest(s);
  } catch (e) {
    out.push(`FAIL rootsDigest: ${e instanceof Error ? e.message : "malformed snapshot"}`);
    all = false;
  }
  if (digest) all = ok(digest === String(s.rootsDigest).toLowerCase(), `rootsDigest v${s.digestVersion ?? 1} ${digest}`) && all;
  if ((s.digestVersion ?? 1) === 1 && Array.isArray(s.quoteAssets) && s.quoteAssets.length) out.push("WARN digest v1: quoteAssets are not covered by the operator signature");

  // 2. operator (v3: EIP-191 by an address; else ed25519 by a base58 key)
  const v3 = s.digestVersion === 3;
  const pinned = operator || PINNED_OPERATOR[s.chainId] || "";
  if (s.operator) {
    const sigOk = !!digest && (v3 ? sameAddr(recoverAddress(personalHash(Buffer.from(digest, "hex")), s.operator.sig), s.operator.pubkey) : ed25519Ok(s.operator.pubkey, s.operator.sig, Buffer.from(digest, "hex")));
    all = ok(sigOk, `operator signature by ${s.operator.pubkey}${v3 ? " (EIP-191)" : ""}`) && all;
    if (pinned) all = ok(v3 ? sameAddr(s.operator.pubkey, pinned) : s.operator.pubkey === pinned, "operator key equals the pinned one") && all;
    else if (opts.trustAnyOperator) out.push("WARN operator key NOT compared with a pinned key (--trust-any-operator): anyone could have signed this");
    else all = ok(false, "operator key pinned (pass --operator <key from the README>, or --trust-any-operator)") && all;
  } else {
    out.push("WAIT snapshot not signed yet");
    // Asked to check against a pinned key: no signature is not a pass.
    if (pinned) all = ok(false, "operator signature present") && all;
  }

  if (s.operator && !s.anchor) out.push("WAIT signed, anchor pending: the memo-tx is not confirmed yet (compare the digest later)");
  else if (s.anchor && s.anchor.matches === false) out.push("WARN anchor memo does not match the digest (the pool re-anchors automatically)");

  // 3. vaults, each address once
  const seen = new Set();
  const signed = [];
  for (const v of s.vaults) {
    const key = v3 ? String(v.address).toLowerCase() : v.address;
    if (seen.has(key)) {
      all = ok(false, `vault ${v.address} listed once`) && all;
      continue;
    }
    seen.add(key);
    const good = v3
      ? !!EVM_CHAIN[s.chainId] && /^0x[0-9a-fA-F]{40}$/.test(v.address) && sameAddr(recoverAddress(vaultTypedDigest(EVM_CHAIN[s.chainId], s.id, v.address, s.solanaSlot), v.sig), v.address)
      : ed25519Ok(v.address, v.sig, Buffer.from(`unzeen/verify/v1/vault\n${s.chainId}\n${s.id}\n${v.address}`));
    if (ok(good, `vault ${v.address} signed${v3 ? " (EIP-712)" : ""}`)) signed.push(v);
    else all = false;
  }

  // 4. own pieces
  let pk = null;
  try {
    pk = b58decode(anonPubkey);
  } catch {
    /* below */
  }
  if (!ok(!!pk && pk.length === 32, "anon pubkey is 32 bytes")) return { ok: false, lines: out };
  all = ok(p.snapshotId === s.id, `proof is for snapshot #${s.id}`) && all;
  const depth = Math.log2(s.leaves);
  for (const ap of p.proofs) {
    const tree = s.trees.find((t) => t.asset === ap.asset);
    if (!ok(!!tree, `tree for ${ap.asset}`) || !ok(!!asset32(ap.asset), `${ap.asset} is a known asset id`)) {
      all = false;
      continue;
    }
    const granule = isUint(tree.granule) ? BigInt(tree.granule) : 0n;
    const pieces = new Set();
    const leaves = new Set();
    let committed = 0n;
    for (const pc of ap.pieces) {
      let good = false;
      try {
        const fresh = !pieces.has(pc.piece) && !leaves.has(pc.leafIndex);
        pieces.add(pc.piece);
        leaves.add(pc.leafIndex);
        const shapeOk =
          fresh &&
          Number.isInteger(pc.piece) && pc.piece >= 0 && pc.piece <= 255 &&
          Number.isInteger(pc.leafIndex) && pc.leafIndex >= 0 && pc.leafIndex < s.leaves &&
          isUint(pc.value) && BigInt(pc.value) < 1n << (v3 ? 128n : 64n) && (granule === 0n || BigInt(pc.value) % granule === 0n) &&
          isHex32(pc.blind) && Array.isArray(pc.path) && pc.path.length === depth;
        if (shapeOk) {
          let cur = { hash: leafHash(s.chainId, s.id, ap.asset, pk, pc.piece, pc.value, pc.blind, v3 ? 3 : 1), sum: BigInt(pc.value) };
          let idx = pc.leafIndex;
          for (const sib of pc.path) {
            if (!isHex32(sib.hash) || !isUint(sib.sum)) throw new Error("bad path entry");
            const sn = { hash: Buffer.from(sib.hash, "hex"), sum: BigInt(sib.sum) };
            cur = idx % 2 === 0 ? node(cur, sn, v3 ? 3 : 1) : node(sn, cur, v3 ? 3 : 1);
            idx = Math.floor(idx / 2);
          }
          good = cur.hash.toString("hex") === String(tree.root).toLowerCase() && cur.sum === BigInt(tree.sum);
        }
      } catch {
        good = false;
      }
      all = ok(good, `${ap.asset} piece ${pc.piece} (${pc.value}) climbs to the root`) && all;
      if (good) committed += BigInt(pc.value);
    }
    out.push(`     ${ap.asset}: committed to your key >= ${committed} base units`);
  }

  // 5. solvency (each vault once, signed only)
  const lamports = signed.reduce((n, v) => n + (isUint(v.lamports) ? BigInt(v.lamports) : 0n), 0n);
  const committedL = isUint(s.committedLamports) ? BigInt(s.committedLamports) : 0n;
  const spare = lamports > committedL ? lamports - committedL : 0n;
  // v0.13: only ZEC SPL counts (bridged), per vault at or above dustBelow; USDC / USD1 never.
  let bridged = 0n;
  const seenQ = new Set();
  for (const q of Array.isArray(s.quoteAssets) ? s.quoteAssets : []) {
    if (!q || q.counted !== true || q.quote !== "ZEC" || seenQ.has(q.mint)) continue;
    seenQ.add(q.mint);
    const dust = isUint(q.dustBelow) ? BigInt(q.dustBelow) : 0n;
    const d = Number.isInteger(q.decimals) && q.decimals >= 0 && q.decimals <= 18 ? q.decimals : 8;
    for (const v of signed) {
      const bal = v.tokens.filter((x) => x.mint === q.mint).reduce((n, x) => n + (isUint(x.amount) ? BigInt(x.amount) : 0n), 0n);
      if (bal >= dust) bridged += d >= 8 ? bal / 10n ** BigInt(d - 8) : bal * 10n ** BigInt(8 - d);
    }
  }
  for (const t of s.trees) {
    if (!asset32(t.asset)) {
      all = ok(false, `${String(t.asset).slice(0, 48)}: unknown asset id, can't check solvency`) && all;
    } else if (t.asset === "ZEC") {
      const proven = s.rateLamportsPerZecSell ? (spare * 100_000_000n) / BigInt(s.rateLamportsPerZecSell) : 0n;
      const attested = BigInt(s.zecReserve.amountZat);
      // Informational: part of the ZEC cover is the operator's statement, so it does not set the exit code.
      ok(BigInt(t.sum) <= proven + bridged + attested, `ZEC liabilities ${t.sum} <= ${proven} proven (${v3 ? "ETH" : "SOL"}) + ${bridged} bridged (ZEC SPL) + ${attested} attested (operator) zat  [informational: attested part]`);
    } else {
      const held = signed.flatMap((v) => v.tokens).filter((x) => x.mint === t.asset).reduce((n, x) => n + (isUint(x.amount) ? BigInt(x.amount) : 0n), 0n);
      all = ok(BigInt(t.sum) <= held, `${t.asset} liabilities ${t.sum} <= vaults ${held}`) && all;
    }
  }
  return { ok: all, lines: out };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--operator");
  const i = args.indexOf("--operator");
  const trustAnyOperator = args.includes("--trust-any-operator");
  if (!file) {
    console.error("usage: node verify-proof.mjs <proof.json> --operator <base58 attestation key | 0x attestation address>   (or --trust-any-operator)");
    process.exit(2);
  }
  if (trustAnyOperator) console.error("WARNING: --trust-any-operator: the operator signature is checked, but not WHO signed. Pin the key from the README instead.\n");
  const r = check(JSON.parse(readFileSync(file, "utf8")), i >= 0 ? args[i + 1] : undefined, { trustAnyOperator });
  console.log(r.lines.join("\n"));
  console.log(r.ok ? "\nAll checks passed." : "\nSome checks FAILED.");
  process.exit(r.ok ? 0 : 1);
}
