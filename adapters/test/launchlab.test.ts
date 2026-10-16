import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BN from "bn.js";
import { DEV_LAUNCHPAD_PROGRAM, LaunchpadConfig } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, VersionedTransaction, type MessageCompiledInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { anchorEventPayloads } from "../src/events";
import { CreatorKeyring, MemoryCreatorIndexCounter } from "../src/keys";
import {
  LAUNCHLAB_CONFIGS,
  LAUNCHLAB_PLATFORMS,
  LAUNCH_TOTAL_SELL,
  LaunchLabAdapter,
  UNZEEN_PLATFORM,
  decodePoolCreateEvent,
  decodeTradeEvent,
  freshPool,
  fundRaisingFor,
  llStatus,
  swapOut,
} from "../src/launchlab";
import { PUMP_QUOTE_DEFAULTS, QUOTE_DEFAULTS, poolASwapLegs, quoteAssets } from "../src/pool-a";
import { SENDER_TIP_ACCOUNTS, senderTip } from "../src/sender";
import { FakeRpc, launchLabAccounts, launchLabTxs, tokenAccount } from "./rpc-fake";

const ev = (n: string) => createHash("sha256").update(`event:${n}`).digest().subarray(0, 8);
const IX = {
  initializeV2: Buffer.from([67, 153, 175, 39, 218, 16, 38, 32]),
  initializeWithToken2022: Buffer.from([37, 190, 126, 222, 44, 154, 171, 17]),
  buyExactIn: Buffer.from([250, 234, 13, 123, 213, 156, 19, 236]),
};
const LL_MAIN = new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
const CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const USD1 = new PublicKey(QUOTE_DEFAULTS["mainnet-beta"].USD1!.mint);
const ZEC = new PublicKey(PUMP_QUOTE_DEFAULTS["mainnet-beta"].ZEC!.mint);
/** Worst realistic metadata: name 32 B, symbol 10 B, uri = ipfs.io gateway + CIDv1 (80 B). */
const META = { name: "N".repeat(32), symbol: "S".repeat(10), uri: `https://ipfs.io/ipfs/${"b".repeat(59)}` };

// ---------------------------------------------------------------------------
// events of the devnet e2e (13.10, Unzeen platform)
// ---------------------------------------------------------------------------

