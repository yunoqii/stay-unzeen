import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { PUMP_QUOTE_DEFAULTS, quoteAssets, type QuoteAsset } from "../src/pool-a";
import { PoolQuoteInventoryWriter } from "../src/rebalance";
import { AllMintSources, PgPoolQuoteMintSource } from "../src/relayer/fee-sweeper";
import { FundQuoteExecutor } from "../src/relayer/executors";
import { QuoteStocker, StockDistributor, stockPolicy } from "../src/relayer/quote-stock";
import { FakeRpc, launchLabAccounts, tokenAccount } from "./rpc-fake";

/* ZEC SPL is stock-only: fund_quote moves stock from the rebalance address to a vault, no swap. */
const ZEC_ASSET = quoteAssets("mainnet-beta", { PUMP_QUOTE_ZEC: "1" }, "pumpfun").find((a) => a.symbol === "ZEC")!;
const ZEC = new PublicKey(PUMP_QUOTE_DEFAULTS["mainnet-beta"].ZEC!.mint);
const ONE = 100_000_000n; // 1 ZEC (8 decimals)
const POLICY = { target: 2n * ONE, low: ONE, high: 6n * ONE };

function setup(vaultZec: bigint | null, sourceZec: bigint | null) {
  const rpc = new FakeRpc();
  const vault = Keypair.generate().publicKey;
  const source = Keypair.generate();
  if (vaultZec !== null) rpc.set(getAssociatedTokenAddressSync(ZEC, vault, true), tokenAccount(ZEC, vault, vaultZec));
  if (sourceZec !== null) rpc.set(getAssociatedTokenAddressSync(ZEC, source.publicKey, true), tokenAccount(ZEC, source.publicKey, sourceZec));
  const d = new StockDistributor({ connection: rpc.connection(), asset: ZEC_ASSET, policy: POLICY, source });
  return { rpc, vault, source, d };
}

/** The transfer of a signed distributor tx: [source ATA, mint, vault ATA, authority] + amount. */
function transferOf(raw: Uint8Array) {
  const tx = VersionedTransaction.deserialize(raw);
  const keys = tx.message.staticAccountKeys;
  const ix = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex]!.equals(TOKEN_PROGRAM_ID) && i.data[0] === 12)!; // TransferChecked
  const data = Buffer.from(ix.data);
  return {
    from: keys[ix.accountKeyIndexes[0]!]!,
    mint: keys[ix.accountKeyIndexes[1]!]!,
    to: keys[ix.accountKeyIndexes[2]!]!,
    authority: keys[ix.accountKeyIndexes[3]!]!,
    amount: data.readBigUInt64LE(1),
    decimals: data.readUInt8(9),
    signers: keys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58()),
  };
}

describe("ZEC stock-only quote", () => {
  it("defaults: ZEC SPL, 8 decimals, no pool A, stock-only; only behind PUMP_QUOTE_ZEC=1", () => {
    expect(ZEC_ASSET).toMatchObject({ symbol: "ZEC", decimals: 8, poolA: null, stockOnly: true });
    expect(quoteAssets("mainnet-beta", {}, "pumpfun").some((a) => a.symbol === "ZEC")).toBe(false);
  });
  it("policy from env: whole tokens -> units, low = target / 2, high = 3 x target", () => {
    expect(stockPolicy(ZEC_ASSET, "mainnet-beta", { QUOTE_STOCK_ZEC_TARGET: "1.5" })).toEqual({ target: 150_000_000n, low: 75_000_000n, high: 450_000_000n });
  });
});

describe("StockDistributor (fund_quote for ZEC)", () => {
  it("refuses a priced quote", () => {
    const usdc = quoteAssets("mainnet-beta", {}).find((a) => a.symbol === "USDC")!;
    expect(() => new StockDistributor({ connection: new FakeRpc().connection(), asset: usdc, policy: POLICY, source: Keypair.generate() })).toThrow(/not a stock-only/);
  });

  it("vault below low: transfers up to target from the rebalance address; only the rebalance key signs", async () => {
    const s = setup(ONE / 2n, 10n * ONE);
    expect(await s.d.need(s.vault)).toBe(2n * ONE - ONE / 2n);
    const p = (await s.d.prepare(s.vault))!;
    expect(p.units).toBe(2n * ONE - ONE / 2n);
    const t = transferOf(p.raw);
    expect(t).toMatchObject({ amount: p.units, decimals: 8 });
    expect(t.mint.equals(ZEC)).toBe(true);
    expect(t.from.equals(getAssociatedTokenAddressSync(ZEC, s.source.publicKey, true))).toBe(true);
    expect(t.to.equals(getAssociatedTokenAddressSync(ZEC, s.vault, true))).toBe(true);
    expect(t.authority.equals(s.source.publicKey)).toBe(true);
    expect(t.signers).toEqual([s.source.publicKey.toBase58()]); // the vault never signs (it only receives)
  });

  it("no ATA on the vault yet: same (the transfer creates it, paid by the rebalance key)", async () => {
    const s = setup(null, 10n * ONE);
    expect((await s.d.prepare(s.vault))!.units).toBe(2n * ONE);
  });

  it("within bounds or above high: nothing to do (an excess is left on the vault)", async () => {
    const within = setup(ONE, 10n * ONE);
    expect(await within.d.prepare(within.vault)).toBeNull();
    const above = setup(100n * ONE, 10n * ONE);
    expect(await above.d.need(above.vault)).toBe(0n);
    expect(await above.d.prepare(above.vault)).toBeNull();
  });

  it("short rebalance address: transfers what it has; empty -> insufficient_sol (pool_liquidity)", async () => {
    const short = setup(0n, ONE / 4n);
    expect((await short.d.prepare(short.vault))!.units).toBe(ONE / 4n);
    const empty = setup(0n, null);
    await expect(empty.d.prepare(empty.vault)).rejects.toMatchObject({ code: "insufficient_sol" });
  });
});

