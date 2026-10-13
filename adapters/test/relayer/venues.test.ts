import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { AdapterError } from "../../src/errors";
import { Relayer } from "../../src/relayer/engine";
import { VenueTradeExecutor, type TradeVenue } from "../../src/relayer/executors";
import { InMemoryJobQueue } from "../../src/relayer/memory-queue";
import { MemoryMintVaults } from "../../src/relayer/mint-vaults";
import { seededRng } from "../../src/relayer/random";
import type { JobSpec } from "../../src/relayer/types";
import { VaultPool } from "../../src/relayer/vaults";
import type { MetadataStore } from "../../src/metadata";
import { FakeChain, FakeClock, FakeExecutor, FakeInventory, MINT, vaults } from "./fakes";

function setup(trade: Record<string, FakeExecutor>, chain: FakeChain) {
  const clock = new FakeClock(1_700_000_000_000, chain);
  const rng = seededRng(11);
  const inv = new FakeInventory();
  const vs = vaults(3, inv);
  const queue = new InMemoryJobQueue(rng);
  const mintVaults = new MemoryMintVaults();
  const withdraw = new FakeExecutor(chain);
  const relayer = new Relayer({
    queue,
    pool: new VaultPool(vs, inv, rng),
    executors: { trade, withdraw },
    probe: chain,
    mintVaults,
    clock,
    rng,
  });
  const add = (spec: JobSpec, ex?: FakeExecutor) => {
    const j = queue.enqueue(spec, { notBefore: clock.now() });
    if (ex) ex.sentRecorded = (sig) => queue.get(j.id)!.attempts.some((a) => a.signature === sig);
    return j.id;
  };
  return { relayer, queue, mintVaults, add, inv, vs };
}

describe("relayer: venue meteora-dbc", () => {
  it("routes meteora-dbc jobs to their executor, one vault per mint like pump.fun", async () => {
    const chain = new FakeChain();
    const pump = new FakeExecutor(chain);
    const dbc = new FakeExecutor(chain);
    const t = setup({ pumpfun: pump, "meteora-dbc": dbc }, chain);
    const create = t.add({ kind: "create", venue: "meteora-dbc", meta: { name: "N", symbol: "S" }, lamportsIn: 1_000n, minOut: 0n }, dbc);
    expect(await t.relayer.tick()).toBe(true);
    expect(t.queue.get(create)!.state).toBe("executed");
    expect(dbc.prepared).toHaveLength(1);
    expect(pump.prepared).toHaveLength(0);
    // the new mint was pinned to the creating vault before sending
    const mint = "NewMint1";
    const pinned = await t.mintVaults.get(mint);
    expect(pinned).toBe(dbc.prepared[0]!.vault);

    const buy = t.add({ kind: "buy", venue: "meteora-dbc", mint, lamportsIn: 1_000n, minOut: 1n }, dbc);
    await t.relayer.tick();
    expect(t.queue.get(buy)!.state).toBe("executed");
    expect(dbc.prepared[1]!.vault).toBe(pinned);
    expect(pump.prepared).toHaveLength(0);
  });

  it("a venue this relayer does not serve fails at once (venue_unavailable), nothing is signed", async () => {
    const chain = new FakeChain();
    const pump = new FakeExecutor(chain);
    const t = setup({ pumpfun: pump }, chain);
    const id = t.add({ kind: "buy", venue: "meteora-dbc", mint: MINT, lamportsIn: 1_000n, minOut: 1n });
    expect(await t.relayer.tick()).toBe(true);
    const j = t.queue.get(id)!;
    expect(j.state).toBe("failed");
    expect(j.result).toMatchObject({ status: "failed", code: "venue_unavailable" });
    expect(j.attempts).toHaveLength(0);
    expect(pump.prepared).toHaveLength(0);
  });
});

