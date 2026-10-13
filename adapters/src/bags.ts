import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { DynamicBondingCurveIdl } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type Signer,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { verifyDetached } from "./ed25519";
import { AdapterError } from "./errors";
import { slip10DerivePath, type CreatorKeyring } from "./keys";
import { DBC_PROGRAM_ID, dbcCoder, dbcInitEvents, type MeteoraDbcAdapter } from "./meteora";
import { dbcLaunchCurve, type LaunchCurve } from "./relayer/launch-curves";
import { parseMetaplexMetadata } from "./intel/metrics";
import type { JupiterAdapter } from "./jupiter";
import type { CreateResult, PreparedCreate, PreparedTrade } from "./pumpfun";
import { parseMint, validateMeta } from "./pumpfun";
import { fixedPrice, type PriorityPrice } from "./fees";
import { broadcastAndConfirm, fetchTx, signTx, type SignedTx } from "./tx";
import type { CreateOptions, CurveStatus, Quote, TokenMeta, TradeOptions, TxResult } from "./types";

/**
 * Bags (venue "bags", MAINNET ONLY: every Bags program ID is mainnet-beta). Bags launches are
 * Meteora DBC pools under Bags' configs, built by Bags' REST API (docs.bags.fm, OpenAPI 2.0.0,
 * read 13.10); the mint keypair is generated and PRE-SIGNED by Bags' server.
 *
 * Shape of a current launch tx (mainnet 13.10, `5sXtR55X…`, read-only):
 *   ComputeBudget limit + price | DBC initialize_virtual_pool_with_spl_token (creator = payer =
 *   launch wallet, base_mint signs) | DBC transfer_pool_creator (-> Bags `BAGSB9…`) |
 *   System transfer launch wallet -> `BAGSB9…` (20 000 lamports).
 * Everything Bags hands us is checked against that shape (allowlist, like Jupiter builds),
 * simulated (the launch wallet may lose at most a capped amount of SOL and nothing else), and
 * only then signed by the launch wallet.
 *
 * Pool keys / privacy (lead 13.10):
 * - API key: obtained by signing a challenge with a SEPARATE pool key (`BAGS_AUTH_PATH`), never a
 *   vault or creator (scripts/bags-auth.ts; the owner runs the registration step).
 * - launch wallet = a fresh HD creator (it must sign AND pay). It is funded IN ADVANCE, in round
 *   amounts, by a separate funder key (`BAGS_FUNDER_PATH`), never by a vault and never at launch
 *   time (`BagsCreatorFunder`). The vault does not appear in the launch tx at all.
 * - first buy: NOT in Bags' tx (its buy would be the creator's and the tokens would sit on the
 *   creator): create jobs must carry lamports_in = 0; the first buy is a normal `buy` job of a
 *   vault on the pool (non-atomic: a sniper can buy first).
 * - buy / sell: on the DBC pool through our DBC adapter (pool found by base mint), or Jupiter once
 *   the pool graduated (Bags' trade API adds a Bags treasury fee and sees our trades: not used).
 * - What Bags sees: our server IP and API key, metadata and the time of each launch before it is
 *   public, the launch wallet. Nothing about users.
 */

export const BAGS_API_BASE = "https://public-api-v2.bags.fm/api/v1";
/** Bags' fee wallet: new pool creator after `transfer_pool_creator`, receiver of the launch fee. */
export const BAGS_FEE_WALLET = new PublicKey("BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv");
export const BAGS_FEE_SHARE_V2 = new PublicKey("FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK");
/** API auth key and launch-wallet funder: own HD branches of the creator master seed (never vaults/creators). */
export const BAGS_AUTH_PATH = [44, 501, 0x7ffffffd, 5] as const;
export const BAGS_FUNDER_PATH = [44, 501, 0x7ffffffd, 6] as const;
/**
 * Bags' shared DBC config of current launches (mainnet 13.10, `ArBv9x…`): the curve written to
 * `launch_curves` (venue bags) so core can bound the first buy. BAGS_CURVE_CONFIG overrides; a
 * launch Bags puts under ANOTHER config is refused (core's min_out would be for the wrong curve).
 */
