import fs from "node:fs";
import path from "node:path";
import { DEV_LAUNCHPAD_PROGRAM, LaunchpadPool } from "@raydium-io/raydium-sdk-v2";
import { PUMP_PROGRAM_ID, PUMP_SDK, bondingCurvePda, creatorVaultPda, pumpIdl } from "@pump-fun/pump-sdk";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, type Signer, type VersionedTransactionResponse } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  CreatorDirectory,
  DbcFeeVenue,
  LaunchLabFeeVenue,
  PumpFeeVenue,
  StaticMintSource,
  TOKEN_ACCOUNT_RENT,
  collectCreatorFeeV2Ix,
  dbcFeeInstructions,
  pumpQuoteFeeInstructions,
  type FeeTarget,
  type FeeTxPlan,
  type FeeVenue,
} from "../src/creator-fees";
import { fixedPrice } from "../src/fees";
import { deriveCreatorKeypair } from "../src/keys";
import { PoolAQuoteValuer } from "../src/relayer/fee-runtime";
import { FeeSweeper, MemoryFeeSweepStore, assertSingleAuthority, type QuoteValuer, type SweepChain } from "../src/relayer/fee-sweeper";
import { quoteAssets } from "../src/pool-a";
import { seededRng } from "../src/relayer/random";
import { VaultPool } from "../src/relayer/vaults";
import type { SignatureState, SignedTx } from "../src/tx";
import { FakeInventory, vaults as makeVaults } from "./relayer/fakes";
import { FakeRpc, tokenAccount } from "./rpc-fake";

/*
 * RELAYER v8 A8: creator / platform fees collected in quote tokens. Devnet fixtures
 * (test/fixtures/fee-quote-devnet.json, public): the first quote sweep of 13.10
 * (pnpm fees:sweep --quote-any): LaunchLab creator + Unzeen platform fees in SOL and USDC,
 * DBC creator + partner fees of the USDC pool; a pump.fun devnet USDC curve; two LaunchLab pools.
 */
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "fee-quote-devnet.json"), "utf8")) as {
  txs: Record<"llCreatorSol" | "llPartnerSol" | "llCreatorUsdc" | "llPartnerUsdc" | "dbcPartnerUsdc" | "dbcCreatorUsdc", { signature: string; result: unknown }>;
  pumpUsdcCurve: { mint: string; owner: string; data: string };
  llPools: Record<string, { quote: string; pool: string; owner: string; data: string }>;
};
const SEED = new Uint8Array(64).fill(7);
const USDC_DEV = new PublicKey("USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT");
const UNZEEN_PLATFORM_DEV = new PublicKey("Hwww2ismdgWq9vvGYLmNf24iVQ8ZTZKcMNXNKGyHKZGd");

async function tx(k: keyof typeof FX.txs): Promise<VersionedTransactionResponse> {
  const rpc = new FakeRpc();
  rpc.txs.set(FX.txs[k].signature, FX.txs[k].result);
  return (await rpc.connection().getTransaction(FX.txs[k].signature, { maxSupportedTransactionVersion: 0 }))!;
}

function mintAccount(decimals: number) {
  const d = Buffer.alloc(82);
  d.writeUInt8(decimals, 44);
  d.writeUInt8(1, 45); // initialized
  return { owner: TOKEN_PROGRAM_ID.toBase58(), lamports: 1_461_600, data: d.toString("base64") };
}

const signersOf = (ixs: readonly TransactionInstruction[]) => [...new Set(ixs.flatMap((i) => i.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())))].sort();
const transferChecked = (ixs: readonly TransactionInstruction[]) => ixs.find((i) => i.programId.equals(TOKEN_PROGRAM_ID) && i.data[0] === 12)!;

// ---------------------------------------------------------------------------
// sweeper: thresholds and bookkeeping of quote targets
// ---------------------------------------------------------------------------

class QuoteVenue implements FeeVenue {
  readonly venue = "raydium-launchlab" as const;
  collectedUnits: bigint | null = null;
  constructor(
    readonly targets: FeeTarget[],
    private readonly dir: CreatorDirectory,
  ) {}
  async discover(): Promise<FeeTarget[]> {
    return this.targets.map((t) => ({ ...t }));
  }
  async build(t: FeeTarget, vault: PublicKey): Promise<FeeTxPlan | null> {
    const authority = this.dir.get(t.authority)!;
    const ix = SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: vault, lamports: 1 });
    return { target: t, instructions: [ix], authority, computeUnits: 150_000, expectedLamports: t.quote ? t.quote.units : t.lamports };
  }
  collected(): bigint | null {
    return this.collectedUnits;
  }
}

