import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bs58 from "bs58";
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, type Signer } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  BAGS_FEE_WALLET,
  BagsAdapter,
  BagsApi,
  BagsCreatorFunder,
  BagsWalletStore,
  checkConfigTx,
  checkLaunchTx,
  deriveBagsAuthKeypair,
  deriveBagsFunderKeypair,
} from "../src/bags";
import { AdapterError } from "../src/errors";
import { CreatorKeyring, MemoryCreatorIndexCounter, deriveCreatorKeypair } from "../src/keys";
import { DBC_PROGRAM_ID, MeteoraDbcAdapter, dbcPoolByBaseMint } from "../src/meteora";
import { deriveRebalanceKeypair } from "../src/rebalance";
import { FakeRpc } from "./rpc-fake";

/*
 * Bags (mainnet only). Real launch tx of 13.10 (`5sXtR55X…`, read-only RPC), its lookup table and
 * the pool it created (bags-launch-mainnet.json, bags-pool-mainnet.json). The Bags API is mocked.
 */
const LAUNCH = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "bags-launch-mainnet.json"), "utf8")) as {
  signature: string; raw: string; wallet: string; mint: string; config: string; lut: { key: string; data: string };
};
const POOL = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "bags-pool-mainnet.json"), "utf8")) as { pool: string; data: string; config: string; configData: string; mint: string };
const LUT = new AddressLookupTableAccount({ key: new PublicKey(LAUNCH.lut.key), state: AddressLookupTableAccount.deserialize(Buffer.from(LAUNCH.lut.data, "base64")) });
const REAL = () => VersionedTransaction.deserialize(Buffer.from(LAUNCH.raw, "base64"));
const C = { wallet: new PublicKey(LAUNCH.wallet), mint: new PublicKey(LAUNCH.mint), config: new PublicKey(LAUNCH.config) };

/** The real launch, re-keyed to our test wallet + a test mint (same instructions), mint-signed. */
function synthetic(o: { wallet: PublicKey; mint?: Keypair; edit?: (ixs: TransactionInstruction[]) => TransactionInstruction[]; extraSigner?: Keypair }) {
  const mint = o.mint ?? Keypair.generate();
  const real = REAL();
  const msg = TransactionMessage.decompile(real.message, { addressLookupTableAccounts: [LUT] });
  const swap = (k: PublicKey) => (k.equals(C.wallet) ? o.wallet : k.equals(C.mint) ? mint.publicKey : k);
  let ixs = msg.instructions.map((i) => new TransactionInstruction({ programId: i.programId, data: i.data, keys: i.keys.map((k) => ({ ...k, pubkey: swap(k.pubkey) })) }));
  if (o.edit) ixs = o.edit(ixs);
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: o.wallet, recentBlockhash: msg.recentBlockhash, instructions: ixs }).compileToV0Message([LUT]));
  tx.sign([mint, ...(o.extraSigner ? [o.extraSigner] : [])]);
  return { tx, mint };
}