export const BAGS_CURVE_CONFIG = new PublicKey("ArBv9xEPQsqeKpKiGc6HqJmDT3hKzhLKQvjkHk8ZMbiQ");

/** Default config type: 1 % pre-migration fee, 0.25 % after (docs: `a7c8e1f2…`); BAGS_CONFIG_TYPE overrides. */
export const BAGS_DEFAULT_CONFIG_TYPE = "a7c8e1f2-3d4b-5a6c-9e0f-1b2c3d4e5f6a";

export function deriveBagsAuthKeypair(seed: Uint8Array): Keypair {
  return Keypair.fromSeed(slip10DerivePath(seed, BAGS_AUTH_PATH));
}
export function deriveBagsFunderKeypair(seed: Uint8Array): Keypair {
  return Keypair.fromSeed(slip10DerivePath(seed, BAGS_FUNDER_PATH));
}

// ---------------------------------------------------------------------------
// REST client (no SDK: @bagsfm/bags-sdk 1.4.4 pins an older DBC SDK and axios)
// ---------------------------------------------------------------------------

export interface BagsTxWithBlockhash {
  transaction: string; // base58 serialized VersionedTransaction
  blockhash: { blockhash: string; lastValidBlockHeight: number };
}

export class BagsApi {
  constructor(
    private readonly apiKey: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = BAGS_API_BASE,
    private readonly timeoutMs = 20_000,
  ) {}