class Chain implements SweepChain {
  readonly sent: string[] = [];
  states = new Map<string, SignatureState>();
  fetched: VersionedTransactionResponse | null = null;
  private n = 0;
  async sign(_ixs: TransactionInstruction[], _payer: Signer, authority: Signer): Promise<SignedTx> {
    this.sent.push(authority.publicKey.toBase58());
    return { signature: `q${++this.n}`, raw: new Uint8Array(), blockhash: "x", lastValidBlockHeight: 100 };
  }
  async submit(): Promise<{ slot: number }> {
    return { slot: 9 };
  }
  async fetch(): Promise<VersionedTransactionResponse | null> {
    return this.fetched;
  }
  async state(sig: string): Promise<SignatureState> {
    return this.states.get(sig) ?? { state: "pending" };
  }
}

const USDC = "USDCmint1111111111111111111111111111111111";
const ZEC = "ZECmint11111111111111111111111111111111111";
const VALUER: QuoteValuer = {
  lamports: async (mint, units) => (mint === USDC ? units * 10n : null), // 1 USDC unit = 10 lamports
  minUnits: (mint) => (mint === ZEC ? 5_000_000n : null), // 0.05 ZEC
};

function sweeperWith(targets: Omit<FeeTarget, "authority">[], o: { valuer?: QuoteValuer | null; store?: MemoryFeeSweepStore } = {}) {
  const dir = new CreatorDirectory(SEED, targets.length);
  const ts = targets.map((t, i) => ({ ...t, authority: deriveCreatorKeypair(SEED, i).publicKey.toBase58() }));
  const inv = new FakeInventory();
  const store = o.store ?? new MemoryFeeSweepStore();
  const chain = new Chain();
  const venue = new QuoteVenue(ts, dir);
  const sweeper = new FeeSweeper({
    network: "devnet",
    venues: [venue],
    pool: new VaultPool(makeVaults(2, inv), inv, seededRng(3)),
    chain,
    store,
    rng: seededRng(3),
    price: fixedPrice(1_000),
    tipLamports: 0n,
    sleep: async () => undefined,
    ...(o.valuer === null ? {} : { quoteValuer: o.valuer ?? VALUER }),
  });
  return { sweeper, store, chain, venue, targets: ts };
}

const base = { venue: "raydium-launchlab" as const, kind: "creator" as const, lockedRent: 0n, frontLamports: 0n };
const sol = (lamports: bigint) => ({ ...base, mint: Keypair.generate().publicKey.toBase58(), lamports });
const quote = (mint: string, units: bigint, lockedRent = 0n) => ({ ...base, mint: Keypair.generate().publicKey.toBase58(), lamports: 0n, lockedRent, quote: { mint, units } });

