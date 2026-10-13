import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/errors";
import { Relayer } from "../../src/relayer/engine";
import { VenueTradeExecutor, type TradeVenue } from "../../src/relayer/executors";
import { InMemoryJobQueue } from "../../src/relayer/memory-queue";
import { seededRng } from "../../src/relayer/random";
import type { JobSpec } from "../../src/relayer/types";
import { VaultPool, type VaultRequest } from "../../src/relayer/vaults";
import { FakeChain, FakeExecutor, FakeInventory, MINT, vaults } from "./fakes";

/* RELAYER v8 A3: ZEC SPL is stock-only -> a ZEC buy / create is placed by quote STOCK, not SOL. */
const ZEC = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";

describe("vault choice by ZEC SPL stock", () => {
  function pool() {
    const inv = new FakeInventory();
    const vs = vaults(4, inv);
    // vault 0: lots of SOL, no ZEC; vault 1: 0.5 ZEC; vault 2: 3 ZEC; vault 3: 3 ZEC but no SOL
    inv.tokens.set(`${vs[1]!.publicKey.toBase58()}:${ZEC}`, 50_000_000n);
    inv.tokens.set(`${vs[2]!.publicKey.toBase58()}:${ZEC}`, 300_000_000n);
    inv.tokens.set(`${vs[3]!.publicKey.toBase58()}:${ZEC}`, 300_000_000n);
    inv.sol.set(vs[3]!.publicKey.toBase58(), 0n);
    return { inv, vs, p: new VaultPool(vs, inv, seededRng(5)) };
  }

  it("only a vault holding the units (and SOL for fees) is taken", async () => {
    const { vs, p } = pool();
    for (let i = 0; i < 10; i++) {
      const v = await p.acquire({ minSol: 5_000_000n, quote: { mint: ZEC, minUnits: 100_000_000n } });
      expect(v.publicKey.equals(vs[2]!.publicKey)).toBe(true);
      await p.release(v);
    }
  });

  it("no vault with enough stock -> insufficient_sol (API pool_liquidity); pinned vault short -> same", async () => {
    const { vs, p } = pool();
    await expect(p.acquire({ minSol: 1n, quote: { mint: ZEC, minUnits: 400_000_000n } })).rejects.toMatchObject({ code: "insufficient_sol" });
    await expect(p.acquire({ minSol: 1n, quote: { mint: ZEC, minUnits: 100_000_000n }, only: vs[1]!.publicKey.toBase58() })).rejects.toBeInstanceOf(AdapterError);
  });

  it("executor: ZEC buy / create ask for stock (SOL only for fees); priced and SOL pairs keep the SOL request", async () => {
    const venue = {
      quotePairOf: async (mint: string) => (mint === "zecMint" ? { quoteMint: ZEC, stockOnly: true } : mint === "usdcMint" ? { quoteMint: "USDC", stockOnly: false } : null),
      quotePairFor: (s: string) => (s === "ZEC" ? { quoteMint: ZEC, stockOnly: true } : null),
    } as unknown as TradeVenue;
    const ex = new VenueTradeExecutor(venue, null);
    expect(await ex.vaultRequestAsync({ kind: "buy", venue: "pumpfun", mint: "zecMint", lamportsIn: 30_000_000n, minOut: 1n })).toEqual({ minSol: 5_000_000n, quote: { mint: ZEC, minUnits: 30_000_000n } });
    expect(await ex.vaultRequestAsync({ kind: "buy", venue: "pumpfun", mint: "usdcMint", lamportsIn: 30_000_000n, minOut: 1n })).toBeNull();
    expect(await ex.vaultRequestAsync({ kind: "buy", venue: "pumpfun", mint: "solMint", lamportsIn: 30_000_000n, minOut: 1n })).toBeNull();
    expect(await ex.vaultRequestAsync({ kind: "create", venue: "raydium-launchlab", meta: { name: "N", symbol: "S" }, lamportsIn: 20_000_000n, minOut: 0n, quote: "ZEC" })).toEqual({ minSol: 35_000_000n, quote: { mint: ZEC, minUnits: 20_000_000n } });
    expect(await ex.vaultRequestAsync({ kind: "create", venue: "raydium-launchlab", meta: { name: "N", symbol: "S" }, lamportsIn: 20_000_000n, minOut: 0n })).toBeNull();
  });

  it("engine uses the async request: a 3 ZEC buy lands on the only vault with the stock", async () => {
    class ZecExecutor extends FakeExecutor {
      async vaultRequestAsync(spec: JobSpec): Promise<VaultRequest | null> {
        return spec.kind === "buy" ? { minSol: 1n, quote: { mint: ZEC, minUnits: spec.lamportsIn } } : null;
      }
    }
    const { vs, inv } = pool();
    const chain = new FakeChain();
    const ex = new ZecExecutor(chain);
    const queue = new InMemoryJobQueue(seededRng(2));
    const r = new Relayer({ queue, pool: new VaultPool(vs, inv, seededRng(2)), executors: { trade: { pumpfun: ex }, withdraw: ex }, probe: chain });
    const j = queue.enqueue({ kind: "buy", venue: "pumpfun", mint: MINT, lamportsIn: 200_000_000n, minOut: 1n }, { notBefore: 0 });
    await r.tick();
    expect(queue.get(j.id)!.attempts[0]!.vault).toBe(vs[2]!.publicKey.toBase58());
    const k = queue.enqueue({ kind: "buy", venue: "pumpfun", mint: Keypair.generate().publicKey.toBase58(), lamportsIn: 900_000_000n, minOut: 1n }, { notBefore: 0 });
    await r.tick();
    // pool_liquidity is transient: retried (fund_quote may refill the stock), failed after maxClaims.
    expect(queue.get(k.id)!.result).toMatchObject({ code: "pool_liquidity" });
    expect(["retry", "failed"]).toContain(queue.get(k.id)!.result!.status);
  });
});
