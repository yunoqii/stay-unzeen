import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/errors";
import { cryptoRng, seededRng } from "../../src/relayer/random";
import { VaultPool, VaultsBusyError, chooseVault } from "../../src/relayer/vaults";
import { FakeInventory, MINT, vaults } from "./fakes";

describe("chooseVault rotation", () => {
  it("never repeats the most recently used vault when >= 2 are eligible", () => {
    const rng = seededRng(1);
    const last = new Map<string, number>();
    const keys = ["a", "b", "c", "d"];
    let prev = "";
    const counts = new Map<string, number>();
    for (let t = 1; t <= 400; t++) {
      const pick = chooseVault(keys.map((k) => ({ key: k, lastUsed: last.get(k) })), rng);
      expect(pick.key).not.toBe(prev);
      prev = pick.key;
      last.set(pick.key, t);
      counts.set(pick.key, (counts.get(pick.key) ?? 0) + 1);
    }
    // every shard used, roughly evenly (no "one giant holder")
    for (const k of keys) expect(counts.get(k)!).toBeGreaterThan(60);
  });

  it("is not a fixed round-robin order", () => {
    const rng = seededRng(2);
    const last = new Map<string, number>();
    const keys = ["a", "b", "c", "d", "e", "f"];
    const seq: string[] = [];
    for (let t = 1; t <= 60; t++) {
      const p = chooseVault(keys.map((k) => ({ key: k, lastUsed: last.get(k) })), rng);
      last.set(p.key, t);
      seq.push(p.key);
    }
    const cycles = new Set<string>();
    for (let i = 0; i + 6 <= seq.length; i += 6) cycles.add(seq.slice(i, i + 6).join(""));
    expect(cycles.size).toBeGreaterThan(1);
  });

  it("works with the CSPRNG and a single vault", () => {
    expect(chooseVault([{ key: "only", lastUsed: 5 }], cryptoRng).key).toBe("only");
    expect(() => chooseVault([], cryptoRng)).toThrow();
  });
});

describe("VaultPool", () => {
  it("filters by SOL and token holdings, maps shortages to pool_liquidity", async () => {
    const inv = new FakeInventory();
    const [a, b] = vaults(2, inv);
    inv.sol.set(a!.publicKey.toBase58(), 100n);
    inv.sol.set(b!.publicKey.toBase58(), 5n);
    const pool = new VaultPool([a!, b!], inv, seededRng(3));
    const v = await pool.acquire({ minSol: 50n });
    expect(v.publicKey.equals(a!.publicKey)).toBe(true);
    pool.release(v);

    const e1 = await pool.acquire({ minSol: 1_000n }).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(AdapterError);
    expect((e1 as AdapterError).apiCode).toBe("pool_liquidity");

    const e2 = await pool.acquire({ minSol: 1n, mint: MINT, minTokens: 1n }).catch((e: unknown) => e);
    expect((e2 as AdapterError).code).toBe("insufficient_tokens");
    expect((e2 as AdapterError).apiCode).toBe("pool_liquidity");

    inv.tokens.set(`${b!.publicKey.toBase58()}:${MINT}`, 10n);
    const w = await pool.acquire({ minSol: 1n, mint: MINT, minTokens: 10n });
    expect(w.publicKey.equals(b!.publicKey)).toBe(true);
  });

  it("only: the pinned vault or nothing", async () => {
    const inv = new FakeInventory();
    const [a, b] = vaults(2, inv);
    inv.tokens.set(`${a!.publicKey.toBase58()}:${MINT}`, 100n);
    const pool = new VaultPool([a!, b!], inv, seededRng(4));
    const e = await pool
      .acquire({ minSol: 1n, mint: MINT, minTokens: 1n, only: b!.publicKey.toBase58() })
      .catch((x: unknown) => x);
    expect((e as AdapterError).apiCode).toBe("pool_liquidity");
    const v = await pool.acquire({ minSol: 1n, only: b!.publicKey.toBase58() });
    expect(v.publicKey.equals(b!.publicKey)).toBe(true);
    await expect(pool.acquire({ minSol: 1n, only: b!.publicKey.toBase58() })).rejects.toBeInstanceOf(VaultsBusyError);
  });

  it("keeps one in-flight job per vault", async () => {
    const inv = new FakeInventory();
    const [a] = vaults(1, inv);
    const pool = new VaultPool([a!], inv, seededRng(5));
    const v = await pool.acquire({ minSol: 1n });
    await expect(pool.acquire({ minSol: 1n })).rejects.toBeInstanceOf(VaultsBusyError);
    pool.release(v);
    await expect(pool.acquire({ minSol: 1n })).resolves.toBeTruthy();
  });
});
