import fs from "node:fs";
import path from "node:path";
import { NATIVE_MINT } from "@solana/spl-token";
import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { IntelIndexer, dbcLockedLpPct } from "../src/intel/indexer";
import { MemoryIntelStore } from "../src/intel/memory-store";
import type { ChainReader } from "../src/intel/reader";
import type { LargestAccount } from "../src/intel/metrics";
import { seededRng } from "../src/relayer/random";

/*
 * Indexer metrics for Meteora DBC launches (Unzeen's config). Account
 * fixtures: devnet 2026-10-12, mint 55JhCA… created by the relayer e2e
 * (pnpm relayer:devnet --venue meteora-dbc), public data.
 */

interface FxAcc {
  address: string;
  owner: string;
  lamports: number;
  data: string;
}
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "dbc-devnet-accounts.json"), "utf8")) as Record<"config" | "pool" | "mint", FxAcc>;
const acc = (f: FxAcc): AccountInfo<Buffer> => ({ data: Buffer.from(f.data, "base64"), owner: new PublicKey(f.owner), lamports: f.lamports, executable: false });
const CONFIG = new PublicKey(FX.config.address);
const MINT = FX.mint.address;
const CREATOR = "FM9w15GxuWsJNotautUP3rXu3v1n2jkGELMQMtkLkCuN";

class Reader implements ChainReader {
  readonly hasIndex = true;
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  readonly batches: string[][] = [];
  recent: string[] = [];
  async getMultipleAccounts(keys: readonly PublicKey[]) {
    this.batches.push(keys.map((k) => k.toBase58()));
    return keys.map((k) => this.accounts.get(k.toBase58()) ?? null);
  }
  async getTokenLargestAccounts(): Promise<LargestAccount[]> {
    return [];
  }
  async recentPumpMints() {
    return this.recent;
  }
}

function setup(dbcConfig: PublicKey | null) {
  const store = new MemoryIntelStore();
  const reader = new Reader();
  for (const f of [FX.config, FX.pool, FX.mint]) reader.accounts.set(f.address, acc(f));
  reader.recent = Array.from({ length: 20 }, () => Keypair.generate().publicKey.toBase58());
  store.enqueue(MINT);
  const idx = new IntelIndexer({ store, reader, sleep: noSleep, rng: seededRng(5), dbcConfig });
  return { store, reader, idx };
}

describe("intel: Meteora DBC launches", () => {
  it("venue meteora-dbc, on the curve, progress from the quote reserve, card with price", async () => {
    const { store, idx } = setup(CONFIG);
    await idx.tick();
    const row = store.safety.get(MINT)!;
    expect(row.market.venue).toBe("meteora-dbc");
    expect(row.market.status).toBe("curve");
    expect(Number(row.market.curveProgressPct)).toBeGreaterThanOrEqual(0);
    expect(Number(row.market.curveProgressPct)).toBeLessThan(1);
    expect(row.market.lpBurnedPct).toBeUndefined();
    expect(row.program).toBe("token-2022");
    expect(row.authorities.metadataImmutable).toBe(true); // config: TokenAuthorityOption.Immutable
    expect(row.symbol).toBe("UNZM");
    const card = store.cards.get(MINT)!;
    expect(card.venue).toBe("meteora-dbc");
    expect(card.status).toBe("curve");
    expect(Number(card.marketCapSol)).toBeGreaterThan(27);
    expect(Number(card.priceSol)).toBeGreaterThan(0);
  });

  it("T1: pool creator in the relayer's public creator list -> Unzeen launch, no dev", async () => {
    const { store, idx } = setup(CONFIG);
    store.creators.add(CREATOR);
    await idx.tick();
    const row = store.safety.get(MINT)!;
    expect(row.unzeen).toEqual({ launch: true });
    expect(row.holders?.devPct ?? null).toBeNull();
  });

  it("every mint of the batch (decoys too) gets the same DBC pool read", async () => {
    const { reader, idx } = setup(CONFIG);
    await idx.tick();
    const first = reader.batches[0]!;
    const mints = (first.length - 2) / 5;
    expect(Number.isInteger(mints)).toBe(true);
    expect(first[1]).toBe(CONFIG.toBase58());
    for (let i = 0; i < mints; i++) {
      const m = new PublicKey(first[2 + i * 5]!);
      expect(first[2 + i * 5 + 4]).toBe(deriveDbcPoolAddress(NATIVE_MINT, m, CONFIG).toBase58());
    }
  });

  it("without a DBC config the indexer keeps its pump.fun-only reads", async () => {
    const { store, reader, idx } = setup(null);
    await idx.tick();
    expect(reader.batches[0]!.includes(CONFIG.toBase58())).toBe(false);
    expect(store.safety.get(MINT)!.market.venue).toBeNull();
    expect(store.cards.get(MINT)!.venue).toBe("jupiter");
  });

  it("graduated DBC pools report the permanently locked LP share from the config", () => {
    expect(dbcLockedLpPct({ partnerPermanentLockedLiquidityPercentage: 50, creatorPermanentLockedLiquidityPercentage: 50 })).toBe("100.00");
    expect(dbcLockedLpPct({ partnerPermanentLockedLiquidityPercentage: 10, creatorPermanentLockedLiquidityPercentage: 0 })).toBe("10.00");
  });
});

const noSleep = async (): Promise<void> => undefined;