  private async call<T>(method: "GET" | "POST", p: string, body?: unknown, form?: FormData, auth = true): Promise<T> {
    if (auth && !this.apiKey) throw new AdapterError("venue_unavailable", "BAGS_API_KEY not set");
    const headers: Record<string, string> = {};
    if (auth) headers["x-api-key"] = this.apiKey!;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${p}`, {
        method,
        headers,
        ...(form ? { body: form } : body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new AdapterError("venue_unavailable", `bags api unreachable (${p})`, { cause: e });
    }
    const j = (await res.json().catch(() => null)) as { success?: boolean; response?: unknown; error?: unknown } | null;
    if (!res.ok || !j || j.success !== true) {
      const why = typeof j?.error === "string" ? j.error : typeof j?.response === "string" ? j.response : `HTTP ${res.status}`;
      throw new AdapterError(res.status === 400 ? "bad_request" : "venue_unavailable", `bags api ${p}: ${String(why).replace(/[1-9A-HJ-NP-Za-km-z]{32,88}/g, "<addr>").slice(0, 160)}`);
    }
    return j.response as T;
  }

  /** Agent auth step 1 (no key): challenge for `address`. */
  authInit(address: string): Promise<{ message: string; nonce: string }> {
    return this.call("POST", "/agent/v2/auth/init", { address }, undefined, false);
  }
  /** Agent auth step 2: wallet signature (or MFA) -> API key. CREATES A BAGS ACCOUNT: owner decision. */
  authCallback(b: { signature: string; address: string; nonce: string; keyName: string } | { authCode: string; mfaCode: string; keyName: string }): Promise<{ apiKey?: string; keyId?: string; mfaRequired?: boolean; authCode?: string }> {
    return this.call("POST", "/agent/v2/auth/callback", b, undefined, false);
  }

  createTokenInfo(i: { name: string; symbol: string; description: string; imageUrl: string; metadataUrl?: string; website?: string }): Promise<{ tokenMint: string; tokenMetadata: string }> {
    const f = new FormData();
    f.set("name", i.name);
    f.set("symbol", i.symbol);
    f.set("description", i.description);
    f.set("imageUrl", i.imageUrl);
    if (i.metadataUrl) f.set("metadataUrl", i.metadataUrl);
    if (i.website) f.set("website", i.website);
    return this.call("POST", "/token-launch/create-token-info", undefined, f);
  }

  feeShareConfig(b: { payer: string; baseMint: string; claimersArray: string[]; basisPointsArray: number[]; bagsConfigType: string }): Promise<{
    needsCreation: boolean;
    feeShareAuthority: string;
    meteoraConfigKey: string;
    transactions?: BagsTxWithBlockhash[] | null;
    bundles?: BagsTxWithBlockhash[][] | null;
  }> {
    return this.call("POST", "/fee-share/config", { ...b, enableFirstSwapWithMinFee: false });
  }

  /** Base58 VersionedTransaction, already signed by the mint. */
  createLaunchTransaction(b: { ipfs: string; tokenMint: string; wallet: string; initialBuyLamports: number; configKey: string }): Promise<string> {
    return this.call("POST", "/token-launch/create-launch-transaction", b);
  }
}

// ---------------------------------------------------------------------------
// allowlist (pure)
// ---------------------------------------------------------------------------

const DBC_IX = new Map(
  (DynamicBondingCurveIdl.instructions as ReadonlyArray<{ name: string; discriminator: number[]; accounts: { name: string }[] }>).map((i) => [Buffer.from(i.discriminator).toString("hex"), i]),
);
const SYSTEM_TRANSFER = 2;

export interface BagsCheckLimits {
  /** Max lamports the launch wallet may send to Bags' fee wallet in one tx (observed 20 000). */
  maxFeeLamports: bigint;
  /** Max priority fee (limit x price) Bags may set, lamports. */
  maxPriorityLamports: bigint;
}
export const DEFAULT_BAGS_LIMITS: BagsCheckLimits = { maxFeeLamports: 1_000_000n, maxPriorityLamports: 2_000_000n };

interface DecodedIx {
  program: PublicKey;
  data: Buffer;
  keys: { pubkey: PublicKey; signer: boolean; writable: boolean }[];
}

/** Instructions of a v0 / legacy tx with its lookup tables resolved. */
export function decodeIxs(tx: VersionedTransaction, alts: readonly AddressLookupTableAccount[]): DecodedIx[] {
  const m = tx.message;
  const keys = m.getAccountKeys({ addressLookupTableAccounts: [...alts] });
  return m.compiledInstructions.map((ix) => ({
    program: keys.get(ix.programIdIndex)!,
    data: Buffer.from(ix.data),
    keys: ix.accountKeyIndexes.map((k) => ({ pubkey: keys.get(k)!, signer: m.isAccountSigner(k), writable: m.isAccountWritable(k) })),
  }));
}

function refuse(why: string): AdapterError {
  return new AdapterError("venue_unavailable", `bags tx refused: ${why}`);
}

function checkComputeBudget(ixs: DecodedIx[], limits: BagsCheckLimits): void {
  let limit = 200_000n;
  let price = 0n;
  for (const i of ixs) {
    if (!i.program.equals(ComputeBudgetProgram.programId)) continue;
    // A readonly, non-signer marker account on a compute-budget ix is harmless (seen on Bags txs).
    if (i.keys.some((k) => k.signer || k.writable)) throw refuse("compute budget accounts");
    if (i.data[0] === 2 && i.data.length === 5) limit = BigInt(i.data.readUInt32LE(1));
    else if (i.data[0] === 3 && i.data.length === 9) price = i.data.readBigUInt64LE(1);
    else throw refuse("compute budget instruction");
  }
  if ((limit * price) / 1_000_000n > limits.maxPriorityLamports) throw refuse("priority fee above cap");
}

function checkSigners(tx: VersionedTransaction, allowed: readonly PublicKey[]): PublicKey[] {
  const m = tx.message;
  const signers = m.staticAccountKeys.slice(0, m.header.numRequiredSignatures);
  for (const s of signers) if (!allowed.some((a) => a.equals(s))) throw refuse(`foreign signer`);
  return signers;
}

function checkFeeTransfer(i: DecodedIx, from: PublicKey, limits: BagsCheckLimits): void {
  if (i.data.length !== 12 || i.data.readUInt32LE(0) !== SYSTEM_TRANSFER) throw refuse("system instruction");
  if (!i.keys[0]?.pubkey.equals(from) || !i.keys[1]?.pubkey.equals(BAGS_FEE_WALLET)) throw refuse("system transfer target");
  if (i.data.readBigUInt64LE(4) > limits.maxFeeLamports) throw refuse("bags fee above cap");
}

const acct = (i: DecodedIx, name: string): PublicKey | undefined => {
  const def = DBC_IX.get(i.data.subarray(0, 8).toString("hex"));
  const k = def?.accounts.findIndex((a) => a.name === name) ?? -1;
  return k >= 0 ? i.keys[k]?.pubkey : undefined;
};

/**
 * The launch tx: exactly compute budget, DBC pool init (creator = payer = our launch wallet,
 * base mint = the announced mint, WSOL quote, the announced config), DBC transfer_pool_creator to
 * Bags' fee wallet, and at most a capped fee transfer to it. Signers: launch wallet + the mint,
 * whose signature must already be there and valid. No swap (first buy is ours, separately).
 */
export function checkLaunchTx(tx: VersionedTransaction, alts: readonly AddressLookupTableAccount[], c: { wallet: PublicKey; mint: PublicKey; config: PublicKey }, limits = DEFAULT_BAGS_LIMITS): void {
  const m = tx.message;
  if (!m.staticAccountKeys[0]?.equals(c.wallet)) throw refuse("fee payer is not the launch wallet");
  const signers = checkSigners(tx, [c.wallet, c.mint]);
  if (signers.length !== 2) throw refuse("signers");
  const mi = signers.findIndex((s) => s.equals(c.mint));
  const sig = tx.signatures[mi];
  if (!sig || sig.every((b) => b === 0) || !verifyDetached(c.mint.toBase58(), m.serialize(), bs58.encode(sig))) throw refuse("mint signature missing or invalid");
  const ixs = decodeIxs(tx, alts);
  checkComputeBudget(ixs, limits);
  let init = 0;
  let pool: PublicKey | undefined;
  for (const i of ixs) {
    if (i.program.equals(ComputeBudgetProgram.programId)) continue;
    if (i.program.equals(SystemProgram.programId)) {
      checkFeeTransfer(i, c.wallet, limits);
      continue;
    }
    if (!i.program.equals(DBC_PROGRAM_ID)) throw refuse(`program ${i.program.toBase58().slice(0, 8)}…`);
    const name = DBC_IX.get(i.data.subarray(0, 8).toString("hex"))?.name;
    if (name === "initialize_virtual_pool_with_spl_token" || name === "initialize_virtual_pool_with_token2022") {
      init++;
      if (!acct(i, "creator")?.equals(c.wallet) || !acct(i, "payer")?.equals(c.wallet)) throw refuse("pool creator / payer");
      if (!acct(i, "base_mint")?.equals(c.mint)) throw refuse("base mint");
      if (!acct(i, "quote_mint")?.equals(NATIVE_MINT)) throw refuse("quote mint");
      if (!acct(i, "config")?.equals(c.config)) throw refuse("config");
      pool = acct(i, "pool");
      continue;
    }
    if (name === "transfer_pool_creator") {
      if (!pool || !acct(i, "virtual_pool")?.equals(pool) || !acct(i, "creator")?.equals(c.wallet) || !acct(i, "new_creator")?.equals(BAGS_FEE_WALLET)) throw refuse("transfer_pool_creator");
      continue;
    }
    throw refuse(`dbc instruction ${name ?? "?"}`);
  }
  if (init !== 1) throw refuse("no pool init");
}

/**
 * A fee-share config tx (not seen live: Bags' current launches reuse configs). Only the launch
 * wallet signs and pays; programs: compute budget, System (fee transfer to Bags only), Bags Fee
 * Share V2, DBC config creation. The SOL it may take is capped again by simulation.
 */
export function checkConfigTx(tx: VersionedTransaction, alts: readonly AddressLookupTableAccount[], c: { wallet: PublicKey }, limits = DEFAULT_BAGS_LIMITS): void {
  if (!tx.message.staticAccountKeys[0]?.equals(c.wallet)) throw refuse("fee payer is not the launch wallet");
  checkSigners(tx, [c.wallet]);
  const ixs = decodeIxs(tx, alts);
  checkComputeBudget(ixs, limits);
  for (const i of ixs) {
    if (i.program.equals(ComputeBudgetProgram.programId) || i.program.equals(BAGS_FEE_SHARE_V2)) continue;
    if (i.program.equals(SystemProgram.programId)) {
      checkFeeTransfer(i, c.wallet, limits);
      continue;
    }
    if (i.program.equals(DBC_PROGRAM_ID) && DBC_IX.get(i.data.subarray(0, 8).toString("hex"))?.name === "create_config") continue;
    throw refuse(`program ${i.program.toBase58().slice(0, 8)}…`);
  }
}

// ---------------------------------------------------------------------------
// launch wallets: reserved creator indexes, funded in advance by the funder key
// ---------------------------------------------------------------------------

export interface BagsWallet {
  index: number;
  pubkey: string;
  /** Funding tx (public). */
  fundSig: string;
  used: boolean;
}

/** Reserved launch wallets (public data: creator index, address, funding signature), file in the keys dir. */
export class BagsWalletStore {
  constructor(readonly file: string) {}
  list(): BagsWallet[] {
    if (!fs.existsSync(this.file)) return [];
    return (JSON.parse(fs.readFileSync(this.file, "utf8")) as { wallets: BagsWallet[] }).wallets;
  }
  save(ws: BagsWallet[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ wallets: ws }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  add(w: BagsWallet): void {
    this.save([...this.list(), w]);
  }
  markUsed(index: number): void {
    this.save(this.list().map((w) => (w.index === index ? { ...w, used: true } : w)));
  }
  unused(): BagsWallet[] {
    return this.list().filter((w) => !w.used);
  }
}

/**
 * Funds launch wallets IN ADVANCE from the funder key: each a freshly allocated creator index,
 * one transfer of a fixed round amount per wallet (never batched with others: no extra link
 * between launches), never from a vault. Run on its own schedule (scripts/bags-fund.ts), not at
 * launch time.
 */
export class BagsCreatorFunder {
  constructor(
    private readonly o: {
      connection: Connection;
      funder: Signer;
      creators: CreatorKeyring;
      store: BagsWalletStore;
      /** Round amount per launch wallet, lamports (BAGS_WALLET_FUND_LAMPORTS, default 0.05 SOL). */
      amount: bigint;
      priorityMicroLamports?: number | PriorityPrice;
    },
  ) {}

  /** Tops up to `target` unused funded wallets; returns how many were funded. */
  async ensure(target: number, send: (tx: SignedTx) => Promise<void> = (tx) => broadcastAndConfirm(this.o.connection, tx).then(() => undefined)): Promise<number> {
    let n = 0;
    const p = this.o.priorityMicroLamports ?? 0;
    const price = typeof p === "number" ? fixedPrice(p) : p;
    while (this.o.store.unused().length < target) {
      const bal = BigInt(await this.o.connection.getBalance(this.o.funder.publicKey, "confirmed"));
      if (bal < this.o.amount + 1_000_000n) throw new AdapterError("insufficient_sol", "bags funder is short (fund it, never from a vault)");
      const index = await this.o.creators.allocate();
      const to = this.o.creators.publicKey(index);
      const tx = await signTx(this.o.connection, [SystemProgram.transfer({ fromPubkey: this.o.funder.publicKey, toPubkey: to, lamports: this.o.amount })], this.o.funder, [], {
        computeUnits: 1_000,
        priorityMicroLamports: price.microLamports(),
        tip: null,
      });
      await send(tx);
      this.o.store.add({ index, pubkey: to.toBase58(), fundSig: tx.signature, used: false });
      n++;
    }
    return n;
  }
}

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------

export interface BagsAdapterOptions {
  connection: Connection;
  api: BagsApi;
  creators: CreatorKeyring;
  wallets: BagsWalletStore;
  /** DBC adapter able to find pools by base mint (`findPool: dbcPoolByBaseMint`). */
  dbc: MeteoraDbcAdapter;
  /** Graduated pools (DAMM v2): Jupiter; null = such trades are refused. */
  jupiter: JupiterAdapter | null;
  /** Image URL + description of our published metadata JSON (`meta.uri`). */
  metadataOf: (uri: string) => Promise<{ image: string; description: string }>;
  configType?: string;
  limits?: BagsCheckLimits;
  /** Max lamports a Bags tx may take from the launch wallet (simulated), default 0.04 SOL. */
  maxWalletSpend?: bigint;
  /** The config whose curve is in launch_curves (default BAGS_CURVE_CONFIG). */
  curveConfig?: PublicKey;
}

export class BagsAdapter {
  readonly id = "bags" as const;
  private readonly limits: BagsCheckLimits;
  private readonly maxSpend: bigint;
  constructor(private readonly o: BagsAdapterOptions) {
    this.limits = o.limits ?? DEFAULT_BAGS_LIMITS;
    this.maxSpend = o.maxWalletSpend ?? 40_000_000n;
  }

  // ---- create -------------------------------------------------------------

  async prepareCreate(meta: TokenMeta, initialBuy: bigint, _minOut: bigint, opts: CreateOptions = {}): Promise<PreparedCreate> {
    validateMeta(meta);
    if (initialBuy !== 0n) throw new AdapterError("bad_request", "bags: create carries no first buy (lamports_in = 0; the first buy is a separate buy job)");
    if (opts.quote && opts.quote.toUpperCase() !== "SOL") throw new AdapterError("venue_unavailable", "bags: SOL only");
    if (opts.mintKeypair) throw new AdapterError("bad_request", "fair launch is pump.fun only");
    const w = await this.nextWallet();
    const wallet = this.o.creators.keypair(w.index);
    const md = await this.o.metadataOf(meta.uri).catch(() => null);
    if (!md?.image) throw new AdapterError("venue_unavailable", "bags: metadata image not readable");
    const info = await this.o.api.createTokenInfo({ name: meta.name, symbol: meta.symbol, description: md.description, imageUrl: md.image, metadataUrl: meta.uri });
    const mint = new PublicKey(info.tokenMint);
    const cfg = await this.o.api.feeShareConfig({
      payer: wallet.publicKey.toBase58(),
      baseMint: mint.toBase58(),
      claimersArray: [wallet.publicKey.toBase58()],
      basisPointsArray: [10_000],
      bagsConfigType: this.o.configType ?? BAGS_DEFAULT_CONFIG_TYPE,
    });
    if (cfg.bundles?.length) throw new AdapterError("venue_unavailable", "bags: config needs a Jito bundle (not supported)");
    const curveConfig = this.o.curveConfig ?? BAGS_CURVE_CONFIG;
    if (cfg.meteoraConfigKey !== curveConfig.toBase58()) {
      throw new AdapterError("venue_unavailable", "bags: launch config differs from the curve in launch_curves (set BAGS_CONFIG_TYPE / BAGS_CURVE_CONFIG)");
    }
    // From here the wallet may spend: never hand it to another launch.
    this.o.wallets.markUsed(w.index);
    for (const t of cfg.transactions ?? []) {
      const tx = VersionedTransaction.deserialize(bs58.decode(t.transaction));
      checkConfigTx(tx, await this.alts(tx), { wallet: wallet.publicKey }, this.limits);
      await this.simulateSpend(tx, wallet.publicKey);
      tx.sign([wallet]);
      await broadcastAndConfirm(this.o.connection, { signature: bs58.encode(tx.signatures[0]!), raw: tx.serialize(), blockhash: t.blockhash.blockhash, lastValidBlockHeight: t.blockhash.lastValidBlockHeight });
    }
    const b58 = await this.o.api.createLaunchTransaction({ ipfs: info.tokenMetadata, tokenMint: mint.toBase58(), wallet: wallet.publicKey.toBase58(), initialBuyLamports: 0, configKey: cfg.meteoraConfigKey });
    const tx = VersionedTransaction.deserialize(bs58.decode(b58));
    checkLaunchTx(tx, await this.alts(tx), { wallet: wallet.publicKey, mint, config: new PublicKey(cfg.meteoraConfigKey) }, this.limits);
    await this.simulateSpend(tx, wallet.publicKey);
    tx.sign([wallet]);
    // Bags' blockhash: its last valid height is not returned; over-estimate (a later expiry only delays a retry).
    const height = await this.o.connection.getBlockHeight("confirmed");
    return {
      signature: bs58.encode(tx.signatures[0]!),
      raw: tx.serialize(),
      blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: height + 300,
      kind: "create",
      mint: mint.toBase58(),
      vault: (opts.vault ?? null)?.publicKey.toBase58() ?? wallet.publicKey.toBase58(),
      creator: wallet.publicKey.toBase58(),
      creatorIndex: w.index,
      expectedOut: 0n,
    };
  }

  /** Plain RPC send: the Sender path needs our tip in the tx, Bags' tx cannot carry it. */
  async submit(tx: SignedTx): Promise<{ signature: string; slot: number }> {
    try {
      return await broadcastAndConfirm(this.o.connection, tx);
    } catch (e) {
      throw this.classify(e);
    }
  }

  async createResult(signature: string, vault: string): Promise<CreateResult | null> {
    const tx = await fetchTx(this.o.connection, signature, 10).catch(() => null);
    if (!tx) return null;
    const init = dbcInitEvents(tx)[0];
    if (!init) return null;
    const [md, mintAcc] = await this.o.connection.getMultipleAccountsInfo([metadataPda(init.baseMint), init.baseMint], "confirmed").catch(() => [null, null]);
    const m = md ? parseMetaplexMetadata(md.data) : null;
    if (!m || !mintAcc || mintAcc.data.length < 45) return null;
    return {
      venue: this.id,
      kind: "create",
      signature,
      slot: tx.slot,
      mint: init.baseMint.toBase58(),
      vault,
      creator: init.creator.toBase58(),
      name: m.name,
      symbol: m.symbol,
      uri: m.uri,
      tokenProgram: mintAcc.owner.toBase58(),
      tokenAmount: 0n,
      solAmount: 0n,
      networkFee: BigInt(tx.meta?.fee ?? 0),
      blockTime: tx.blockTime ?? null,
      decimals: mintAcc.data.readUInt8(44),
      amountsKnown: true,
      fromEvent: true,
      creatorFee: 0n,
    };
  }

  // ---- trading: DBC pool, Jupiter after graduation -----------------------

  private async either<T>(dbc: () => Promise<T>, jup: (() => Promise<T>) | null): Promise<T> {
    try {
      return await dbc();
    } catch (e) {
      if (e instanceof AdapterError && e.code === "graduated" && jup && this.o.jupiter) return jup();
      throw e;
    }
  }

  prepareBuy(mint: string, lamportsIn: bigint, minOut: bigint, opts: TradeOptions = {}): Promise<PreparedTrade> {
    return this.either(() => this.o.dbc.prepareBuy(mint, lamportsIn, minOut, opts), () => this.o.jupiter!.prepareBuy(mint, lamportsIn, minOut, opts));
  }
  prepareSell(mint: string, amount: bigint, minLamports: bigint, opts: TradeOptions = {}): Promise<PreparedTrade> {
    return this.either(() => this.o.dbc.prepareSell(mint, amount, minLamports, opts), () => this.o.jupiter!.prepareSell(mint, amount, minLamports, opts));
  }
  async tradeResult(kind: "buy" | "sell", signature: string, vault: string, mint: string): Promise<TxResult | null> {
    const r = await this.o.dbc.tradeResult(kind, signature, vault, mint).catch(() => null);
    if (r?.fromEvent) return { ...r, venue: this.id };
    const j = this.o.jupiter ? await this.o.jupiter.tradeResult(kind, signature, vault, mint).catch(() => null) : null;
    return j ? { ...j, venue: this.id } : r ? { ...r, venue: this.id } : null;
  }
  quote(mint: string, side: "buy" | "sell", amount: bigint): Promise<Quote> {
    return this.o.dbc.quote(mint, side, amount).then((q) => ({ ...q, venue: this.id }));
  }
  market(mint: string): Promise<{ priceSol: string; marketCapSol: string; status: CurveStatus }> {
    return this.either(() => this.o.dbc.market(mint), () => this.o.jupiter!.market(mint));
  }
  status(mint: string): Promise<CurveStatus> {
    return this.o.dbc.status(mint);
  }
  tokenSymbol(mint: string): Promise<string | null> {
    return this.o.dbc.tokenSymbol(mint);
  }
  classify(err: unknown, logs: readonly string[] | null = null): AdapterError {
    return this.o.dbc.classify(err, logs);
  }

  // ---- internals ----------------------------------------------------------

  private async nextWallet(): Promise<BagsWallet> {
    for (const w of this.o.wallets.unused()) {
      if (this.o.creators.publicKey(w.index).toBase58() !== w.pubkey) continue; // never trust the file over the seed
      const bal = BigInt(await this.o.connection.getBalance(new PublicKey(w.pubkey), "confirmed"));
      if (bal >= this.maxSpend) return w;
    }
    throw new AdapterError("insufficient_sol", "bags: no funded launch wallet (run the funder: pnpm bags:fund)");
  }

  private async alts(tx: VersionedTransaction): Promise<AddressLookupTableAccount[]> {
    const out: AddressLookupTableAccount[] = [];
    for (const l of tx.message.addressTableLookups) {
      const r = await this.o.connection.getAddressLookupTable(l.accountKey, { commitment: "confirmed" });
      if (!r.value) throw refuse("lookup table not found");
      out.push(r.value);
    }
    return out;
  }

  /** The launch wallet may lose at most `maxWalletSpend` lamports in this tx (simulated, nothing sent). */
  private async simulateSpend(tx: VersionedTransaction, wallet: PublicKey): Promise<void> {
    const pre = BigInt(await this.o.connection.getBalance(wallet, "confirmed"));
    const r = await this.o.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [wallet.toBase58()] } });
    if (r.value.err) throw new AdapterError("venue_unavailable", `bags tx simulation failed: ${JSON.stringify(r.value.err).slice(0, 120)}`);
    const post = BigInt(r.value.accounts?.[0]?.lamports ?? 0);
    if (pre - post > this.maxSpend) throw refuse(`launch wallet would spend ${pre - post} lamports`);
  }
}

function metadataPda(mint: PublicKey): PublicKey {
  const META = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), META.toBuffer(), mint.toBuffer()], META)[0];
}

export type { VersionedTransactionResponse };

/** launch_curves row of Bags: the shared config's curve (read-only RPC). */
export async function bagsLaunchCurve(connection: Pick<Connection, "getAccountInfo">, config: PublicKey = BAGS_CURVE_CONFIG): Promise<LaunchCurve> {
  const acc = await connection.getAccountInfo(config, "confirmed");
  if (!acc || !acc.owner.equals(DBC_PROGRAM_ID)) throw new Error("bags curve config not found");
  const c = dbcCoder().accounts.decode("poolConfig", acc.data) as Parameters<typeof dbcLaunchCurve>[1] & { quoteMint: PublicKey };
  if (!c.quoteMint.equals(NATIVE_MINT)) throw new Error("bags curve config is not SOL-quoted");
  return dbcLaunchCurve("bags", c);
}
