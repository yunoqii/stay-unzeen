// Mock of core's Verify (docs/API.md v0.7, v0.10). Loaded by lib/api/mock.ts on the first /api/verify* call,
// so pages that never verify carry none of it.
//
// Builds real Merkle-sum trees with the same hashes as core (lib/verify/merkle-sum.ts, checked against
// core/testdata/verify-vectors.json): balances rounded up to the granule, split into 2-4 pieces,
// padded with dummy leaves to N >= 1024, shuffled. Vaults and the operator sign with real ed25519 keys
// (TEST ONLY seeds), so the browser-side checks run exactly as against core.
//
// History: one snapshot a day at 00:00 UTC for the last week. "Take a snapshot" (mock only) plays the
// devnet operator command; v0.10: the operator signature appears right away (~1.5 s), the anchor a few
// seconds later, once the memo-tx is confirmed ("Signed · Anchor pending" in between).
// v0.10: no SOL tree; a creator's claimable lamports are folded into their ZEC leaf at rateLamportsPerZecBuy.

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import type { SignedHeaders } from "@/lib/crypto/sign";
import type { Network } from "@/lib/network";
import { assetBytes, leafHash, nodeOf, rootsDigest, vaultMessage, type SumNode } from "@/lib/verify/merkle-sum";
import { ApiError } from "./errors";
import type { AssetId, VerifyProof, VerifySnapshot, VerifySnapshotSummary, VerifyVault } from "./types";

export interface VerifyHost {
  chainId(network: Network): "0202" | "0101";
  /** lamports per ZEC on the sell side (what SOL counts for in the ZEC cover). */
  rateSell(): bigint;
  /** v0.10: lamports per ZEC on the buy side (creators' claimable -> ZEC liabilities, ceil). */
  rateBuy(): bigint;
  /** Every mock account with a balance right now: available + held. */
  accounts(network: Network): { pubkey: string; zat: bigint; tokens: { mint: string; amount: bigint }[]; claimLamports?: bigint; claimZat?: bigint }[];
  /** v0.13: the pool's quote assets on this network (non-SOL pairs). Absent / empty: no quoteAssets in snapshots. */
  quoteAssets?(network: Network): { mint: string; quote: "ZEC" | "USDC" | "USD1"; decimals: number; bridged: boolean }[];
  /** Tokens the mock market knows (synthetic holders pick from these). */
  tokens(): { mint: string; decimals: number }[];
  /** Signed-request check with nonce replay, as in core. Returns the header pubkey. */
  authorize(network: Network, method: string, pathWithQuery: string, body: string | undefined, headers: Partial<SignedHeaders>): string;
}

export interface VerifyMock {
  get(network: Network, pathWithQuery: string, headers: Partial<SignedHeaders>): unknown;
  /** Devnet operator command (`unzeen-api verify-snapshot`), mock edition. */
  takeSnapshot(network: Network): number;
}

const N0 = BigInt(0);
const ZAT = BigInt(100_000_000);
const ZEC_GRANULE = BigInt(100_000);
const RESERVE_STEP = BigInt(1_000_000);
const MIN_LEAVES = 1024;
const DAY = 86_400_000;
const HISTORY_DAYS = 7;
const RETENTION_MS = 48 * 3_600_000;
const SIGN_DELAY_MS = 1_500;
const ANCHOR_DELAY_MS = 25_000; // longer than one 10 s poll of /verify, so "Signed · Anchor pending" is visible in the demo
const PROOF_BUCKET = 65_536; // API v0.7 final: always exactly 64 KiB
const PROOF_LIMIT_PER_MIN = 10;
const MAX_PROOF_ASSETS = 12;
const enc = new TextEncoder();

const seedOf = (label: string) => sha256(enc.encode(label));
/** TEST ONLY: the pinned mock key in lib/verify/pinned.ts is derived from this seed. */
const OPERATOR_SEED = seedOf("unzeen/mock/attestation-key");
const OPERATOR_PUBKEY = base58.encode(ed25519.getPublicKey(OPERATOR_SEED));

/** Deterministic PRNG (mulberry32 over a string hash). */
function prng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
function b58(len: number): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let s = "";
  for (const b of randBytes(len)) s += A[b % 58];
  return s;
}

const roundUp = (v: bigint, g: bigint) => (g <= BigInt(1) ? v : ((v + g - BigInt(1)) / g) * g);