describe("Bags launch tx allowlist", () => {
  it("accepts the real mainnet launch (13.10) as Bags built it", () => {
    expect(() => checkLaunchTx(REAL(), [LUT], C)).not.toThrow();
  });
  it("refuses it for another config, mint or wallet", () => {
    expect(() => checkLaunchTx(REAL(), [LUT], { ...C, config: Keypair.generate().publicKey })).toThrow(/config/);
    expect(() => checkLaunchTx(REAL(), [LUT], { ...C, mint: Keypair.generate().publicKey })).toThrow(/foreign signer/);
    expect(() => checkLaunchTx(REAL(), [LUT], { ...C, wallet: Keypair.generate().publicKey })).toThrow(/fee payer/);
  });
  it("re-keyed to our wallet: accepted; a tampered message breaks the mint signature", () => {
    const w = Keypair.generate().publicKey;
    const { tx, mint } = synthetic({ wallet: w });
    expect(() => checkLaunchTx(tx, [LUT], { wallet: w, mint: mint.publicKey, config: C.config })).not.toThrow();
    tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58(); // message changed after the mint signed
    expect(() => checkLaunchTx(tx, [LUT], { wallet: w, mint: mint.publicKey, config: C.config })).toThrow(/mint signature/);
  });
  const variant = (edit: (ixs: TransactionInstruction[], w: PublicKey) => TransactionInstruction[], extraSigner?: Keypair) => {
    const w = Keypair.generate().publicKey;
    const { tx, mint } = synthetic({ wallet: w, edit: (ixs) => edit(ixs, w), ...(extraSigner ? { extraSigner } : {}) });
    return () => checkLaunchTx(tx, [LUT], { wallet: w, mint: mint.publicKey, config: C.config });
  };
  it("refuses: SOL to anyone but Bags' fee wallet, a fee above the cap, any other program, a swap, a third signer, a priority above the cap", () => {
    const thief = Keypair.generate().publicKey;
    expect(variant((ixs, w) => [...ixs, SystemProgram.transfer({ fromPubkey: w, toPubkey: thief, lamports: 1 })])).toThrow(/transfer target/);
    expect(variant((ixs, w) => [...ixs, SystemProgram.transfer({ fromPubkey: w, toPubkey: BAGS_FEE_WALLET, lamports: 50_000_000 })])).toThrow(/fee above cap/);
    expect(variant((ixs) => [...ixs, new TransactionInstruction({ programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), keys: [], data: Buffer.from([3]) })])).toThrow(/program/);
    const swapDisc = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
    expect(variant((ixs) => [...ixs, new TransactionInstruction({ programId: DBC_PROGRAM_ID, keys: [], data: swapDisc })])).toThrow(/dbc instruction/);
    const third = Keypair.generate();
    expect(variant((ixs) => [...ixs, new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [{ pubkey: third.publicKey, isSigner: true, isWritable: false }], data: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0]) })], third)).toThrow(/foreign signer/);
    expect(variant((ixs) => [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000_000 }), ...ixs.filter((i) => !(i.programId.equals(ComputeBudgetProgram.programId) && i.data[0] === 3))])).toThrow(/priority/);
  });
  it("config tx: only the wallet signs; Fee Share V2 / compute budget / capped fee only", () => {
    const w = Keypair.generate();
    const mk = (ixs: TransactionInstruction[]) => {
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: w.publicKey, recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", instructions: ixs }).compileToV0Message());
      return () => checkConfigTx(tx, [], { wallet: w.publicKey });
    };
    const fee2 = new TransactionInstruction({ programId: new PublicKey("FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK"), keys: [{ pubkey: w.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(8) });
    expect(mk([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), fee2])).not.toThrow();
    expect(mk([fee2, SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })])).toThrow(/transfer target/);
    expect(mk([fee2, new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(1) })])).toThrow(/program/);
  });
});