describe("FundQuoteExecutor routing", () => {
  const usd1 = quoteAssets("mainnet-beta", {}).find((a) => a.symbol === "USD1")! as QuoteAsset;

  it("by mint (core sends the mint) or by a unique symbol; unknown -> venue_unavailable", () => {
    const z = setup(0n, ONE);
    const stocker = new QuoteStocker({ connection: new FakeRpc(launchLabAccounts()).connection(), asset: usd1, policy: POLICY });
    const ex = new FundQuoteExecutor([stocker, z.d]);
    const v = z.vault.toBase58();
    expect(ex.ownSigner({ kind: "fund_quote", quote: ZEC.toBase58(), vault: v })).toBe(z.source); // ZEC: rebalance key
    expect(ex.ownSigner({ kind: "fund_quote", quote: "ZEC", vault: v })).toBe(z.source);
    expect(ex.ownSigner({ kind: "fund_quote", quote: usd1.mint.toBase58(), vault: v })).toBeNull(); // USD1: the vault itself
    expect(ex.vaultRequest({ kind: "fund_quote", quote: "ZEC", vault: v })).toMatchObject({ only: v });
    expect(() => ex.ownSigner({ kind: "fund_quote", quote: "USDT", vault: v })).toThrow(/no \(unique\) quote stock route/);
  });

  it("ZEC: prepares the transfer to meta.vault whatever signer the engine passes", async () => {
    const z = setup(0n, 10n * ONE);
    const ex = new FundQuoteExecutor([z.d]);
    const tx = await ex.prepare({ kind: "fund_quote", quote: "ZEC", vault: z.vault.toBase58() }, z.source);
    expect(transferOf(tx.raw).to.equals(getAssociatedTokenAddressSync(ZEC, z.vault, true))).toBe(true);
  });

  it("stock within bounds: noop execution without a signature (v8: confirmed without tx)", async () => {
    const z = setup(ONE, 10n * ONE);
    const ex = new FundQuoteExecutor([z.d]);
    const e = await ex.noop({ kind: "fund_quote", quote: "ZEC", vault: z.vault.toBase58() }, z.source);
    expect(e).toMatchObject({ kind: "fund_quote", signature: null, quoteDelta: 0n, lamports: 0n, vault: z.vault.toBase58() });
    const low = setup(0n, 10n * ONE);
    expect(await new FundQuoteExecutor([low.d]).noop({ kind: "fund_quote", quote: "ZEC", vault: low.vault.toBase58() }, low.source)).toBeNull();
  });
});

describe("PoolQuoteInventoryWriter (RELAYER v8 A7)", () => {
  it("Σ of each pool_quotes mint on all vaults and, separately, on the rebalance address", async () => {
    const rpc = new FakeRpc();
    const vaults = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    const reb = Keypair.generate().publicKey;
    rpc.set(ZEC, { owner: TOKEN_PROGRAM_ID.toBase58(), lamports: 1, data: Buffer.alloc(82).toString("base64") });
    rpc.set(getAssociatedTokenAddressSync(ZEC, vaults[0]!, true), tokenAccount(ZEC, vaults[0]!, 3n * ONE));
    rpc.set(getAssociatedTokenAddressSync(ZEC, vaults[2]!, true), tokenAccount(ZEC, vaults[2]!, ONE)); // vaults[1]: no ATA
    rpc.set(getAssociatedTokenAddressSync(ZEC, reb, true), tokenAccount(ZEC, reb, 7n * ONE));
    const writes: unknown[][] = [];
    const db = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes("FROM pool_quotes")) return { rows: [{ mint: ZEC.toBase58() }] };
        writes.push(params);
        return { rows: [], rowCount: 1 };
      },
    };
    const w = new PoolQuoteInventoryWriter(db as never, "mainnet-beta", rpc.connection(), vaults, reb);
    const rows = await w.writeOnce();
    expect(rows).toEqual([{ quoteMint: ZEC.toBase58(), vaultAmount: 4n * ONE, reserveAmount: 7n * ONE, vaultCount: 3, slot: rpc.slot }]);
    expect(writes).toEqual([["mainnet-beta", ZEC.toBase58(), (4n * ONE).toString(), (7n * ONE).toString(), 3, rpc.slot]]);
  });
});

describe("Verify mint sources (RELAYER v8 A6)", () => {
  it("pool_quotes mints join the pinned ones; before core 0019 there are none; errors fail closed", async () => {
    const db = (exists: boolean) => ({
      query: async (sql: string) => (sql.includes("to_regclass") ? { rows: [{ ok: exists }] } : { rows: [{ mint: ZEC.toBase58() }] }),
    });
    const pinned = { mints: async () => ["M1", ZEC.toBase58()] };
    expect((await new AllMintSources([pinned, new PgPoolQuoteMintSource(db(true) as never, "mainnet-beta")]).mints()).sort()).toEqual(["M1", ZEC.toBase58()].sort());
    expect(await new PgPoolQuoteMintSource(db(false) as never, "mainnet-beta").mints()).toEqual([]);
    const broken = { mints: async () => Promise.reject(new Error("permission denied")) };
    await expect(new AllMintSources([pinned, broken]).mints()).rejects.toThrow(/permission/);
  });
});
