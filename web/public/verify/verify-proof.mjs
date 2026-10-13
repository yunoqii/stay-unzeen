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
// Asset ids: "ZEC" (32 zero bytes) or a base58 mint (32 bytes). Any other id (including "SOL") is
// reported as a failed check, never a crash.
// A signed snapshot may not be anchored yet (v0.10: the operator signs before the memo-tx).
// Then compare the digest with the memo of the anchor tx in any Solana explorer or RPC you trust.

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";

/** Attestation keys pinned per chain id, filled in for releases. Empty = pass --operator. */
export const PINNED_OPERATOR = { "0202": "", "0101": "" };

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
const tag = (t) => Buffer.from(`unzeen/verify/v1/${t}`);
const isUint = (v) => typeof v === "string" && /^\d{1,40}$/.test(v);
const isHex32 = (v) => typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);

/** 32 bytes of an asset id, or null for an id that is not ZEC or a 32-byte base58 mint. */
export function asset32(a) {
  if (a === "ZEC") return Buffer.alloc(32);
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

export function leafHash(chainId, snapshotId, asset, pubkey, piece, value, blind) {
  return sha(tag("leaf"), Buffer.from(chainId, "hex"), be(snapshotId, 4), mustAsset(asset), pubkey, be(piece, 1), be(value, 8), Buffer.from(blind, "hex"));
}
const node = (l, r) => ({ hash: sha(tag("node"), l.hash, be(l.sum, 16), r.hash, be(r.sum, 16)), sum: l.sum + r.sum });

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
  if (version !== 1 && version !== 2) throw new Error(`unknown digestVersion ${String(version).slice(0, 16)}`);
  const trees = s.trees.map((t) => ({ a: mustAsset(t.asset), root: Buffer.from(t.root, "hex"), sum: BigInt(t.sum) })).sort((x, y) => Buffer.compare(x.a, y.a));
  const parts = [version === 2 ? Buffer.from("unzeen/verify/v2/snapshot") : tag("snapshot"), Buffer.from(s.chainId, "hex"), be(s.id, 4), be(Math.floor(s.takenAt / 1000), 8), be(s.leaves, 4), be(s.solanaSlot, 8), be(s.zcashHeight, 4), be(s.zecReserve.amountZat, 8), be(trees.length, 4)];
  for (const t of trees) parts.push(t.a, t.root, be(t.sum, 16));
  if (version === 2) {
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

  // 2. operator
  const pinned = operator || PINNED_OPERATOR[s.chainId] || "";
  if (s.operator) {
    all = ok(!!digest && ed25519Ok(s.operator.pubkey, s.operator.sig, Buffer.from(digest, "hex")), `operator signature by ${s.operator.pubkey}`) && all;
    if (pinned) all = ok(s.operator.pubkey === pinned, "operator key equals the pinned one") && all;
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
    if (seen.has(v.address)) {
      all = ok(false, `vault ${v.address} listed once`) && all;
      continue;
    }
    seen.add(v.address);
    if (ok(ed25519Ok(v.address, v.sig, Buffer.from(`unzeen/verify/v1/vault\n${s.chainId}\n${s.id}\n${v.address}`)), `vault ${v.address} signed`)) signed.push(v);
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
          isUint(pc.value) && BigInt(pc.value) < 1n << 64n && (granule === 0n || BigInt(pc.value) % granule === 0n) &&
          isHex32(pc.blind) && Array.isArray(pc.path) && pc.path.length === depth;
        if (shapeOk) {
          let cur = { hash: leafHash(s.chainId, s.id, ap.asset, pk, pc.piece, pc.value, pc.blind), sum: BigInt(pc.value) };
          let idx = pc.leafIndex;
          for (const sib of pc.path) {
            if (!isHex32(sib.hash) || !isUint(sib.sum)) throw new Error("bad path entry");
            const sn = { hash: Buffer.from(sib.hash, "hex"), sum: BigInt(sib.sum) };
            cur = idx % 2 === 0 ? node(cur, sn) : node(sn, cur);
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
      ok(BigInt(t.sum) <= proven + bridged + attested, `ZEC liabilities ${t.sum} <= ${proven} proven (SOL) + ${bridged} bridged (ZEC SPL) + ${attested} attested (operator) zat  [informational: attested part]`);
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
    console.error("usage: node verify-proof.mjs <proof.json> --operator <base58 attestation key>   (or --trust-any-operator)");
    process.exit(2);
  }
  if (trustAnyOperator) console.error("WARNING: --trust-any-operator: the operator signature is checked, but not WHO signed. Pin the key from the README instead.\n");
  const r = check(JSON.parse(readFileSync(file, "utf8")), i >= 0 ? args[i + 1] : undefined, { trustAnyOperator });
  console.log(r.lines.join("\n"));
  console.log(r.ok ? "\nAll checks passed." : "\nSome checks FAILED.");
  process.exit(r.ok ? 0 : 1);
}