describe("fee sweep: quote-token fees (RELAYER v8 A8)", () => {
  it("threshold: priced quotes by their SOL value (rent locked for good counts), stock-only by a unit minimum", async () => {
    const { sweeper } = sweeperWith([]);
    expect(await sweeper.eligible(sol(10_000_000n) as FeeTarget)).toBe(true);
    expect(await sweeper.eligible(quote(USDC, 500_000n) as FeeTarget)).toBe(true); // 5M lamports >= 2M floor
    expect(await sweeper.eligible(quote(USDC, 100_000n) as FeeTarget)).toBe(false); // 1M lamports
    expect(await sweeper.eligible(quote(USDC, 500_000n, TOKEN_ACCOUNT_RENT) as FeeTarget)).toBe(false); // 5 x (cost + ATA rent) > 5M
    expect(await sweeper.eligible(quote(ZEC, 10_000_000n) as FeeTarget)).toBe(true);
    expect(await sweeper.eligible(quote(ZEC, 4_999_999n) as FeeTarget)).toBe(false);
    expect(await sweeper.eligible(quote("OTHER111111111111111111111111111111111111", 10n ** 12n) as FeeTarget)).toBe(false); // no price, no minimum
  });

  it("rows (v9 §2): quote_mint at send; quote_amount + lamports = pool-A value (USDC) or 0 (ZEC) at confirm", async () => {
    const { sweeper, store } = sweeperWith([sol(10_000_000n), quote(USDC, 700_000n), quote(ZEC, 6_000_000n), quote(ZEC, 1_000n)]);
    const r = await sweeper.runOnce();
    expect(r).toMatchObject({ considered: 4, belowThreshold: 1, confirmed: 3, lamports: 10_000_000n });
    expect(r.quote.sort((a, b) => a.mint.localeCompare(b.mint))).toEqual([
      { mint: USDC, units: 700_000n },
      { mint: ZEC, units: 6_000_000n },
    ]);
    const q = store.rows.filter((x) => x.quoteMint);
    expect(q.map((x) => [x.quoteMint, x.lamports, x.quoteAmount, x.status]).sort()).toEqual(
      [
        [USDC, 7_000_000n, 700_000n, "confirmed"],
        [ZEC, 0n, 6_000_000n, "confirmed"],
      ].sort(),
    );
    expect(store.rows.find((x) => !x.quoteMint)).toMatchObject({ lamports: 10_000_000n, quoteAmount: null });
  });

  it("collected amount from the landed tx wins over the build-time estimate", async () => {
    const { sweeper, store, venue, chain } = sweeperWith([quote(USDC, 700_000n)]);
    venue.collectedUnits = 701_234n;
    chain.fetched = {} as VersionedTransactionResponse;
    await sweeper.runOnce();
    expect(store.rows[0]).toMatchObject({ quoteAmount: 701_234n, lamports: 7_012_340n }); // valued on what landed
  });

  it("priced quote that cannot be valued at confirm: row stays sent, the next run confirms it with the value", async () => {
    let calls = 0;
    let failAt = 3; // plan + re-check succeed, the confirm-time valuation fails
    const valuer: QuoteValuer = {
      lamports: async (m, u) => {
        if (++calls === failAt) throw new Error("rpc down");
        return VALUER.lamports(m, u);
      },
      minUnits: VALUER.minUnits,
    };
    const { sweeper, store, chain, venue } = sweeperWith([quote(USDC, 700_000n)], { valuer });
    const r = await sweeper.runOnce();
    expect(r.sent).toBe(1);
    expect(store.rows[0]).toMatchObject({ status: "sent", quoteMint: USDC, lamports: null });
    failAt = -1;
    chain.states.set(store.rows[0]!.signature, { state: "landed", slot: 12, err: null } as SignatureState);
    chain.fetched = {} as VersionedTransactionResponse;
    venue.collectedUnits = 700_000n;
    expect(await sweeper.resolvePending()).toBe(1);
    expect(store.rows[0]).toMatchObject({ status: "confirmed", lamports: 7_000_000n, quoteAmount: 700_000n });
  });

  it("no valuer, or a store without quote columns (core before 0019): quote targets are never swept", async () => {
    const a = sweeperWith([quote(USDC, 10n ** 9n), sol(10_000_000n)], { valuer: null });
    expect((await a.sweeper.runOnce()).confirmed).toBe(1);
    class Old extends MemoryFeeSweepStore {
      override async supportsQuote(): Promise<boolean> {
        return false;
      }
    }
    const b = sweeperWith([quote(USDC, 10n ** 9n), sol(10_000_000n)], { store: new Old() });
    const r = await b.sweeper.runOnce();
    expect(r.confirmed).toBe(1);
    expect(b.store.rows.every((x) => !x.quoteMint)).toBe(true);
  });

  it("pending quote row resolved later: confirmed with the units read from the tx", async () => {
    const { sweeper, store, venue, chain } = sweeperWith([]);
    await store.recordSent({ network: "devnet", venue: "raydium-launchlab", kind: "creator", mint: "M", authority: "A", signature: "S1", lastValidBlockHeight: 5, quoteMint: USDC });
    chain.states.set("S1", { state: "landed", slot: 77, err: null } as SignatureState);
    chain.fetched = {} as VersionedTransactionResponse;
    venue.collectedUnits = 4_242n;
    expect(await sweeper.resolvePending()).toBe(1);
    expect(store.rows[0]).toMatchObject({ status: "confirmed", lamports: 42_420n, quoteAmount: 4_242n, slot: 77 });
  });

  it("valuer of the runtime: pool A for priced quotes, FEE_SWEEP_MIN_<SYM> for ZEC SPL", () => {
    const assets = [...quoteAssets("mainnet-beta", {}), ...quoteAssets("mainnet-beta", { PUMP_QUOTE_ZEC: "1" }, "pumpfun")];
    const v = new PoolAQuoteValuer(new FakeRpc().connection(), assets, { FEE_SWEEP_MIN_ZEC: "0.2" });
    const zec = assets.find((a) => a.symbol === "ZEC")!.mint.toBase58();
    expect(v.minUnits(zec)).toBe(20_000_000n);
    expect(new PoolAQuoteValuer(new FakeRpc().connection(), assets, {}).minUnits(zec)).toBe(5_000_000n);
    expect(v.minUnits(assets.find((a) => a.symbol === "USDC")!.mint.toBase58())).toBeNull(); // priced: by value only
  });
});

