import { PublicKey, type Connection, type Signer } from "@solana/web3.js";
import { AdapterError } from "../errors";
import type { Rng } from "./random";

/** Balances of pool vaults (RPC in production, fakes in tests). */
export interface VaultInventory {
  solBalance(vault: PublicKey): Promise<bigint>;
  /** Total of all token accounts of `vault` for `mint`, base units. */
  tokenBalance(vault: PublicKey, mint: string): Promise<bigint>;
}

export class RpcVaultInventory implements VaultInventory {
  constructor(private readonly connection: Connection) {}

  async solBalance(vault: PublicKey): Promise<bigint> {
    return BigInt(await this.connection.getBalance(vault, "confirmed"));
  }

  async tokenBalance(vault: PublicKey, mint: string): Promise<bigint> {
    // Works for both SPL Token and Token-2022 (filter by mint, any program).
    const res = await this.connection.getParsedTokenAccountsByOwner(vault, { mint: new PublicKey(mint) }, "confirmed");
    let sum = 0n;
    for (const a of res.value) {
      const amount = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info
        ?.tokenAmount?.amount;
      if (amount) sum += BigInt(amount);
    }
    return sum;
  }
}

/**
 * When each vault was last used. In memory for now; a Postgres table later so
 * rotation survives restarts and several relayer processes.
 */
export interface VaultUsage {
  lastUsed(vault: string): number | undefined;
  touch(vault: string, at: number): void;
}

export class MemoryVaultUsage implements VaultUsage {
  private readonly m = new Map<string, number>();
  lastUsed(vault: string): number | undefined {
    return this.m.get(vault);
  }
  touch(vault: string, at: number): void {
    this.m.set(vault, at);
  }
}

export interface VaultRequest {
  /** Lamports the vault must hold (trade + rent + fees). */
  minSol: bigint;
  /** When set, the vault must hold at least `minTokens` of this mint. */
  mint?: string;
  minTokens?: bigint;
  /** Hard exclusion (withdraw: vaults that bought for the user). */
  avoid?: readonly string[];
}

/**
 * Rotation among eligible vaults: take the least-recently-used half (at least
 * one), pick uniformly at random inside it. With >= 2 eligible vaults the
 * most recently used one is never picked, and every vault keeps being used,
 * so there is no single "giant holder" and no fixed order to learn.
 */
export function chooseVault<T extends { key: string; lastUsed: number | undefined }>(eligible: readonly T[], rng: Rng): T {
  if (eligible.length === 0) throw new RangeError("no eligible vault");
  // Shuffle first so ties (e.g. never used) are broken randomly, then stable sort by age.
  const shuffled = [...eligible];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  shuffled.sort((a, b) => (a.lastUsed ?? -1) - (b.lastUsed ?? -1)); // never used = oldest
  const k = Math.max(1, Math.ceil(shuffled.length / 2));
  return shuffled[rng.int(0, k - 1)]!;
}

/** Thrown when every eligible vault is busy with another job (retry soon). */
export class VaultsBusyError extends Error {
  constructor() {
    super("all eligible vaults are busy");
    this.name = "VaultsBusyError";
  }
}

/**
 * The pool's Solana vault shards. Picks a vault per job (rotation + balance
 * filter + exclusions) and keeps one in-flight job per vault in this process.
 */
export class VaultPool {
  private readonly byKey: Map<string, Signer>;
  private readonly busy = new Set<string>();

  constructor(
    vaults: readonly Signer[],
    private readonly inventory: VaultInventory,
    private readonly rng: Rng,
    private readonly usage: VaultUsage = new MemoryVaultUsage(),
  ) {
    if (vaults.length === 0) throw new Error("vault pool is empty");
    this.byKey = new Map(vaults.map((v) => [v.publicKey.toBase58(), v]));
  }

  keys(): string[] {
    return [...this.byKey.keys()];
  }

  get(key: string): Signer | undefined {
    return this.byKey.get(key);
  }

  isVault(address: string): boolean {
    return this.byKey.has(address);
  }

  /**
   * Picks and reserves a vault for `req`. Release it with `release()`.
   * Throws AdapterError `insufficient_sol` / `insufficient_tokens` (API
   * `pool_liquidity`) when no vault qualifies, VaultsBusyError when all
   * qualifying vaults are in use.
   */
  async acquire(req: VaultRequest): Promise<Signer> {
    const avoid = new Set(req.avoid ?? []);
    const candidates = [...this.byKey.keys()].filter((k) => !avoid.has(k));
    if (candidates.length === 0) {
      throw new AdapterError("insufficient_tokens", "no vault left after exclusions");
    }
    const balances = await Promise.all(
      candidates.map(async (k) => {
        const pk = new PublicKey(k);
        const [sol, tok] = await Promise.all([
          this.inventory.solBalance(pk),
          req.mint !== undefined && req.minTokens !== undefined ? this.inventory.tokenBalance(pk, req.mint) : 0n,
        ]);
        return { key: k, sol, tok };
      }),
    );
    const needTokens = req.mint !== undefined && req.minTokens !== undefined;
    const withTokens = needTokens ? balances.filter((b) => b.tok >= req.minTokens!) : balances;
    if (withTokens.length === 0) {
      throw new AdapterError("insufficient_tokens", "no vault holds enough of this token");
    }
    const eligible = withTokens.filter((b) => b.sol >= req.minSol);
    if (eligible.length === 0) {
      throw new AdapterError("insufficient_sol", "no vault has enough SOL");
    }
    const free = eligible.filter((b) => !this.busy.has(b.key));
    if (free.length === 0) throw new VaultsBusyError();
    const pick = chooseVault(
      free.map((b) => ({ key: b.key, lastUsed: this.usage.lastUsed(b.key) })),
      this.rng,
    );
    this.busy.add(pick.key);
    return this.byKey.get(pick.key)!;
  }

  /** Marks a vault as used now (call when a tx from it is broadcast). */
  markUsed(vault: string, at: number): void {
    this.usage.touch(vault, at);
  }

  release(vault: Signer): void {
    this.busy.delete(vault.publicKey.toBase58());
  }
}
