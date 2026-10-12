#!/usr/bin/env node
// Unzeen: check a Verify proof offline. No dependencies: Node.js >= 18 (node:crypto) only.
//
//   node verify-proof.mjs unzeen-proof-0202-101.json [--operator <base58 attestation key>]
//
// The input is the file from "Download proof" on /verify: { anonPubkey, snapshot, proof }.
// Checks, exactly as the page does (docs/API.md v0.7, "Verify"):
//   1. rootsDigest recomputed from the snapshot fields;
//   2. operator.sig = ed25519 over the 32 digest bytes (and the key equals --operator, if given);
//   3. every vault.sig = ed25519 over "unzeen/verify/v1/vault\n<chainId>\n<id>\n<address>";
//   4. every piece of your balance climbs its Merkle-sum path to the tree root (hash and sum);
//   5. solvency: mints by signed vault balances, ZEC by spare SOL (proven) + reserve (attested).
// Then compare the digest with the memo of the anchor tx in any Solana explorer or RPC you trust.

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s) {
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
const asset32 = (a) => (a === "ZEC" ? Buffer.alloc(32) : b58decode(a));

export function leafHash(chainId, snapshotId, asset, pubkey, piece, value, blind) {
  return sha(tag("leaf"), Buffer.from(chainId, "hex"), be(snapshotId, 4), asset32(asset), pubkey, be(piece, 1), be(value, 8), Buffer.from(blind, "hex"));
}
const node = (l, r) => ({ hash: sha(tag("node"), l.hash, be(l.sum, 16), r.hash, be(r.sum, 16)), sum: l.sum + r.sum });

export function rootsDigest(s) {
  const trees = s.trees.map((t) => ({ a: asset32(t.asset), root: Buffer.from(t.root, "hex"), sum: BigInt(t.sum) })).sort((x, y) => Buffer.compare(x.a, y.a));
  const parts = [tag("snapshot"), Buffer.from(s.chainId, "hex"), be(s.id, 4), be(Math.floor(s.takenAt / 1000), 8), be(s.leaves, 4), be(s.solanaSlot, 8), be(s.zcashHeight, 4), be(s.zecReserve.amountZat, 8), be(trees.length, 4)];
  for (const t of trees) parts.push(t.a, t.root, be(t.sum, 16));
  return sha(...parts).toString("hex");
}

export function ed25519Ok(pubB58, sigB58, msg) {
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b58decode(pubB58).toString("base64url") }, format: "jwk" });
    return edVerify(null, msg, key, b58decode(sigB58));
  } catch {
    return false;
  }
}

export function check(file, operator) {
  const { snapshot: s, proof: p, anonPubkey } = file;
  const out = [];
  const ok = (cond, what) => (out.push(`${cond ? "OK  " : "FAIL"} ${what}`), cond);
  const digest = rootsDigest(s);
  let all = ok(digest === s.rootsDigest, `rootsDigest ${digest}`);
  if (s.operator) {
    all = ok(ed25519Ok(s.operator.pubkey, s.operator.sig, Buffer.from(digest, "hex")), `operator signature by ${s.operator.pubkey}`) && all;
    if (operator) all = ok(s.operator.pubkey === operator, "operator key equals the pinned one") && all;
  } else {
    out.push("WAIT snapshot not signed / anchored yet");
    // Asked to check against a pinned key: no signature is not a pass.
    if (operator) all = ok(false, "operator signature present") && all;
  }
  const signed = s.vaults.filter((v) => ok(ed25519Ok(v.address, v.sig, Buffer.from(`unzeen/verify/v1/vault\n${s.chainId}\n${s.id}\n${v.address}`)), `vault ${v.address} signed`));
  all = signed.length === s.vaults.length && all;
  const pk = b58decode(anonPubkey);
  all = ok(p.snapshotId === s.id, `proof is for snapshot #${s.id}`) && all;
  for (const ap of p.proofs) {
    const tree = s.trees.find((t) => t.asset === ap.asset);
    if (!ok(!!tree, `tree for ${ap.asset}`)) {
      all = false;
      continue;
    }
    let committed = 0n;
    for (const pc of ap.pieces) {
      let cur = { hash: leafHash(s.chainId, s.id, ap.asset, pk, pc.piece, pc.value, pc.blind), sum: BigInt(pc.value) };
      let idx = pc.leafIndex;
      for (const sib of pc.path) {
        const sn = { hash: Buffer.from(sib.hash, "hex"), sum: BigInt(sib.sum) };
        cur = idx % 2 === 0 ? node(cur, sn) : node(sn, cur);
        idx = Math.floor(idx / 2);
      }
      const good = pc.path.length === Math.log2(s.leaves) && cur.hash.toString("hex") === tree.root && cur.sum === BigInt(tree.sum);
      all = ok(good, `${ap.asset} piece ${pc.piece} (${pc.value}) climbs to the root`) && all;
      if (good) committed += BigInt(pc.value);
    }
    out.push(`     ${ap.asset}: committed to your key >= ${committed} base units`);
  }
  // Solvency
  const lamports = signed.reduce((n, v) => n + BigInt(v.lamports), 0n);
  for (const t of s.trees) {
    if (t.asset === "ZEC") {
      const spare = lamports > BigInt(s.committedLamports) ? lamports - BigInt(s.committedLamports) : 0n;
      const proven = s.rateLamportsPerZecSell ? (spare * 100_000_000n) / BigInt(s.rateLamportsPerZecSell) : 0n;
      const attested = BigInt(s.zecReserve.amountZat);
      ok(BigInt(t.sum) <= proven + attested, `ZEC liabilities ${t.sum} <= ${proven} proven (SOL) + ${attested} attested (operator) zat`);
    } else {
      const held = signed.flatMap((v) => v.tokens).filter((x) => x.mint === t.asset).reduce((n, x) => n + BigInt(x.amount), 0n);
      all = ok(BigInt(t.sum) <= held, `${t.asset} liabilities ${t.sum} <= vaults ${held}`) && all;
    }
  }
  return { ok: all, lines: out };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const i = args.indexOf("--operator");
  if (!file) {
    console.error("usage: node verify-proof.mjs <proof.json> [--operator <base58 attestation key>]");
    process.exit(2);
  }
  const r = check(JSON.parse(readFileSync(file, "utf8")), i >= 0 ? args[i + 1] : undefined);
  console.log(r.lines.join("\n"));
  console.log(r.ok ? "\nAll checks passed." : "\nSome checks FAILED.");
  process.exit(r.ok ? 0 : 1);
}
