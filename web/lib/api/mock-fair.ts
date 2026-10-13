// Mock of the fair-launch part of core (docs/API.md v0.6). Loaded by lib/api/mock.ts only when the
// build has NEXT_PUBLIC_MOCK_FAIR_LAUNCH=1, so a build without the flag carries none of this.
//
// The mock checks bids exactly as core does on intake (tier, armor header, round, chain hash, one
// active bid, creator cap, balance), publishes the commitment root at close and a fake memo-tx
// attestation a few seconds later. It does NOT decrypt: after the round it imitates the reveal, taking
// the amount the bidding tab told it (mockFairHint) or a random amount within the hold for others.

import { bytesToHex } from "@noble/hashes/utils.js";
import { parseTlockArmor } from "@/lib/fair/armor";
import { QUICKNET, roundAt, roundTimeMs } from "@/lib/fair/drand";
import { buildTree, leafOf } from "@/lib/fair/merkle";
import { creatorMaxTier } from "@/lib/fair/tiers";
import { validateMeta } from "@/lib/launch";
import type { Network } from "@/lib/network";
import { ApiError } from "./errors";
import type { ActionReceipt, FairBid, FairLaunch, FairLaunchParams, OwnFairLaunch, PoolInfo, SignedAction, SolRateUsed } from "./types";

export interface FairHost {
  pool(network: Network): PoolInfo;
  balance(network: Network, pubkey: string): { zecBalance: bigint; zecHeld: bigint; frozen: boolean };
  buyRate(): SolRateUsed;
  /** launchRules.maxInitialBuyLamports of the mock pool. */
  creatorMaxLamports: string;
  createFeeZat: bigint;
  /** Atomic create + buy by a vault: new token in the mock market, `create` + `buy` in the feed. */
  launch(network: Network, a: { name: string; symbol: string; image?: string; lamports: bigint }): { mint: string; tokenAmount: bigint; decimals: number; solanaTx: string; priceSol: string };
  creditTokens(network: Network, pubkey: string, mint: string, amount: bigint): void;
  b58(len: number): string;
}

export interface FairMock {
  params(network: Network): FairLaunchParams;
  tick(now: number): void;
  get(network: Network, path: string, query: URLSearchParams): unknown;
  submit(network: Network, pubkey: string, action: SignedAction): ActionReceipt;
  portfolio(network: Network, pubkey: string): { fairBids: FairBid[]; fairLaunches: OwnFairLaunch[] };
}

const N0 = BigInt(0);
const ZAT = BigInt(100_000_000);
const LAMPORTS_STEP = BigInt(1_000_000); // D10: round the buy down to 0.001 SOL

const WINDOWS = [120, 300, 600, 1800];
const TIERS: Record<Network, string[]> = {
  mainnet: ["5000000", "10000000", "25000000", "50000000", "100000000", "250000000", "500000000", "1000000000"],
  devnet: ["100000", "250000", "500000", "1000000", "2500000", "5000000"],
  hood: [],
};
/** 25 % of supply on a fresh curve; devnet's curve is ~30x cheaper. */
const MAX_TOTAL: Record<Network, bigint> = { mainnet: BigInt(7_500_000_000), devnet: BigInt(250_000_000), hood: BigInt(0) };
/** The demo's "Delayed epoch" before a new launch shows up publicly (core: 30-60 s). */
const PUBLISH_MS: [number, number] = [5_000, 10_000];
const ATTEST_MS = 4_000;
/** v0.8: at most 1024 bids per launch (commitment tree of depth 10). */
export const MAX_BIDS = 1024;
const REVEAL_MS = 2_000;
const EXECUTE_MS = 3_500;
export const ATTESTATION_SIGNER = "UnzAttest1111111111111111111111111111111111";

interface MBid {
  pubkey: string | null; // null: someone else (synthetic)
  holdZat: bigint;
  leaf: Uint8Array;
  amountZat: bigint;
  status: FairBid["status"];
  proof?: { leaf: string; path: string[] };
  tokenAmount?: bigint;
  chargedZat?: bigint;
  releasedZat?: bigint;
}