describe("Bags keys", () => {
  it("auth key and funder: own HD branches, distinct from vaults' rebalance / creators", () => {
    const seed = new Uint8Array(64).fill(5);
    const keys = [deriveBagsAuthKeypair(seed), deriveBagsFunderKeypair(seed), deriveRebalanceKeypair(seed), deriveCreatorKeypair(seed, 0), deriveCreatorKeypair(seed, 1)].map((k) => k.publicKey.toBase58());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// API (mocked) + create flow
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockApi(routes: Record<string, (body: unknown) => unknown>) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const p = url.replace("https://public-api-v2.bags.fm/api/v1", "");
    const body = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init?.method), path: p, headers: (init?.headers ?? {}) as Record<string, string>, body });
    const h = routes[p];
    if (!h) return new Response(JSON.stringify({ success: false, error: "not found" }), { status: 404 });
    const r = h(body);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify({ success: true, response: r }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

function setup(o: { spend?: number; bundles?: boolean; fund?: number } = {}) {
  const seed = new Uint8Array(64).fill(3);
  const creators = new CreatorKeyring(seed, new MemoryCreatorIndexCounter(1));
  const wallet = deriveCreatorKeypair(seed, 0);
  const store = new BagsWalletStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bags-")), "bags-wallets.json"));
  store.add({ index: 0, pubkey: wallet.publicKey.toBase58(), fundSig: "fund0", used: false });
  const rpc = new FakeRpc();
  rpc.balances.set(wallet.publicKey.toBase58(), o.fund ?? 50_000_000);
  rpc.set(LUT.key, { owner: "AddressLookupTab1e1111111111111111111111111", lamports: 1, data: LAUNCH.lut.data });
  rpc.simulate = () => ({ err: null, logs: [], accounts: [{ lamports: (o.fund ?? 50_000_000) - (o.spend ?? 20_000) }] });
  const mint = Keypair.generate();
  const { tx } = synthetic({ wallet: wallet.publicKey, mint });
  const { f, calls } = mockApi({
    "/token-launch/create-token-info": () => ({ tokenMint: mint.publicKey.toBase58(), tokenMetadata: "https://ipfs.io/ipfs/bafkreimeta", tokenLaunch: {} }),
    "/fee-share/config": () => ({ needsCreation: false, feeShareAuthority: Keypair.generate().publicKey.toBase58(), meteoraConfigKey: C.config.toBase58(), transactions: [], bundles: o.bundles ? [[{ transaction: "x", blockhash: { blockhash: "x", lastValidBlockHeight: 1 } }]] : null }),
    "/token-launch/create-launch-transaction": () => bs58.encode(tx.serialize()),
  });
  const dbc = {} as MeteoraDbcAdapter;
  const a = new BagsAdapter({
    connection: rpc.connection(),
    api: new BagsApi("test-key", f),
    creators,
    wallets: store,
    dbc,
    jupiter: null,
    metadataOf: async () => ({ image: "https://media.example/i.png", description: "d" }),
  });
  return { a, calls, store, wallet, mint, rpc };
}

const META = { name: "Unzeen", symbol: "UNZ", uri: "https://media.example/media/m.json" };

describe("BagsAdapter.prepareCreate (API mocked)", () => {
  it("token info -> fee share (wallet 100 %) -> launch tx checked, simulated, signed by the launch wallet; no first buy", async () => {
    const { a, calls, store, wallet, mint } = setup();
    const p = await a.prepareCreate(META, 0n, 0n);
    expect(calls.map((c) => c.path)).toEqual(["/token-launch/create-token-info", "/fee-share/config", "/token-launch/create-launch-transaction"]);
    expect(calls.every((c) => c.headers["x-api-key"] === "test-key")).toBe(true);
    expect(calls[0]!.body).toMatchObject({ name: "Unzeen", symbol: "UNZ", imageUrl: "https://media.example/i.png", metadataUrl: META.uri });
    expect(calls[1]!.body).toMatchObject({ payer: wallet.publicKey.toBase58(), baseMint: mint.publicKey.toBase58(), claimersArray: [wallet.publicKey.toBase58()], basisPointsArray: [10_000] });
    expect(calls[2]!.body).toMatchObject({ wallet: wallet.publicKey.toBase58(), initialBuyLamports: 0, configKey: C.config.toBase58() });
    expect(p).toMatchObject({ kind: "create", mint: mint.publicKey.toBase58(), creator: wallet.publicKey.toBase58(), creatorIndex: 0, expectedOut: 0n });
    const tx = VersionedTransaction.deserialize(p.raw);
    expect(tx.signatures.every((s) => s.some((b) => b !== 0))).toBe(true); // wallet + mint
    expect(bs58.encode(tx.signatures[0]!)).toBe(p.signature);
    expect(store.unused()).toHaveLength(0); // the wallet is never reused
  });
  it("refusals: a first buy, no funded wallet, Jito bundles, spending above the cap", async () => {
    await expect(setup().a.prepareCreate(META, 1n, 0n)).rejects.toMatchObject({ code: "bad_request" });
    await expect(setup({ fund: 1_000 }).a.prepareCreate(META, 0n, 0n)).rejects.toMatchObject({ code: "insufficient_sol" });
    const b = setup({ bundles: true });
    await expect(b.a.prepareCreate(META, 0n, 0n)).rejects.toMatchObject({ code: "venue_unavailable" });
    expect(b.store.unused()).toHaveLength(1); // nothing was signed: the wallet stays available
    await expect(setup({ spend: 45_000_000 }).a.prepareCreate(META, 0n, 0n)).rejects.toThrow(/would spend/);
  });
  it("API errors become adapter errors without addresses; auth init needs no key", async () => {
    const { f, calls } = mockApi({
      "/agent/v2/auth/init": () => ({ message: "abc", nonce: "n" }),
      "/token-launch/create-token-info": () => new Response(JSON.stringify({ success: false, error: `bad mint ${Keypair.generate().publicKey.toBase58()}` }), { status: 400 }),
    });
    const api = new BagsApi(null, f);
    expect(await api.authInit("addr")).toEqual({ message: "abc", nonce: "n" });
    expect(calls[0]!.headers["x-api-key"]).toBeUndefined();
    await expect(api.createTokenInfo({ name: "n", symbol: "s", description: "", imageUrl: "u" })).rejects.toMatchObject({ code: "venue_unavailable" }); // no key: refused locally
    const keyed = new BagsApi("k", f);
    const e = (await keyed.createTokenInfo({ name: "n", symbol: "s", description: "", imageUrl: "u" }).catch((x) => x)) as AdapterError;
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain("<addr>");
  });
});

describe("launch wallets funded in advance by the funder", () => {
  it("one round transfer per fresh creator index, from the funder only; stops when enough are funded", async () => {
    const seed = new Uint8Array(64).fill(8);
    const creators = new CreatorKeyring(seed, new MemoryCreatorIndexCounter(5));
    const funder = deriveBagsFunderKeypair(seed);
    const rpc = new FakeRpc();
    rpc.balances.set(funder.publicKey.toBase58(), 1_000_000_000);
    const store = new BagsWalletStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bags-")), "w.json"));
    const sent: VersionedTransaction[] = [];
    const fu = new BagsCreatorFunder({ connection: rpc.connection(), funder, creators, store, amount: 50_000_000n });
    expect(await fu.ensure(3, async (t) => void sent.push(VersionedTransaction.deserialize(t.raw)))).toBe(3);
    expect(await fu.ensure(3, async () => undefined)).toBe(0);
    expect(store.list().map((w) => w.index)).toEqual([5, 6, 7]);
    for (const [i, tx] of sent.entries()) {
      const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
      expect(signers.map((k) => k.toBase58())).toEqual([funder.publicKey.toBase58()]);
      const tr = tx.message.compiledInstructions.filter((c) => tx.message.staticAccountKeys[c.programIdIndex]!.equals(SystemProgram.programId));
      expect(tr).toHaveLength(1);
      expect(Buffer.from(tr[0]!.data).readBigUInt64LE(4)).toBe(50_000_000n);
      expect(tx.message.staticAccountKeys[tr[0]!.accountKeyIndexes[1]!]!.equals(creators.publicKey(5 + i))).toBe(true);
    }
    rpc.balances.set(funder.publicKey.toBase58(), 10_000);
    await expect(fu.ensure(4, async () => undefined)).rejects.toMatchObject({ code: "insufficient_sol" });
  });
});

describe("Bags pools through the DBC adapter (pool by base mint)", () => {
  it("finds the real Bags pool under Bags' config; graduated -> Jupiter", async () => {
    const rpc = new FakeRpc();
    rpc.set(new PublicKey(POOL.pool), { owner: DBC_PROGRAM_ID.toBase58(), lamports: 1, data: POOL.data });
    rpc.set(new PublicKey(POOL.config), { owner: DBC_PROGRAM_ID.toBase58(), lamports: 1, data: POOL.configData });
    const md = Buffer.alloc(82);
    md.writeUInt8(9, 44);
    md.writeUInt8(1, 45);
    rpc.set(new PublicKey(POOL.mint), { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", lamports: 1, data: md.toString("base64") });
    const find = dbcPoolByBaseMint(rpc.connection());
    expect((await find(new PublicKey(POOL.mint)))!.config.toBase58()).toBe(POOL.config);
    expect(await find(Keypair.generate().publicKey)).toBeNull();
    const dbc = new MeteoraDbcAdapter({ connection: rpc.connection(), config: Keypair.generate().publicKey, defaultVault: Keypair.generate(), creators: new CreatorKeyring(Buffer.alloc(64, 1), new MemoryCreatorIndexCounter()), stateDir: os.tmpdir(), findPool: find });
    await expect(dbc.quote(POOL.mint, "buy", 100_000_000n)).rejects.toMatchObject({ code: "graduated" }); // filled to 10 SOL and migrated
    let jup = 0;
    const a = new BagsAdapter({
      connection: rpc.connection(), api: new BagsApi("k"), creators: new CreatorKeyring(Buffer.alloc(64, 1), new MemoryCreatorIndexCounter()), wallets: new BagsWalletStore(path.join(os.tmpdir(), "none.json")), dbc,
      jupiter: { prepareBuy: async () => { jup++; return { kind: "buy" } as never; } } as never,
      metadataOf: async () => ({ image: "", description: "" }),
    });
    await a.prepareBuy(POOL.mint, 1n, 1n);
    expect(jup).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RELAYER v10: launch_curves row (bags) and the vault pinned at create
// ---------------------------------------------------------------------------

import { dbcCoder } from "../src/meteora";
import { bagsLaunchCurve, BAGS_CURVE_CONFIG } from "../src/bags";
import { dbcLaunchCurve } from "../src/relayer/launch-curves";
import { Relayer } from "../src/relayer/engine";
import { VenueTradeExecutor, type TradeVenue } from "../src/relayer/executors";
import { InMemoryJobQueue } from "../src/relayer/memory-queue";
import { MemoryMintVaults } from "../src/relayer/mint-vaults";
import { seededRng } from "../src/relayer/random";
import { VaultPool } from "../src/relayer/vaults";
import { FakeChain, FakeInventory, vaults as makeVaults } from "./relayer/fakes";

describe("launch_curves row for Bags (shared config ArBv9x…, mainnet 13.10)", () => {
  const cfg = dbcCoder().accounts.decode("poolConfig", Buffer.from(POOL.configData, "base64")) as Parameters<typeof dbcLaunchCurve>[1] & { migrationQuoteThreshold: { toString(): string }; migrationSqrtPrice: { toString(): string } };
  it("constant product of the live segment; buying the migration threshold sells ~the curve's tokens", () => {
    expect(POOL.config).toBe(BAGS_CURVE_CONFIG.toBase58());
    const c = dbcLaunchCurve("bags", cfg);
    expect(c).toMatchObject({ venue: "bags", realTokenReserves: 2_170_982_157_253n, tokenTotalSupply: 1_000_000_000_000_000n });
    // independent check 1: x*y=k bought with the migration threshold (10 SOL) -> swapBaseAmount
    const q = BigInt(cfg.migrationQuoteThreshold.toString());
    const out = c.virtualTokenReserves - (c.virtualSolLamports * c.virtualTokenReserves) / (c.virtualSolLamports + q);
    expect(Number(out) / Number(c.realTokenReserves)).toBeGreaterThan(0.99);
    expect(Number(out) / Number(c.realTokenReserves)).toBeLessThan(1.01);
    // independent check 2: the price after it = the config's migration price
    const endPrice = Number(c.virtualSolLamports + q) / Number(c.virtualTokenReserves - out);
    const mig = Number(BigInt(cfg.migrationSqrtPrice.toString())) / 2 ** 64;
    expect(endPrice / (mig * mig)).toBeGreaterThan(0.98);
    expect(endPrice / (mig * mig)).toBeLessThan(1.02);
  });
  it("read from chain (RPC fake); a non-DBC account is refused", async () => {
    const rpc = new FakeRpc();
    rpc.set(BAGS_CURVE_CONFIG, { owner: DBC_PROGRAM_ID.toBase58(), lamports: 1, data: POOL.configData });
    expect((await bagsLaunchCurve(rpc.connection())).venue).toBe("bags");
    await expect(bagsLaunchCurve(new FakeRpc().connection())).rejects.toThrow(/not found/);
  });
  it("a Bags launch under another config is refused before anything is signed", async () => {
    const s = setup();
    const a = new BagsAdapter({ ...(s.a as unknown as { o: ConstructorParameters<typeof BagsAdapter>[0] }).o, curveConfig: Keypair.generate().publicKey });
    await expect(a.prepareCreate(META, 0n, 0n)).rejects.toThrow(/launch_curves/);
    expect(s.store.unused()).toHaveLength(1);
  });
});

describe("Bags create pins the mint to the job's vault (RELAYER v10 §2)", () => {
  it("the engine pins out_mint -> leased vault (not the launch wallet); the later buy is held there", async () => {
    const inv = new FakeInventory();
    const vs = makeVaults(3, inv);
    const mintVaults = new MemoryMintVaults();
    const chain = new FakeChain();
    const newMint = Keypair.generate().publicKey.toBase58();
    const wallet = Keypair.generate().publicKey.toBase58();
    let vaultSeen = "";
    const venue = {
      prepareCreate: async (_m: unknown, lamports: bigint, _min: bigint, opts: { vault?: Signer }) => {
        expect(lamports).toBe(0n);
        vaultSeen = opts.vault!.publicKey.toBase58();
        return { signature: "sigB", raw: new Uint8Array([1]), blockhash: "b", lastValidBlockHeight: chain.height + 100, kind: "create", mint: newMint, vault: vaultSeen, creator: wallet, creatorIndex: 0, expectedOut: 0n };
      },
      submit: async () => undefined,
      createResult: async () => ({ venue: "bags", kind: "create", signature: "sigB", slot: 1, mint: newMint, vault: vaultSeen, creator: wallet, name: "N", symbol: "S", uri: "u", tokenProgram: "T", tokenAmount: 0n, solAmount: 0n, networkFee: 5_000n, decimals: 6, amountsKnown: true, creatorFee: 0n }),
      market: async () => ({ priceSol: "0", marketCapSol: "0", status: "curve" }),
      tokenSymbol: async () => "S",
      classify: (e: unknown) => (e instanceof AdapterError ? e : new AdapterError("internal", String(e))),
    } as unknown as TradeVenue;
    const ex = new VenueTradeExecutor(venue, { publish: async () => ({ uri: "https://m/x.json", imageUrl: null }) } as never);
    const queue = new InMemoryJobQueue(seededRng(1));
    const r = new Relayer({ queue, pool: new VaultPool(vs, inv, seededRng(1)), mintVaults, executors: { trade: { bags: ex }, withdraw: ex }, probe: chain });
    const j = queue.enqueue({ kind: "create", venue: "bags", meta: { name: "N", symbol: "S" }, lamportsIn: 0n, minOut: 0n }, { notBefore: 0 });
    await r.tick();
    expect(queue.get(j.id)!.result).toMatchObject({ status: "executed", execution: { kind: "create", tokenAmount: 0n, solAmount: 0n, creatorFee: 0n, mint: newMint } });
    expect(await mintVaults.get(newMint)).toBe(vaultSeen);
    expect(vs.map((v) => v.publicKey.toBase58())).toContain(vaultSeen);
    expect(vaultSeen).not.toBe(wallet);
  });
});