describe("LaunchLab events (devnet e2e 13.10)", () => {
  const FX = launchLabTxs().devnet;
  const load = async (k: keyof typeof FX) => {
    const rpc = new FakeRpc();
    rpc.txs.set(FX[k].signature, FX[k].result);
    return (await rpc.connection().getTransaction(FX[k].signature, { maxSupportedTransactionVersion: 0 }))!;
  };
  const trades = async (k: keyof typeof FX) => anchorEventPayloads(await load(k), DEV_LAUNCHPAD_PROGRAM, ev("TradeEvent")).map(decodeTradeEvent);

  it("create: PoolCreateEvent carries the fresh creator and our metadata", async () => {
    const tx = await load("solCreate");
    const c = anchorEventPayloads(tx, DEV_LAUNCHPAD_PROGRAM, ev("PoolCreateEvent")).map(decodePoolCreateEvent)[0]!;
    expect(c).toMatchObject({ name: "Unzeen LL SOL", symbol: "UNZLS", uri: "https://unzeen.invalid/meta/ll-test.json" });
    expect(c.config.toBase58()).toBe(LAUNCHLAB_CONFIGS.devnet[NATIVE_MINT.toBase58()]);
    const signers = tx.transaction.message.staticAccountKeys.slice(0, tx.transaction.message.header.numRequiredSignatures).map((k) => k.toBase58());
    expect(signers).not.toContain(c.creator.toBase58()); // the creator never signs (vault pays)
  });

  it("first buy: fees are exactly the Unzeen platform's 0.25 / 0.45 / 0.30 %", async () => {
    const t = (await trades("solCreate"))[0]!;
    expect(t).toMatchObject({ amountIn: 10_000_000n, direction: 0, poolStatus: 0, exactIn: true, shareFee: 0n });
    expect(t.protocolFee).toBe(25_000n);
    expect(t.platformFee).toBe((10_000_000n * BigInt(UNZEEN_PLATFORM.feeRate)) / 1_000_000n);
    expect(t.creatorFee).toBe((10_000_000n * BigInt(UNZEEN_PLATFORM.creatorFeeRate)) / 1_000_000n);
  });

  it("first-buy quote of a fresh pool == tokens the chain gave (local curve math)", async () => {
    const t = (await trades("solCreate"))[0]!;
    // Mainnet SOL GlobalConfig has the same migrate fee / trade fee as devnet's (13.10).
    const cfg = LaunchpadConfig.decode(Buffer.from(launchLabAccounts()[LAUNCHLAB_CONFIGS["mainnet-beta"][NATIVE_MINT.toBase58()]!]!.data, "base64"));
    const pool = freshPool(cfg, new BN(fundRaisingFor({ mint: NATIVE_MINT, decimals: 9 }).toString()));
    expect(swapOut("buy", pool, { tradeFeeRate: new BN(2_500), curveType: 0 }, { feeRate: new BN(UNZEEN_PLATFORM.feeRate), creatorFeeRate: new BN(UNZEEN_PLATFORM.creatorFeeRate) }, 10_000_000n, 0)).toBe(t.amountOut);
  });

  it("leg buy: the pool-A ExactOut output is exactly what the curve took (no dust)", async () => {
    const tx = await load("quoteBuyLeg");
    const t = anchorEventPayloads(tx, DEV_LAUNCHPAD_PROGRAM, ev("TradeEvent")).map(decodeTradeEvent)[0]!;
    const legs = poolASwapLegs(tx, new PublicKey(QUOTE_DEFAULTS.devnet.USDC!.poolA!));
    expect(legs).toHaveLength(1);
    expect(legs[0]!.outputAmount).toBe(t.amountIn);
    expect(t.direction).toBe(0);
  });

  it("sell: direction 1, proceeds in quote units; no pool-A swap back", async () => {
    const t = (await trades("quoteSell"))[0]!;
    expect(t.direction).toBe(1);
    expect(t.amountOut).toBe(1_232_490n);
    expect(poolASwapLegs(await load("quoteSell"), new PublicKey(QUOTE_DEFAULTS.devnet.USDC!.poolA!))).toEqual([]);
  });

  it("decoders reject short payloads", () => {
    expect(decodeTradeEvent(Buffer.alloc(10))).toBeNull();
    expect(decodePoolCreateEvent(Buffer.alloc(10))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe("LaunchLab helpers", () => {
  it("fund raising per quote: SOL 85, USD 12 500, ZEC 200", () => {
    expect(fundRaisingFor({ mint: NATIVE_MINT, decimals: 9 })).toBe(85_000_000_000n);
    expect(fundRaisingFor({ mint: USD1, decimals: 6 })).toBe(12_500_000_000n);
    expect(fundRaisingFor({ mint: ZEC, decimals: 8, symbol: "ZEC" })).toBe(20_000_000_000n);
  });
  it("status: 0 = curve, migrating / migrated = graduated", () => {
    expect(llStatus({ status: 0 } as never)).toBe("curve");
    expect(llStatus({ status: 1 } as never)).toBe("graduated");
    expect(llStatus({ status: 2 } as never)).toBe("graduated");
  });
  it("buy then sell back on a fresh pool loses about the fees, never gains", () => {
    const cfg = { tradeFeeRate: new BN(2_500), curveType: 0 };
    const plat = { feeRate: new BN(4_500), creatorFeeRate: new BN(3_000) };
    const fresh = freshPool({ migrateFee: new BN(0) } as never, new BN(85_000_000_000));
    const tokens = swapOut("buy", fresh, cfg, plat, 1_000_000_000n, 0);
    expect(tokens).toBeGreaterThan(0n);
    expect(tokens).toBeLessThan(LAUNCH_TOTAL_SELL);
    const after = { ...fresh, realA: new BN(tokens.toString()), realB: new BN(990_000_000) } as never;
    const back = swapOut("sell", after, cfg, plat, tokens, 0);
    expect(back).toBeLessThan(1_000_000_000n);
    expect(back).toBeGreaterThan(970_000_000n); // ~1 % each way
  });
});

// ---------------------------------------------------------------------------
// prepareCreate / prepareBuy against the mainnet snapshot (offline, nothing sent)
// ---------------------------------------------------------------------------

interface Setup {
  rpc: FakeRpc;
  vault: Keypair;
  a: LaunchLabAdapter;
  tables: PublicKey[][];
}

function setup(o: { sol?: number; usd1?: bigint; zec?: bigint; zecRoute?: boolean; unzeen?: PublicKey } = {}): Setup {
  const rpc = new FakeRpc(launchLabAccounts());
  const vault = Keypair.generate();
  rpc.balances.set(vault.publicKey.toBase58(), o.sol ?? 2_000_000_000);
  if (o.usd1 !== undefined) rpc.set(getAssociatedTokenAddressSync(USD1, vault.publicKey, true), tokenAccount(USD1, vault.publicKey, o.usd1));
  if (o.zec !== undefined) rpc.set(getAssociatedTokenAddressSync(ZEC, vault.publicKey, true), tokenAccount(ZEC, vault.publicKey, o.zec));
  const tables: PublicKey[][] = [];
  // The vault's lookup table: whatever the adapter asks for (src/alt.ts creates / extends it on chain).
  const lookupTables = {
    ensure: async (_v: unknown, addresses: readonly PublicKey[]) => {
      tables.push([...addresses]);
      return new AddressLookupTableAccount({ key: new PublicKey("A1t1111111111111111111111111111111111111111"), state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [...addresses] } });
    },
  };
  const quotes = [...quoteAssets("mainnet-beta", {}), ...(o.zecRoute ? quoteAssets("mainnet-beta", { PUMP_QUOTE_ZEC: "1" }, "pumpfun").filter((q) => q.stockOnly) : [])];
  const a = new LaunchLabAdapter({
    connection: rpc.connection(),
    cluster: "mainnet-beta",
    defaultVault: vault,
    creators: new CreatorKeyring(Buffer.alloc(64, 3), new MemoryCreatorIndexCounter()),
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "unzeen-ll-")),
    quotes,
    ...(o.unzeen ? { unzeenPlatform: o.unzeen } : {}),
    priorityMicroLamports: 1_000,
    lookupTables: lookupTables as never,
    pipeline: { tip: senderTip(5_000n, () => 0), broadcaster: { name: "none", send: async () => undefined, trySend: async () => undefined } },
  });
  return { rpc, vault, a, tables };
}

interface Decoded {
  size: number;
  signers: string[];
  ixs: { program: PublicKey; data: Buffer; keys: PublicKey[] }[];
  cu: number;
}

function decode(raw: Uint8Array, tables: PublicKey[][]): Decoded {
  const tx = VersionedTransaction.deserialize(raw);
  const m = tx.message;
  const alts = m.addressTableLookups.length
    ? [new AddressLookupTableAccount({ key: m.addressTableLookups[0]!.accountKey, state: { deactivationSlot: 0n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: tables.at(-1)! } })]
    : [];
  const keys = m.getAccountKeys({ addressLookupTableAccounts: alts });
  const ixs = m.compiledInstructions.map((ix: MessageCompiledInstruction) => ({ program: keys.get(ix.programIdIndex)!, data: Buffer.from(ix.data), keys: ix.accountKeyIndexes.map((i) => keys.get(i)!) }));
  const lim = ixs.find((i) => i.program.equals(ComputeBudgetProgram.programId) && i.data[0] === 2)!;
  return { size: raw.length, signers: m.staticAccountKeys.slice(0, m.header.numRequiredSignatures).map((k) => k.toBase58()), ixs, cu: lim.data.readUInt32LE(1) };
}

const isIx = (d: Buffer, disc: Buffer) => d.subarray(0, 8).equals(disc);

describe("LaunchLabAdapter.prepareCreate (mainnet snapshot, offline)", () => {
  it("stonk.fun SOL: its curve rule wants Token-2022 -> initialize_with_token_2022; bonk.fun: initialize_v2", async () => {
    const s = setup();
    const stonk = decode((await s.a.prepareCreate(META, 10_000_000n, 0n, { platform: "stonk" })).raw, s.tables);
    expect(stonk.ixs.some((i) => i.program.equals(LL_MAIN) && isIx(i.data, IX.initializeWithToken2022))).toBe(true);
    const bonk = decode((await s.a.prepareCreate(META, 10_000_000n, 0n, { platform: "bonk" })).raw, s.tables);
    const init = bonk.ixs.find((i) => i.program.equals(LL_MAIN) && isIx(i.data, IX.initializeV2))!;
    expect(init.keys.some((k) => k.equals(TOKEN_2022_PROGRAM_ID))).toBe(false);
    expect(init.keys.some((k) => k.toBase58() === LAUNCHLAB_PLATFORMS["mainnet-beta"].bonk)).toBe(true);
  });

  it("vault + mint sign, the fresh creator does not; fixed CU 400k (SOL)", async () => {
    const s = setup();
    const p = await s.a.prepareCreate(META, 10_000_000n, 0n, { platform: "bonk" });
    const d = decode(p.raw, s.tables);
    expect(d.signers.sort()).toEqual([s.vault.publicKey.toBase58(), p.mint].sort());
    expect(d.signers).not.toContain(p.creator);
    expect(d.cu).toBe(400_000);
    expect(p.quoteMint).toBeUndefined();
  });

  for (const platform of ["stonk", "bonk"]) {
    it(`${platform} USD1 without stock: CLMM leg in the same tx, worst-case metadata + Sender tip <= 1232 B`, async () => {
      const s = setup({ usd1: 0n });
      const p = await s.a.prepareCreate(META, 50_000_000n, 0n, { platform, quote: "USD1" });
      expect(p.quoteSource).toBe("leg");
      const d = decode(p.raw, s.tables);
      expect(d.size).toBeLessThanOrEqual(1232);
      expect(d.cu).toBe(500_000);
      const swap = d.ixs.findIndex((i) => i.program.equals(CLMM));
      const buy = d.ixs.findIndex((i) => i.program.equals(LL_MAIN) && isIx(i.data, IX.buyExactIn));
      expect(swap).toBeGreaterThan(-1);
      expect(swap).toBeLessThan(buy);
      // ExactOut amount == quote units the curve buy spends.
      expect(d.ixs[swap]!.data.readBigUInt64LE(8)).toBe(d.ixs[buy]!.data.readBigUInt64LE(8));
      expect(d.ixs[buy]!.data.readBigUInt64LE(8)).toBe(p.quoteUnits);
      // The vault's ALT holds its own stable accounts + the tip accounts (13.10: 1233+ B without them).
      const table = s.tables.at(-1)!.map((k) => k.toBase58());
      expect(table).toContain(getAssociatedTokenAddressSync(NATIVE_MINT, s.vault.publicKey, true).toBase58());
      expect(table).toContain(getAssociatedTokenAddressSync(USD1, s.vault.publicKey, true).toBase58());
      for (const t of SENDER_TIP_ACCOUNTS) expect(table).toContain(t);
      expect(table).not.toContain(p.mint);
      expect(table).not.toContain(p.creator);
    });
  }

  it("USD1 with enough stock: no leg, and no SOL needed for the buy itself", async () => {
    const s = setup({ usd1: 1_000_000_000n, sol: 40_000_000 }); // rent headroom only
    const p = await s.a.prepareCreate(META, 50_000_000n, 0n, { platform: "bonk", quote: "USD1" });
    expect(p.quoteSource).toBe("stock");
    expect(decode(p.raw, s.tables).ixs.some((i) => i.program.equals(CLMM))).toBe(false);
    // Same balance, no stock: the leg needs the SOL -> refused before anything is signed.
    const t = setup({ usd1: 0n, sol: 40_000_000 });
    await expect(t.a.prepareCreate(META, 50_000_000n, 0n, { platform: "bonk", quote: "USD1" })).rejects.toMatchObject({ code: "insufficient_sol" });
  });

  it("refusals: unknown platform, long symbol, fair launch, unserved quote", async () => {
    const s = setup();
    await expect(s.a.prepareCreate(META, 1n, 0n, { platform: "nope" })).rejects.toMatchObject({ code: "venue_unavailable" });
    await expect(s.a.prepareCreate({ ...META, symbol: "S".repeat(11) }, 1n, 0n)).rejects.toMatchObject({ code: "bad_request" });
    await expect(s.a.prepareCreate(META, 1n, 0n, { platform: "bonk", mintKeypair: Keypair.generate() })).rejects.toMatchObject({ code: "bad_request" });
    await expect(s.a.prepareCreate(META, 1n, 0n, { platform: "bonk", quote: "ZEC" })).rejects.toMatchObject({ code: "venue_unavailable" }); // ZEC route off
  });
});

describe("ZEC (stock-only quote) on LaunchLab", () => {
  it("amounts are ZEC units as given by core: no conversion, no leg, no SOL for the buy", async () => {
    const s = setup({ zecRoute: true, zec: 500_000_000n, sol: 40_000_000 }); // 5 ZEC stock
    const p = await s.a.prepareCreate(META, 30_000_000n, 0n, { platform: "stonk", quote: "ZEC" }); // 0.3 ZEC
    expect(p).toMatchObject({ quoteSource: "stock", quoteUnits: 30_000_000n, quoteMint: ZEC.toBase58() });
    const d = decode(p.raw, s.tables);
    const buy = d.ixs.find((i) => i.program.equals(LL_MAIN) && isIx(i.data, IX.buyExactIn))!;
    expect(buy.data.readBigUInt64LE(8)).toBe(30_000_000n);
    expect(d.ixs.some((i) => i.program.equals(CLMM))).toBe(false);
    expect(buy.keys.some((k) => k.toBase58() === LAUNCHLAB_CONFIGS["mainnet-beta"][ZEC.toBase58()])).toBe(true);
  });

  it("short ZEC stock -> insufficient_sol (API: pool_liquidity), nothing signed", async () => {
    const s = setup({ zecRoute: true, zec: 10_000_000n });
    await expect(s.a.prepareCreate(META, 30_000_000n, 0n, { platform: "bonk", quote: "ZEC" })).rejects.toMatchObject({ code: "insufficient_sol" });
    const none = setup({ zecRoute: true });
    await expect(none.a.prepareCreate(META, 1n, 0n, { platform: "bonk", quote: "ZEC" })).rejects.toMatchObject({ code: "insufficient_sol" });
  });
});

describe("LaunchLab platform pins (RELAYER v8 A1)", () => {
  it("stonk / bonk match their pins on the 13.10 snapshot", async () => {
    const s = setup();
    expect(await s.a.checkPlatforms()).toEqual([]);
    expect(Object.keys(s.a.platformIds()).sort()).toEqual(["bonk", "stonk"]);
  });
  it("a changed claim wallet or fee switches the platform off (creates refused)", async () => {
    const s = setup();
    const id = LAUNCHLAB_PLATFORMS["mainnet-beta"].bonk!;
    const acc = s.rpc.accounts.get(id)!;
    const data = Buffer.from(acc.data, "base64");
    // PlatformConfig: discriminator 8 | epoch u64 | platform_claim_fee_wallet (32) ...
    Keypair.generate().publicKey.toBuffer().copy(data, 16);
    s.rpc.accounts.set(id, { ...acc, data: data.toString("base64") });
    const w = await s.a.checkPlatforms();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/bonk switched off: claim wallet changed/);
    await expect(s.a.prepareCreate(META, 1n, 0n, { platform: "bonk" })).rejects.toMatchObject({ code: "venue_unavailable" });
    expect(Object.keys(s.a.platformIds())).toEqual(["stonk"]);
  });
  it("GAP-4: own platform 'unzeen' is served only once its account exists on this network", async () => {
    const own = Keypair.generate().publicKey;
    const s = setup({ unzeen: own });
    const w = await s.a.checkPlatforms();
    expect(w).toEqual(["LaunchLab platform unzeen switched off: not created on this network (pnpm launchlab:platform)"]);
    expect(Object.keys(s.a.platformIds()).sort()).toEqual(["bonk", "stonk"]);
    await expect(s.a.prepareCreate(META, 1n, 0n, { platform: "unzeen" })).rejects.toMatchObject({ code: "venue_unavailable" });

    const s2 = setup({ unzeen: own });
    const bonk = s2.rpc.accounts.get(LAUNCHLAB_PLATFORMS["mainnet-beta"].bonk!)!;
    s2.rpc.accounts.set(own.toBase58(), { ...bonk }); // a PlatformConfig owned by the LaunchLab program
    expect(await s2.a.checkPlatforms()).toEqual([]);
    expect(Object.keys(s2.a.platformIds()).sort()).toEqual(["bonk", "stonk", "unzeen"]);
  });
  it("unreadable platforms: all third-party ones off (fail closed)", async () => {
    const s = setup();
    for (const id of Object.values(LAUNCHLAB_PLATFORMS["mainnet-beta"])) s.rpc.accounts.delete(id);
    expect(await s.a.checkPlatforms()).toHaveLength(2);
    expect(s.a.platformIds()).toEqual({});
  });
});