// ---------------------------------------------------------------------------
// pump.fun quote curves
// ---------------------------------------------------------------------------

describe("pump.fun quote-curve creator fees", () => {
  it("collect_creator_fee_v2 matches the IDL (accounts, no signer)", () => {
    const creator = Keypair.generate().publicKey;
    const ix = collectCreatorFeeV2Ix(creator, USDC_DEV, TOKEN_PROGRAM_ID);
    const idl = (pumpIdl.instructions as ReadonlyArray<{ name: string; discriminator: number[]; accounts: { name: string }[] }>).find((i) => i.name === "collect_creator_fee_v2")!;
    expect([...ix.data]).toEqual(idl.discriminator);
    expect(ix.keys).toHaveLength(idl.accounts.length);
    expect(ix.keys.some((k) => k.isSigner)).toBe(false);
    expect(ix.keys[1]!.pubkey.equals(getAssociatedTokenAddressSync(USDC_DEV, creator, true))).toBe(true);
    expect(ix.keys[3]!.pubkey.equals(getAssociatedTokenAddressSync(USDC_DEV, creatorVaultPda(creator), true))).toBe(true);
  });

  it("discover + build on a real devnet USDC curve made ours: units = bucket + creator vault ATA + leftovers", async () => {
    const dir = new CreatorDirectory(SEED, 1);
    const creator = deriveCreatorKeypair(SEED, 0);
    const mint = new PublicKey(FX.pumpUsdcCurve.mint);
    const data = Buffer.from(FX.pumpUsdcCurve.data, "base64");
    const real = PUMP_SDK.decodeBondingCurve({ data, owner: PUMP_PROGRAM_ID, executable: false, lamports: 1 });
    const at = data.indexOf(real.creator.toBuffer());
    creator.publicKey.toBuffer().copy(data, at); // the curve's creator := our derived creator 0
    const quoteMint = new PublicKey(PUMP_SDK.decodeBondingCurve({ data, owner: PUMP_PROGRAM_ID, executable: false, lamports: 1 }).quoteMint);
    const rpc = new FakeRpc();
    rpc.set(bondingCurvePda(mint), { owner: PUMP_PROGRAM_ID.toBase58(), lamports: 1, data: data.toString("base64") });
    rpc.set(quoteMint, mintAccount(6));
    rpc.set(getAssociatedTokenAddressSync(quoteMint, creatorVaultPda(creator.publicKey), true), tokenAccount(quoteMint, creatorVaultPda(creator.publicKey), 300_000n));
    const venue = new PumpFeeVenue(rpc.connection(), dir, new StaticMintSource([mint.toBase58()]));
    const [t] = await venue.discover();
    const bucket = BigInt(real.creatorFee.toString());
    expect(t).toMatchObject({ venue: "pumpfun", kind: "creator", authority: creator.publicKey.toBase58(), lamports: 0n, quote: { mint: quoteMint.toBase58(), units: bucket + 300_000n } });
    expect(t!.lockedRent).toBe(TOKEN_ACCOUNT_RENT + (bucket > 0n ? 0n : 0n)); // creator ATA is new and stays
    const vault = Keypair.generate().publicKey;
    const plan = (await venue.build(t!, vault))!;
    assertSingleAuthority(plan.instructions, vault, creator.publicKey);
    expect(signersOf(plan.instructions)).toEqual([creator.publicKey.toBase58(), vault.toBase58()].sort());
    const tr = transferChecked(plan.instructions);
    expect(tr.data.readBigUInt64LE(1)).toBe(bucket + 300_000n);
    expect(tr.keys[2]!.pubkey.equals(getAssociatedTokenAddressSync(quoteMint, vault, true))).toBe(true);
    expect(plan.expectedLamports).toBe(bucket + 300_000n);
  });

  it("only leftovers on the creator's ATA: no sweep, no collect, just the transfer", async () => {
    const creator = Keypair.generate().publicKey;
    const vault = Keypair.generate().publicKey;
    const ixs = await pumpQuoteFeeInstructions({
      mint: Keypair.generate().publicKey, creator, quoteMint: USDC_DEV, quoteProgram: TOKEN_PROGRAM_ID, decimals: 6, vault,
      state: { bucket: 0n, vaultAta: 0n, vaultAtaExists: true, creatorAta: 55n, creatorAtaExists: true },
    });
    expect(ixs.some((i) => i.programId.equals(PUMP_PROGRAM_ID))).toBe(false);
    expect(transferChecked(ixs).data.readBigUInt64LE(1)).toBe(55n);
  });
});