describe("VenueTradeExecutor (any bonding-curve venue)", () => {
  const vault = Keypair.generate();
  function fakeVenue(log: string[]): TradeVenue {
    const signed = { signature: "sigX", raw: new Uint8Array([1]), blockhash: "bh", lastValidBlockHeight: 10 };
    return {
      prepareBuy: async () => ({ ...signed, kind: "buy", mint: MINT, vault: vault.publicKey.toBase58(), expectedOut: 1n }),
      prepareSell: async () => ({ ...signed, kind: "sell", mint: MINT, vault: vault.publicKey.toBase58(), expectedOut: 1n }),
      prepareCreate: async (meta) => {
        log.push(`create uri=${meta.uri}`);
        return { ...signed, kind: "create", mint: "M", vault: vault.publicKey.toBase58(), creator: "C", creatorIndex: 4, expectedOut: 0n };
      },
      submit: async () => undefined,
      createResult: async () => ({
        venue: "meteora-dbc",
        kind: "create",
        signature: "sigX",
        slot: 5,
        mint: "M",
        vault: vault.publicKey.toBase58(),
        creator: "C",
        name: "N",
        symbol: "S",
        uri: "u",
        tokenProgram: "T",
        tokenAmount: 7n,
        solAmount: 9n,
        networkFee: 5_000n,
        decimals: 6,
        amountsKnown: true,
      }),
      tradeResult: async () => ({ venue: "meteora-dbc", kind: "buy", signature: "sigX", slot: 5, mint: MINT, vault: "v", tokenAmount: 0n, solAmount: 0n, networkFee: 0n, decimals: 6, amountsKnown: false }),
      market: async () => ({ priceSol: "0.00000003", marketCapSol: "28", status: "curve" }),
      tokenSymbol: async () => "S",
      classify: (e) => (e instanceof AdapterError ? e : new AdapterError("internal", String(e))),
    };
  }

  it("create: publishes the sanitized metadata first, signs with its URI, reports the public token row", async () => {
    const log: string[] = [];
    const store: MetadataStore = {
      publish: async (m) => {
        log.push(`publish ${m.name}`);
        return { uri: "https://media/x.json", imageUrl: "https://media/x.png" } as Awaited<ReturnType<MetadataStore["publish"]>>;
      },
    };
    const ex = new VenueTradeExecutor(fakeVenue(log), store);
    const spec: JobSpec = { kind: "create", venue: "meteora-dbc", meta: { name: "N", symbol: "S", image: "data:image/png;base64,AA==" }, lamportsIn: 9n, minOut: 0n };
    await ex.prepare(spec, vault);
    expect(log).toEqual(["publish N", "create uri=https://media/x.json"]);
    const r = await ex.result(spec, { signature: "sigX", lastValidBlockHeight: 10, vault: vault.publicKey.toBase58(), sentAt: 0 });
    expect(r).toMatchObject({ kind: "create", mint: "M", creator: "C", tokenAmount: 7n, solAmount: 9n, imageUrl: "https://media/x.png", market: { marketCapSol: "28" } });
  });

  it("create without a metadata store fails venue_unavailable (never an empty uri)", async () => {
    const ex = new VenueTradeExecutor(fakeVenue([]), null);
    await expect(ex.prepare({ kind: "create", venue: "meteora-dbc", meta: { name: "N", symbol: "S" }, lamportsIn: 0n, minOut: 0n }, vault)).rejects.toMatchObject({ code: "venue_unavailable" });
  });

  it("landed trade with unreadable amounts -> null (retry later), never zeros", async () => {
    const ex = new VenueTradeExecutor(fakeVenue([]), null);
    const r = await ex.result({ kind: "buy", venue: "meteora-dbc", mint: MINT, lamportsIn: 1n, minOut: 1n }, { signature: "sigX", lastValidBlockHeight: 10, vault: "v", sentAt: 0 });
    expect(r).toBeNull();
  });

  it("ZEC pair (stock-only): buy/sell carry quote units + lamportsByCore (out_lamports NULL), market carries priceQuote", async () => {
    const ZEC = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
    const venue: TradeVenue = {
      ...fakeVenue([]),
      tradeResult: async (kind) => ({ venue: "raydium-launchlab", kind, signature: "sigZ", slot: 6, mint: MINT, vault: "v", tokenAmount: 1_000n, solAmount: 0n, networkFee: 5_000n, decimals: 6, amountsKnown: true, quoteMint: ZEC, quoteAmount: 30_000_000n, lamportsByCore: true }),
      market: async () => ({ priceSol: "0", marketCapSol: "0", status: "curve", priceQuote: "0.0000002" }),
    };
    const ex = new VenueTradeExecutor(venue, null);
    for (const kind of ["buy", "sell"] as const) {
      const spec = kind === "buy" ? ({ kind, venue: "raydium-launchlab", mint: MINT, lamportsIn: 30_000_000n, minOut: 1n } as const) : ({ kind, venue: "raydium-launchlab", mint: MINT, amount: 1_000n, minLamports: 1n } as const);
      const r = await ex.result(spec, { signature: "sigZ", lastValidBlockHeight: 10, vault: "v", sentAt: 0 });
      expect(r).toMatchObject({ kind, solAmount: 0n, quoteMint: ZEC, quoteAmount: 30_000_000n, lamportsByCore: true, market: { priceQuote: "0.0000002" } });
    }
  });
});