interface MLaunch {
  network: Network;
  creator: string | null;
  image?: string;
  pub: FairLaunch;
  bids: MBid[];
  feeHeld: boolean;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const hex16 = () => bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
const randomLeaf = () => crypto.getRandomValues(new Uint8Array(32));
const big = (v: unknown, field: string) => {
  if (typeof v !== "string" || !/^(0|[1-9]\d{0,18})$/.test(v)) throw new ApiError("bad_request", `${field}: integer string`, 400);
  return BigInt(v);
};

/** Amounts the bidding tab sealed, keyed by ciphertext leaf: stands in for decryption after the round. */
const hints = new Map<string, bigint>();
export function mockFairHint(ciphertext: string, amountZat: bigint) {
  hints.set(bytesToHex(leafOf(ciphertext)), amountZat);
}

export function createFairMock(host: FairHost): FairMock {
  const launches = new Map<string, MLaunch>();
  const seeded = new Set<Network>();

  const params = (network: Network): FairLaunchParams => {
    return {
      windowsSecs: WINDOWS,
      holdTiersZat: TIERS[network],
      maxTotalBps: 2500,
      maxTotalLamports: MAX_TOTAL[network].toString(),
      creatorMaxLamports: host.creatorMaxLamports,
      minBidsForCount: 5,
      drand: { ...QUICKNET },
    };
  };

  function schedule(network: Network, creator: string | null, meta: { name: string; symbol: string; image?: string }, windowSecs: number, publishedAt: number): MLaunch {
    const closeAt = publishedAt + windowSecs * 1000;
    const round = roundAt(closeAt) + 2;
    const l: MLaunch = {
      network,
      creator,
      image: meta.image,
      feeHeld: creator !== null,
      bids: [],
      pub: {
        id: hex16(),
        venue: "pumpfun",
        meta: { name: meta.name, symbol: meta.symbol },
        status: "open",
        publishedAt,
        closeAt,
        drand: { round, roundTime: roundTimeMs(round) },
        rules: ["fair_launch_sealed_bids", "creator_initial_buy_locked_24h", "initial_buy_cap_5pct"],
      },
    };
    // Others bid at random moments of the window, 2-9 of them, so "<5" and counts both happen.
    const tiers = TIERS[network].map(BigInt);
    const n = Math.floor(rand(2, 10));
    for (let i = 0; i < n; i++) {
      const hold = tiers[Math.floor(rand(0, tiers.length - 2))];
      l.bids.push({ pubkey: null, holdZat: hold, leaf: randomLeaf(), amountZat: (hold * BigInt(Math.floor(rand(35, 100)))) / BigInt(100), status: "sealed" });
    }
    launches.set(l.pub.id, l);
    return l;
  }

  function seed(network: Network, now: number) {
    if (seeded.has(network)) return;
    seeded.add(network);
    // One launch by someone else, already open, so there is something to bid on in a fresh session.
    schedule(network, null, { name: "Sealed Shade", symbol: "SSHADE" }, 1800, now - 240_000);
  }

  const balance = (l: MLaunch, pubkey: string) => host.balance(l.network, pubkey);

  function release(l: MLaunch, b: MBid, status: FairBid["status"]) {
    if (b.pubkey) {
      const a = balance(l, b.pubkey);
      a.zecHeld -= b.holdZat;
      a.zecBalance += b.holdZat;
    }
    b.status = status;
    b.releasedZat = b.holdZat;
  }

  function returnFee(l: MLaunch) {
    if (!l.feeHeld || !l.creator) return;
    const a = balance(l, l.creator);
    a.zecHeld -= host.createFeeZat;
    a.zecBalance += host.createFeeZat;
    l.feeHeld = false;
  }

  function fail(l: MLaunch, failure: NonNullable<FairLaunch["failure"]>) {
    for (const b of l.bids) if (b.status === "sealed" || b.status === "revealed") release(l, b, "released");
    returnFee(l);
    l.pub.status = "failed";
    l.pub.failure = failure;
  }

  function close(l: MLaunch) {
    const sealed = l.bids.filter((b) => b.status === "sealed");
    const tree = buildTree(
      sealed.map((b) => b.leaf),
      randomLeaf,
    );
    sealed.forEach((b, i) => {
      b.proof = { leaf: bytesToHex(b.leaf), path: tree.proofs[i].map(bytesToHex) };
    });
    l.pub.status = "closed";
    l.pub.commitment = { root: bytesToHex(tree.root) };
  }

  function reveal(l: MLaunch, minAction: bigint) {
    l.pub.status = "revealing";
    for (const b of l.bids) {
      if (b.status !== "sealed") continue;
      const hinted = hints.get(bytesToHex(b.leaf));
      if (b.pubkey && hinted === undefined) {
        // Sealed in another tab or before a reload: the mock cannot decrypt, so it guesses within the hold.
        b.amountZat = (b.holdZat * BigInt(Math.floor(rand(50, 100)))) / BigInt(100);
      } else if (hinted !== undefined) b.amountZat = hinted;
      if (b.amountZat < minAction || b.amountZat > b.holdZat) release(l, b, "invalid");
      else b.status = "revealed";
    }
  }

  function execute(l: MLaunch) {
    const p = params(l.network);
    const rate = BigInt(host.buyRate().lamportsPerZec);
    const valid = l.bids.filter((b) => b.status === "revealed");
    const creatorMax = p.creatorMaxLamports ? BigInt(p.creatorMaxLamports) : null;
    let lam = valid.map((b) => {
      const li = (b.amountZat * rate) / ZAT;
      return b.pubkey && b.pubkey === l.creator && creatorMax !== null && li > creatorMax ? creatorMax : li;
    });
    const sum = lam.reduce((x, y) => x + y, N0);
    const cap = MAX_TOTAL[l.network];
    const oversubscribed = sum > cap;
    if (oversubscribed) lam = lam.map((x) => (x * cap) / sum);
    const E = lam.reduce((x, y) => x + y, N0);
    const S = (E / LAMPORTS_STEP) * LAMPORTS_STEP;
    if (valid.length === 0 || S === N0) return fail(l, "no_bids");
    l.pub.status = "executing";
    l.pub.drand.signature = bytesToHex(crypto.getRandomValues(new Uint8Array(48)));
    const out = host.launch(l.network, { name: l.pub.meta.name, symbol: l.pub.meta.symbol, image: l.image, lamports: S });
    const T = out.tokenAmount;
    valid.forEach((b, i) => {
      const e = lam[i];
      const tokens = (T * e) / E;
      const lamportsPaid = (S * e + E - BigInt(1)) / E;
      let charged = (lamportsPaid * ZAT + rate - BigInt(1)) / rate;
      if (charged > b.amountZat) charged = b.amountZat;
      b.tokenAmount = tokens;
      b.chargedZat = charged;
      b.releasedZat = b.holdZat - charged;
      b.status = "settled";
      if (b.pubkey) {
        const a = balance(l, b.pubkey);
        a.zecHeld -= b.holdZat;
        a.zecBalance += b.holdZat - charged;
        host.creditTokens(l.network, b.pubkey, out.mint, tokens);
      }
    });
    if (l.feeHeld && l.creator) {
      balance(l, l.creator).zecHeld -= host.createFeeZat;
      l.feeHeld = false;
    }
    l.pub.result = {
      mint: out.mint,
      solanaTx: out.solanaTx,
      totalLamports: S.toString(),
      tokenAmount: T.toString(),
      decimals: out.decimals,
      priceSol: out.priceSol,
      bids: valid.length >= p.minBidsForCount ? valid.length : "<5",
      oversubscribed,
    };
  }

  function tick(now: number) {
    for (const l of launches.values()) {
      const s = l.pub.status;
      if (s === "launched" || s === "failed" || s === "cancelled") continue;
      if (now < l.pub.publishedAt) continue;
      if (s === "open" && now >= l.pub.closeAt) close(l);
      if (l.pub.status === "closed" && l.pub.commitment && !l.pub.commitment.attestation && now >= l.pub.closeAt + ATTEST_MS) {
        const blockTime = Math.floor(now / 1000);
        l.pub.commitment.attestation = {
          solanaTx: host.b58(88),
          slot: 380_000_000 + Math.floor((l.pub.closeAt / 400) % 10_000_000),
          signer: ATTESTATION_SIGNER,
          matches: true,
          // v0.8: block time of the memo-tx and whether it landed before the round (2 s margin).
          blockTime,
          beforeRound: blockTime * 1000 + 2000 < l.pub.drand.roundTime,
        };
      }
      const minAction = BigInt(host.pool(l.network).minActionZat);
      if (l.pub.status === "closed" && now >= l.pub.drand.roundTime) reveal(l, minAction);
      if (l.pub.status === "revealing" && now >= l.pub.drand.roundTime + REVEAL_MS) execute(l);
      if (l.pub.status === "executing" && now >= l.pub.drand.roundTime + REVEAL_MS + EXECUTE_MS) l.pub.status = "launched";
    }
  }

  function publicView(l: MLaunch): FairLaunch {
    return structuredClone(l.pub);
  }

  function get(network: Network, path: string, q: URLSearchParams): unknown {
    seed(network, Date.now());
    const now = Date.now();
    if (path === "/api/launches") {
      const status = q.get("status");
      const limit = Math.min(Number(q.get("limit") ?? 50) || 50, 100);
      return [...launches.values()]
        .filter((l) => l.network === network && l.pub.publishedAt <= now && (!status || l.pub.status === status))
        .sort((a, b) => b.pub.publishedAt - a.pub.publishedAt)
        .slice(0, limit)
        .map(publicView);
    }
    const m = path.match(/^\/api\/launches\/([^/]+)$/);
    if (m) {
      const l = launches.get(decodeURIComponent(m[1]));
      if (!l || l.network !== network || l.pub.publishedAt > now) throw new ApiError("not_found", "unknown launch", 404);
      return publicView(l);
    }
    throw new ApiError("not_found", path, 404);
  }

  function own(network: Network, id: unknown): MLaunch {
    const l = typeof id === "string" ? launches.get(id) : undefined;
    if (!l || l.network !== network) throw new ApiError("not_found", "unknown launch", 404);
    return l;
  }

  function submit(network: Network, pubkey: string, action: SignedAction): ActionReceipt {
    const now = Date.now();
    seed(network, now);
    const pool = host.pool(network);
    const a = host.balance(network, pubkey);
    if (a.frozen) throw new ApiError("balance_frozen", "balance frozen", 423);
    switch (action.op) {
      case "fl_create": {
        if (action.venue !== "pumpfun") throw new ApiError("bad_request", "fl_create: pumpfun only (v1)", 400);
        const errs = validateMeta({ name: action.meta?.name ?? "", symbol: action.meta?.symbol ?? "", image: action.meta?.image ?? null });
        if (Object.keys(errs).length) throw new ApiError("bad_request", `meta: ${Object.keys(errs).join(", ")}`, 400);
        if (!WINDOWS.includes(action.windowSecs)) throw new ApiError("bad_request", "windowSecs not allowed", 400);
        if (pool.createEnabled === false) throw new ApiError("venue_unavailable", "create disabled", 503);
        if (a.zecBalance < host.createFeeZat) throw new ApiError("insufficient_balance", "not enough ZEC", 422);
        a.zecBalance -= host.createFeeZat;
        a.zecHeld += host.createFeeZat;
        const l = schedule(network, pubkey, { name: action.meta.name.trim(), symbol: action.meta.symbol, image: action.meta.image }, action.windowSecs, now + rand(...PUBLISH_MS));
        return { id: hex16(), status: "queued", launchId: l.pub.id };
      }
      case "fl_bid": {
        const l = own(network, action.launchId);
        if (l.pub.publishedAt > now) throw new ApiError("not_found", "launch not published", 404);
        if (l.pub.status !== "open" || now >= l.pub.closeAt) throw new ApiError("launch_closed", "window closed", 409);
        // v0.8: the commitment tree has a fixed depth of 10 (1024 leaves).
        if (l.bids.filter((b) => b.status === "sealed").length >= MAX_BIDS) throw new ApiError("launch_full", "1024 bids already", 409);
        const hold = big(action.holdZat, "holdZat");
        if (!TIERS[network].includes(action.holdZat)) throw new ApiError("bad_request", "holdZat is not a tier", 400);
        const head = parseTlockArmor(action.ciphertext);
        if (!head || head.round !== l.pub.drand.round || head.chainHash !== QUICKNET.chainHash) throw new ApiError("bad_ciphertext", "not a tlock armor for this round", 400);
        if (l.bids.some((b) => b.pubkey === pubkey && b.status === "sealed")) throw new ApiError("already_bid", "one active bid per launch", 409);
        if (pubkey === l.creator) {
          const capTier = creatorMaxTier(TIERS[network], params(network).creatorMaxLamports, pool.rate?.lamportsPerZecBuy);
          if (capTier !== null && hold > capTier) throw new ApiError("creator_cap", "creator bid above cap", 422);
        }
        if (a.zecBalance < hold) throw new ApiError("insufficient_balance", "not enough ZEC", 422);
        a.zecBalance -= hold;
        a.zecHeld += hold;
        l.bids.push({ pubkey, holdZat: hold, leaf: leafOf(action.ciphertext), amountZat: N0, status: "sealed" });
        return { id: hex16(), status: "queued" };
      }
      case "fl_cancel": {
        const l = own(network, action.launchId);
        const b = l.bids.find((x) => x.pubkey === pubkey && x.status === "sealed");
        if (!b) throw new ApiError("not_found", "no active bid", 404);
        if (now >= l.pub.closeAt) throw new ApiError("launch_closed", "window closed", 409);
        release(l, b, "cancelled");
        return { id: hex16(), status: "executed" };
      }
      case "fl_cancel_launch": {
        const l = own(network, action.launchId);
        if (l.creator !== pubkey) throw new ApiError("not_found", "unknown launch", 404);
        if (now >= l.pub.closeAt || l.pub.status !== "open") throw new ApiError("launch_closed", "window closed", 409);
        for (const b of l.bids) if (b.status === "sealed") release(l, b, "cancelled");
        returnFee(l);
        l.pub.status = "cancelled";
        return { id: hex16(), status: "executed" };
      }
      default:
        throw new ApiError("bad_request", "op not supported yet", 400);
    }
  }

  function portfolio(network: Network, pubkey: string) {
    const now = Date.now();
    const fairBids: FairBid[] = [];
    const fairLaunches: OwnFairLaunch[] = [];
    const list = [...launches.values()].filter((l) => l.network === network).sort((a, b) => b.pub.publishedAt - a.pub.publishedAt);
    for (const l of list) {
      for (const b of l.bids) {
        if (b.pubkey !== pubkey) continue;
        const showAmount = b.status === "revealed" || b.status === "settled" || (b.status === "released" && b.amountZat > N0);
        fairBids.push({
          launchId: l.pub.id,
          holdZat: b.holdZat.toString(),
          status: b.status,
          ...(showAmount ? { amountZat: b.amountZat.toString() } : {}),
          ...(b.tokenAmount !== undefined ? { tokenAmount: b.tokenAmount.toString() } : {}),
          ...(b.chargedZat !== undefined ? { chargedZat: b.chargedZat.toString() } : {}),
          ...(b.releasedZat !== undefined ? { releasedZat: b.releasedZat.toString() } : {}),
          ...(b.proof && l.pub.status !== "open" ? { proof: structuredClone(b.proof) } : {}),
        });
      }
      if (l.creator === pubkey)
        fairLaunches.push({ launchId: l.pub.id, status: now < l.pub.publishedAt ? "scheduled" : l.pub.status, publishedAt: l.pub.publishedAt, closeAt: l.pub.closeAt });
    }
    return { fairBids: fairBids.slice(0, 20), fairLaunches };
  }

  return { params, tick, get, submit, portfolio };
}