// ---------------------------------------------------------------------------
// Meteora DBC quote pools
// ---------------------------------------------------------------------------

describe("Meteora DBC quote-pool fees", () => {
  const DBC_USDC_CONFIG = new PublicKey("HikwxNE3Us5Uw3ydMbAbNH8o6fmJseMdu9WndmGhetDa");
  const venue = new DbcFeeVenue({ pools: async () => [], pool: async () => null, config: async () => { throw new Error("unused"); } }, [{ address: DBC_USDC_CONFIG, quoteMint: USDC_DEV, decimals: 6 }], new CreatorDirectory(SEED, 0), null);
  const t = (kind: "creator" | "partner"): FeeTarget => ({ venue: "meteora-dbc", kind, mint: "FP4BiUarBXfiZKLJhYFEev3Vs4sgNThzDYtcVuW9ELdc", authority: "x", lamports: 0n, lockedRent: 0n, frontLamports: 0n, quote: { mint: USDC_DEV.toBase58(), units: 0n } });

  it("collected = the claim event of the USDC pool (devnet sweep 13.10)", async () => {
    expect(venue.collected(await tx("dbcCreatorUsdc"), t("creator"))).toBe(16_136n);
    expect(venue.collected(await tx("dbcPartnerUsdc"), t("partner"))).toBe(16_138n);
  });

  it("claim into a temporary quote account, exact amount to the vault's quote ATA, both temporaries closed", async () => {
    const authority = Keypair.generate().publicKey;
    const vault = Keypair.generate().publicKey;
    const ixs = await dbcFeeInstructions({
      kind: "creator",
      pool: Keypair.generate().publicKey,
      state: { baseMint: Keypair.generate().publicKey, baseVault: Keypair.generate().publicKey, quoteVault: Keypair.generate().publicKey, config: DBC_USDC_CONFIG },
      config: { tokenType: 0, quoteMint: USDC_DEV, quoteTokenFlag: 0 } as never,
      authority,
      vault,
      quoteAmount: 16_136n,
      quoteDecimals: 6,
    });
    expect(signersOf(ixs)).toEqual([authority.toBase58(), vault.toBase58()].sort());
    expect(transferChecked(ixs).data.readBigUInt64LE(1)).toBe(16_136n);
    expect(ixs.filter((i) => i.programId.equals(TOKEN_PROGRAM_ID) && i.data[0] === 9)).toHaveLength(2); // CloseAccount x2
    await expect(dbcFeeInstructions({ kind: "creator", pool: vault, state: { baseMint: vault, baseVault: vault, quoteVault: vault, config: vault }, config: { tokenType: 0, quoteMint: USDC_DEV, quoteTokenFlag: 0 } as never, authority, vault, quoteAmount: 1n })).rejects.toThrow(/decimals/);
  });
});

// ---------------------------------------------------------------------------
// Raydium LaunchLab
// ---------------------------------------------------------------------------