/** Cut `v` (a multiple of g) into s pieces, each a multiple of g; zeros allowed. */
function split(v: bigint, g: bigint, s: number): bigint[] {
  const units = v / g;
  const cuts = Array.from({ length: s - 1 }, () => (units === N0 ? N0 : BigInt(Math.floor(Math.random() * (Number(units) + 1)))));
  cuts.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: bigint[] = [];
  let prev = N0;
  for (const c of cuts) {
    out.push((c - prev) * g);
    prev = c;
  }
  out.push((units - prev) * g);
  return out;
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

interface OwnerLeaf {
  asset: AssetId;
  decimals: number;
  piece: number;
  leafIdx: number;
  value: bigint;
  blind: Uint8Array;
}

interface Snap {
  pub: VerifySnapshot;
  /** v0.10: the operator signature is public from here (before the memo-tx). */
  signAt: number;
  /** The anchor is public from here (memo-tx confirmed). */
  anchorAt: number;
  operator: { pubkey: string; sig: string };
  anchor: { solanaTx: string; slot: number; matches: boolean; blockTime: number | null };
  /** Kept 48 h: tree levels per asset and the owner bindings. */
  levels: Map<AssetId, SumNode[][]> | null;
  owners: Map<string, OwnerLeaf[]> | null;
}

interface Holder {
  pubkey: string;
  balances: Map<AssetId, bigint>;
}

export function createVerifyMock(host: VerifyHost): VerifyMock {
  const snaps: Record<Network, Snap[] | null> = { devnet: null, mainnet: null, hood: null };
  const proofCalls = new Map<string, number[]>();

  const vaultSeeds = (network: Network) => Array.from({ length: 4 }, (_, i) => seedOf(`unzeen/mock/vault:${network}:${i}`));

  function synthetic(network: Network, day: number): Holder[] {
    const rnd = prng(`verify-holders:${network}:${day}`);
    const mints = host.tokens().slice(0, 6);
    return Array.from({ length: 36 }, (_, i) => {
      const r = prng(`verify-holder:${network}:${i}`);
      const pubkey = base58.encode(seedOf(`unzeen/mock/holder:${network}:${i}`));
      const balances = new Map<AssetId, bigint>();
      // Lognormal-ish ZEC balance, drifting a little day by day.
      const zec = Math.exp(r() * 5 - 2.5) * (0.85 + rnd() * 0.3);
      if (r() < 0.9) balances.set("ZEC", BigInt(Math.floor(zec * 1e8)));
      for (const t of mints) if (r() < 0.3) balances.set(t.mint, BigInt(Math.floor((0.2 + rnd() * 6) * 1e6 * 10 ** t.decimals)));
      return { pubkey, balances };
    });
  }

  function real(network: Network): Holder[] {
    return host.accounts(network).map((a) => {
      const balances = new Map<AssetId, bigint>();
      // v0.10: creator fees owed are in the creator's ZEC leaf: ceil(claimable × 1e8 / rateLamportsPerZecBuy).
      const rateBuy = host.rateBuy();
      // v0.14: plus ZEC-pair fees owed, in zatoshis as they are.
      const claimZat = (a.claimLamports && a.claimLamports > N0 ? (a.claimLamports * ZAT + rateBuy - BigInt(1)) / rateBuy : N0) + (a.claimZat ?? N0);
      if (a.zat + claimZat > N0) balances.set("ZEC", a.zat + claimZat);
      for (const t of a.tokens) if (t.amount > N0) balances.set(t.mint, (balances.get(t.mint) ?? N0) + t.amount);
      return { pubkey: a.pubkey, balances };
    });
  }

  function build(network: Network, id: number, takenAt: number, holders: Holder[], now: number, signAt: number, anchorAt: number): Snap {
    const chainId = host.chainId(network);
    const decimals = new Map<string, number>(host.tokens().map((t) => [t.mint, t.decimals]));
    // Review E1 / v0.10: mint trees use 1 base unit (vaults hold exactly Σ balances); ZEC rounds up to 0.001.
    const granuleOf = (asset: AssetId) => (asset === "ZEC" ? ZEC_GRANULE : BigInt(1));
    const decimalsOf = (asset: AssetId) => (asset === "ZEC" ? 8 : (decimals.get(asset) ?? 6));

    // Pieces per asset: rounded UP, split into 2-4.
    const pieces = new Map<AssetId, { pubkey: Uint8Array; owner: string; piece: number; value: bigint }[]>([["ZEC", []]]);
    for (const h of holders) {
      const pk = base58.decode(h.pubkey);
      if (pk.length !== 32) continue;
      for (const [asset, v] of h.balances) {
        if (!assetBytes(asset) || v <= N0) continue;
        const rounded = roundUp(v, granuleOf(asset));
        const s = 2 + Math.floor(Math.random() * 3);
        const list = pieces.get(asset) ?? [];
        split(rounded, granuleOf(asset), s).forEach((value, piece) => list.push({ pubkey: pk, owner: h.pubkey, piece, value }));
        pieces.set(asset, list);
      }
    }
    const maxPieces = Math.max(...[...pieces.values()].map((l) => l.length));
    let n = MIN_LEAVES;
    while (n < 2 * maxPieces) n *= 2;

    const levels = new Map<AssetId, SumNode[][]>();
    const owners = new Map<string, OwnerLeaf[]>();
    const trees: VerifySnapshot["trees"] = [];
    for (const [asset, list] of pieces) {
      const ab = assetBytes(asset)!;
      const slots = shuffle(Array.from({ length: n }, (_, i) => i));
      const leaves: SumNode[] = new Array(n);
      list.forEach((p, k) => {
        const blind = randBytes(32);
        const leafIdx = slots[k];
        leaves[leafIdx] = { hash: leafHash({ chainId, snapshotId: id, asset: ab, anonPubkey: p.pubkey, piece: p.piece, value: p.value, blind }), sum: p.value };
        const own = owners.get(p.owner) ?? [];
        own.push({ asset, decimals: decimalsOf(asset), piece: p.piece, leafIdx, value: p.value, blind });
        owners.set(p.owner, own);
      });
      // Dummy leaves: value 0, random pubkey and blind, indistinguishable by hash.
      for (let i = 0; i < n; i++)
        if (!leaves[i]) leaves[i] = { hash: leafHash({ chainId, snapshotId: id, asset: ab, anonPubkey: randBytes(32), piece: 0, value: N0, blind: randBytes(32) }), sum: N0 };
      const lv: SumNode[][] = [leaves];
      while (lv[lv.length - 1].length > 1) {
        const prev = lv[lv.length - 1];
        const next: SumNode[] = [];
        for (let i = 0; i < prev.length; i += 2) next.push(nodeOf(prev[i], prev[i + 1]));
        lv.push(next);
      }
      levels.set(asset, lv);
      const root = lv[lv.length - 1][0];
      trees.push({ asset, decimals: decimalsOf(asset), granule: granuleOf(asset).toString(), root: bytesToHex(root.hash), sum: root.sum.toString() });
    }
    // Same order core returns (ORDER BY asset text).
    trees.sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));

    // Assets: every mint covered by the vaults with a small surplus; ZEC partly attested, partly SOL.
    const rnd = prng(`verify-assets:${network}:${id}`);
    const seeds = vaultSeeds(network);
    const vaultTokens: { mint: string; amount: bigint }[][] = seeds.map(() => []);
    for (const t of trees) {
      if (t.asset === "ZEC") continue;
      const total = (BigInt(t.sum) * BigInt(10_000 + Math.floor(rnd() * 400))) / BigInt(10_000) + BigInt(t.granule);
      // One or two vaults per mint, like mint_vaults in the relayer.
      const a = Math.floor(rnd() * seeds.length);
      const b = (a + 1) % seeds.length;
      const first = (total * BigInt(55 + Math.floor(rnd() * 40))) / BigInt(100);
      vaultTokens[a].push({ mint: t.asset, amount: first });
      if (total - first > N0) vaultTokens[b].push({ mint: t.asset, amount: total - first });
    }
    const zecLiab = BigInt(trees.find((t) => t.asset === "ZEC")?.sum ?? "0");
    const rate = host.rateSell();
    const reserve = ((zecLiab * BigInt(58 + Math.floor(rnd() * 10))) / BigInt(100) / RESERVE_STEP) * RESERVE_STEP;
    // v0.13: quote assets on the vaults. ZEC SPL (bridged) covers ~6-10 % of ZEC 1:1, one vault holds dust
    // below dustBelow (not counted); USDC / USD1 sit there too but never count.
    const qa = host.quoteAssets?.(network) ?? [];
    const quoteAssets: NonNullable<VerifySnapshot["quoteAssets"]> = [];
    let bridgedZat = N0;
    for (const q of qa) {
      if (quoteAssets.some((x) => x.mint === q.mint)) continue;
      const dustBelow = q.quote === "ZEC" ? BigInt(100_000) : BigInt(10) ** BigInt(q.decimals);
      quoteAssets.push({ mint: q.mint, quote: q.quote, decimals: q.decimals, bridged: q.bridged, counted: q.quote === "ZEC", dustBelow: dustBelow.toString() });
      if (q.quote === "ZEC") {
        const main = (zecLiab * BigInt(6 + Math.floor(rnd() * 5))) / BigInt(100);
        const a = Math.floor(rnd() * seeds.length);
        if (main > N0) vaultTokens[a].push({ mint: q.mint, amount: main });
        vaultTokens[(a + 2) % seeds.length].push({ mint: q.mint, amount: dustBelow / BigInt(3) }); // dust: shown, not counted
        bridgedZat += main >= dustBelow ? main : N0;
      } else {
        vaultTokens[Math.floor(rnd() * seeds.length)].push({ mint: q.mint, amount: BigInt(Math.floor((40 + rnd() * 900) * 10 ** q.decimals)) });
      }
    }
    // v0.10: only the gas of queued token withdrawals.
    const committed = BigInt(Math.floor((0.002 + rnd() * 0.02) * 1e9));
    const solPart = zecLiab - reserve - bridgedZat;
    const lamportsNeeded = ((solPart > N0 ? solPart : N0) * rate) / ZAT;
    const lamportsTotal = (lamportsNeeded * BigInt(108 + Math.floor(rnd() * 10))) / BigInt(100) + committed + BigInt(250_000_000);
    const weights = seeds.map(() => 1 + rnd() * 3);
    const wsum = weights.reduce((x, y) => x + y, 0);
    let given = N0;
    const vaults: VerifyVault[] = seeds.map((seed, i) => {
      const address = base58.encode(ed25519.getPublicKey(seed));
      const lamports = i === seeds.length - 1 ? lamportsTotal - given : (lamportsTotal * BigInt(Math.floor((weights[i] / wsum) * 1e6))) / BigInt(1e6);
      given += lamports;
      return {
        address,
        sig: base58.encode(ed25519.sign(enc.encode(vaultMessage(chainId, id, address)), seed)),
        lamports: lamports.toString(),
        tokens: vaultTokens[i].map((t) => ({ mint: t.mint, amount: t.amount.toString() })),
      };
    });

    const solanaSlot = 300_000_000 + Math.floor((takenAt - Date.UTC(2026, 0, 1)) / 400);
    const zcashHeight = 3_000_000 + Math.floor((takenAt - Date.UTC(2026, 0, 1)) / 75_000);
    const base = {
      id,
      chainId,
      // v0.17: new snapshots sign quoteAssets too (digest v2).
      digestVersion: 2 as const,
      takenAt,
      leaves: n,
      solanaSlot,
      zcashHeight,
      trees,
      vaults,
      committedLamports: committed.toString(),
      rateLamportsPerZecSell: rate.toString(),
      rateLamportsPerZecBuy: host.rateBuy().toString(),
      zecReserve: { amountZat: reserve.toString(), height: zcashHeight, attested: true as const },
      ...(quoteAssets.length ? { quoteAssets } : {}),
    };
    const digest = rootsDigest(base);
    const pub: VerifySnapshot = { ...base, rootsDigest: digest };
    const keep = now - takenAt < RETENTION_MS;
    return {
      pub,
      signAt,
      anchorAt,
      operator: { pubkey: OPERATOR_PUBKEY, sig: base58.encode(ed25519.sign(hexToBytes(digest), OPERATOR_SEED)) },
      anchor: { solanaTx: b58(88), slot: solanaSlot + 40 + Math.floor(rnd() * 30), matches: true, blockTime: Math.floor(anchorAt / 1000) },
      levels: keep ? levels : null,
      owners: keep ? owners : null,
    };
  }

  function list(network: Network): Snap[] {
    let l = snaps[network];
    if (l) return l;
    const now = Date.now();
    const today = Math.floor(now / DAY) * DAY;
    l = [];
    for (let d = HISTORY_DAYS - 1; d >= 0; d--) {
      const takenAt = today - d * DAY;
      // Your own (mock) balance is in the last two snapshots: the ones whose proofs are still kept.
      const holders = [...synthetic(network, takenAt / DAY), ...(d <= 1 ? real(network) : [])];
      l.push(build(network, 100 - d, takenAt, holders, now, takenAt + 30_000, takenAt + 90_000));
    }
    snaps[network] = l;
    return l;
  }

  function publicOf(s: Snap, now: number): VerifySnapshot {
    if (now < s.signAt) return structuredClone(s.pub);
    if (now < s.anchorAt) return { ...structuredClone(s.pub), operator: { ...s.operator } };
    return { ...structuredClone(s.pub), operator: { ...s.operator }, anchor: { ...s.anchor } };
  }

  const summaryOf = (s: VerifySnapshot): VerifySnapshotSummary => ({ id: s.id, takenAt: s.takenAt, rootsDigest: s.rootsDigest, ...(s.anchor ? { anchor: s.anchor } : {}) });

  function proof(network: Network, pathWithQuery: string, headers: Partial<SignedHeaders>, q: URLSearchParams): VerifyProof {
    const pubkey = host.authorize(network, "GET", pathWithQuery, undefined, headers);
    const now = Date.now();
    const key = `${network}:${pubkey}`;
    const calls = (proofCalls.get(key) ?? []).filter((t) => t > now - 60_000);
    if (calls.length >= PROOF_LIMIT_PER_MIN) throw new ApiError("rate_limited", "verify proof: 10/min", 429, undefined, 30);
    calls.push(now);
    proofCalls.set(key, calls);

    const l = list(network);
    const [latest, previous] = [l[l.length - 1], l[l.length - 2]];
    const want = q.get("snapshot");
    const snap = want === null ? latest : [latest, previous].find((s) => s && String(s.pub.id) === want);
    if (!snap || !snap.levels || !snap.owners) throw new ApiError("not_found", "no proof for this snapshot", 404);
    const mine = snap.owners.get(pubkey) ?? [];
    const byAsset = new Map<AssetId, OwnerLeaf[]>();
    for (const o of mine) byAsset.set(o.asset, [...(byAsset.get(o.asset) ?? []), o]);
    let assets = [...byAsset.keys()];
    const truncated = assets.length > MAX_PROOF_ASSETS;
    if (truncated) assets = [...assets.filter((a) => a === "ZEC"), ...shuffle(assets.filter((a) => a !== "ZEC"))].slice(0, MAX_PROOF_ASSETS);
    const out: VerifyProof = {
      snapshotId: snap.pub.id,
      truncated,
      proofs: assets.sort().map((asset) => {
        const lv = snap.levels!.get(asset)!;
        const own = byAsset.get(asset)!.sort((a, b) => a.piece - b.piece);
        return {
          asset,
          decimals: own[0].decimals,
          pieces: own.map((o) => {
            const path: { hash: string; sum: string }[] = [];
            let idx = o.leafIdx;
            for (let level = 0; level < lv.length - 1; level++) {
              const sib = lv[level][idx ^ 1];
              path.push({ hash: bytesToHex(sib.hash), sum: sib.sum.toString() });
              idx >>= 1;
            }
            return { piece: o.piece, leafIndex: o.leafIdx, value: o.value.toString(), blind: bytesToHex(o.blind), path };
          }),
        };
      }),
    };
    // Same padding as core: the size says nothing about how many assets the key holds.
    const len = JSON.stringify(out).length;
    const total = Math.max(1, Math.ceil((len + 9) / PROOF_BUCKET)) * PROOF_BUCKET;
    out.pad = " ".repeat(total - len - 9);
    return out;
  }

  return {
    get(network, pathWithQuery, headers) {
      const url = new URL(pathWithQuery, "http://mock.local");
      const p = url.pathname;
      const q = url.searchParams;
      const now = Date.now();
      const l = list(network);
      if (p === "/api/verify") return publicOf(l[l.length - 1], now);
      if (p === "/api/verify/proof") return proof(network, pathWithQuery, headers, q);
      if (p === "/api/verify/snapshots") {
        const limit = q.has("limit") ? Number(q.get("limit")) : 30;
        if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new ApiError("bad_request", "limit: 1..30", 400);
        const before = q.get("before");
        if (before !== null && !/^[1-9]\d*$/.test(before)) throw new ApiError("bad_request", "before: snapshot id", 400);
        return l
          .filter((s) => before === null || s.pub.id < Number(before))
          .reverse()
          .slice(0, limit)
          .map((s) => summaryOf(publicOf(s, now)));
      }
      const m = p.match(/^\/api\/verify\/(\d+)$/);
      const s = m && l.find((x) => x.pub.id === Number(m[1]));
      if (s) return publicOf(s, now);
      throw new ApiError("not_found", `GET ${p}`, 404);
    },
    takeSnapshot(network) {
      const l = list(network);
      const now = Date.now();
      const takenAt = Math.floor(now / 60_000) * 60_000;
      const id = l[l.length - 1].pub.id + 1;
      l.push(build(network, id, takenAt, [...synthetic(network, Math.floor(now / DAY)), ...real(network)], now, now + SIGN_DELAY_MS, now + ANCHOR_DELAY_MS));
      // 48 h retention: only the latest two keep paths and key bindings in the mock.
      for (const s of l.slice(0, -2)) {
        s.levels = null;
        s.owners = null;
      }
      return id;
    },
  };
}