describe("LaunchLab creator / Unzeen platform fees", () => {
  const quotes = [{ mint: NATIVE_MINT, decimals: 9 }, { mint: USDC_DEV, decimals: 6 }];
  const forCollected = new LaunchLabFeeVenue(new FakeRpc().connection(), DEV_LAUNCHPAD_PROGRAM, quotes, new CreatorDirectory(SEED, 0), new StaticMintSource([]), null, UNZEEN_PLATFORM_DEV);
  const target = (kind: "creator" | "partner", authority: string, q: PublicKey | null): FeeTarget => ({
    venue: "raydium-launchlab", kind, mint: "m", authority, lamports: 0n, lockedRent: 0n, frontLamports: 0n, ...(q ? { quote: { mint: q.toBase58(), units: 0n } } : {}),
  });

  it("collected on the devnet sweep 13.10: SOL from the fee vault, USDC that reached the vault", async () => {
    const creatorSol = "9VyduV4ikHmBJLbL6zCQiPDYPQXLAXthAjQQKhNx4ZMm"; // fresh creator of 7Zksp… (devnet e2e)
    expect(forCollected.collected(await tx("llCreatorSol"), target("creator", creatorSol, null))).toBe(89_709n);
    expect(forCollected.collected(await tx("llPartnerSol"), target("partner", "p", null))).toBe(269_128n);
    expect(forCollected.collected(await tx("llCreatorUsdc"), target("creator", "c", USDC_DEV))).toBe(10_537n);
    expect(forCollected.collected(await tx("llPartnerUsdc"), target("partner", "p", USDC_DEV))).toBe(32_721n);
  });

  function setup() {
    const dir = new CreatorDirectory(SEED, 1);
    const creator = deriveCreatorKeypair(SEED, 0);
    const rpc = new FakeRpc();
    for (const [mint, p] of Object.entries(FX.llPools)) {
      const data = Buffer.from(p.data, "base64");
      const real = LaunchpadPool.decode(data).creator;
      creator.publicKey.toBuffer().copy(data, data.indexOf(real.toBuffer())); // pool creator := our creator 0
      rpc.set(new PublicKey(p.pool), { owner: p.owner, lamports: 1, data: data.toString("base64") });
      void mint;
    }
    const venue = new LaunchLabFeeVenue(rpc.connection(), DEV_LAUNCHPAD_PROGRAM, quotes, dir, new StaticMintSource(Object.keys(FX.llPools)), null, null);
    return { rpc, venue, creator };
  }

  it("creator side: one target per launch, SOL unwrapped by closing, USDC transferred to the vault's quote ATA", async () => {
    const { rpc, venue, creator } = setup();
    const { getPdaCreatorVault, getPdaCreatorFeeVaultAuth } = await import("@raydium-io/raydium-sdk-v2");
    const auth = getPdaCreatorFeeVaultAuth(DEV_LAUNCHPAD_PROGRAM).publicKey;
    rpc.set(getPdaCreatorVault(DEV_LAUNCHPAD_PROGRAM, creator.publicKey, NATIVE_MINT).publicKey, tokenAccount(NATIVE_MINT, auth, 89_709n));
    rpc.set(getPdaCreatorVault(DEV_LAUNCHPAD_PROGRAM, creator.publicKey, USDC_DEV).publicKey, tokenAccount(USDC_DEV, auth, 10_000n));
    rpc.set(getAssociatedTokenAddressSync(USDC_DEV, creator.publicKey, true), tokenAccount(USDC_DEV, creator.publicKey, 537n)); // leftover of a late accrual
    const ts = await venue.discover();
    expect(ts).toHaveLength(2);
    const solT = ts.find((t) => !t.quote)!;
    const usdT = ts.find((t) => t.quote)!;
    expect(solT).toMatchObject({ kind: "creator", lamports: 89_709n, lockedRent: 0n, frontLamports: TOKEN_ACCOUNT_RENT });
    expect(usdT).toMatchObject({ lamports: 0n, lockedRent: 0n, quote: { mint: USDC_DEV.toBase58(), units: 10_537n } });
    const vault = Keypair.generate().publicKey;
    const solPlan = (await venue.build(solT, vault))!;
    assertSingleAuthority(solPlan.instructions, vault, creator.publicKey);
    expect(solPlan.instructions.at(-1)!.data[0]).toBe(9); // CloseAccount (wSOL) -> vault
    expect(solPlan.instructions.at(-1)!.keys[1]!.pubkey.equals(vault)).toBe(true);
    const usdPlan = (await venue.build(usdT, vault))!;
    assertSingleAuthority(usdPlan.instructions, vault, creator.publicKey);
    expect(transferChecked(usdPlan.instructions).data.readBigUInt64LE(1)).toBe(10_537n);
    expect(usdPlan.instructions.some((i) => i.programId.equals(TOKEN_PROGRAM_ID) && i.data[0] === 9)).toBe(false); // ATA kept
  });

  it("a launch whose creator is not ours is never a target; nothing claimable -> no tx", async () => {
    const { venue } = setup();
    const other = new LaunchLabFeeVenue(new FakeRpc().connection(), DEV_LAUNCHPAD_PROGRAM, quotes, new CreatorDirectory(new Uint8Array(64).fill(9), 3), new StaticMintSource(Object.keys(FX.llPools)), null, null);
    expect(await other.discover()).toEqual([]);
    const ts = await venue.discover(); // fee vaults empty
    expect(ts.every((t) => (t.quote ? t.quote.units : t.lamports) === 0n)).toBe(true);
    expect(await venue.build(ts[0]!, Keypair.generate().publicKey)).toBeNull();
  });
});
