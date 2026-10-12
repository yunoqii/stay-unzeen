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
 * When each vault was last used (rotation). Implementations: memory (tests),
 * derived from `relayer_jobs.vault` (Postgres, no extra table), or the
 * proposed `relayer_vault_usage` table (see postgres-vaults.ts).
 */
export interface VaultUsage {
  /** unix ms of the last use per vault; vaults never used are absent. */
  lastUsed(vaults: readonly string[]): Promise<Map<string, number>>;
  touch(vault: string, at: number): Promise<void>;
}

export class MemoryVaultUsage implements VaultUsage {
  private readonly m = new Map<string, number>();
  async lastUsed(vaults: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const v of vaults) {
      const t = this.m.get(v);
      if (t !== undefined) out.set(v, t);
    }
    return out;
  }
  async touch(vault: string, at: number): Promise<void> {
    this.m.set(vault, Math.max(at, this.m.get(vault) ?? 0));
  }
}

/** Exclusive right to send transactions from one vault. */
export interface VaultLease {
  release(): Promise<void>;
}

/**
 * "One transaction in flight per vault" (review-day3 N1: balance checks of
 * concurrent jobs on one vault race). Memory: one process. Postgres advisory
 * locks: all relayer processes (postgres-vaults.ts).
 */
export interface VaultLock {
  /** Takes the lock of `vault` or returns null when someone else holds it. Never waits. */
  tryAcquire(vault: string): Promise<VaultLease | null>;
}

export class MemoryVaultLock implements VaultLock {
  private readonly held = new Set<string>();
  async tryAcquire(vault: string): Promise<VaultLease | null> {
    if (this.held.has(vault)) return null;
    this.held.add(vault);
    let done = false;
    return {
      release: async () => {
        if (done) return;
        done = true;
        this.held.delete(vault);
      },
    };
  }
}

export interface VaultRequest {
  /** Lamports the vault must hold (trade + rent + fees). */
  minSol: bigint;
  /** When set, the vault must hold at least `minTokens` of this mint. */
  mint?: string;
  minTokens?: bigint;
  /**
   * The only vault allowed: the vault the mint is pinned to (D4: one position
   * per mint on one vault). Busy -> VaultsBusyError (retry), short of SOL /
   * tokens -> pool_liquidity.
   */
  only?: string;
  /**
   * Choosing a vault for a NEW mint: mints already pinned per vault. Vaults
   * at or below the median load are preferred (then LRU rotation).
   */
  load?: ReadonlyMap<string, number>;
}

/**
 * Rotation among eligible vaults: take the least-recently-used half (at least
 * one), pick uniformly at random inside it. With >= 2 eligible vaults the
 * most recently used one is never picked, and every vault keeps being used,
 * so there is no single "giant holder" and no fixed order to learn.
 */
export function chooseVault<T extends { key: string; lastUsed: number | undefined }>(eligible: readonly T[], rng: Rng): T {
  const order = rotationOrder(eligible, rng);
  if (order.length === 0) throw new RangeError("no eligible vault");
  return order[0]!;
}

/**
 * Full try-order behind `chooseVault`: a random member of the LRU half first,
 * then the rest of that half in random order, then the more recently used
 * ones from oldest to newest (used only when the better ones are locked).
 */
export function rotationOrder<T extends { key: string; lastUsed: number | undefined }>(eligible: readonly T[], rng: Rng): T[] {
  // Shuffle first so ties (e.g. never used) are broken randomly, then stable sort by age.
  const shuffled = [...eligible];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  shuffled.sort((a, b) => (a.lastUsed ?? -1) - (b.lastUsed ?? -1)); // never used = oldest
  const k = Math.max(1, Math.ceil(shuffled.length / 2));
  const head = shuffled.slice(0, k);
  const first = rng.int(0, Math.max(0, head.length - 1));
  const rest = head.filter((_, i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  return [...(head.length ? [head[first]!] : []), ...rest, ...shuffled.slice(k)];
}

/** Least loaded vaults (load at or below the median). */
export function leastLoaded(keys: readonly string[], load: ReadonlyMap<string, number>): Set<string> {
  if (keys.length === 0) return new Set();
  const sorted = [...keys].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0));
  const median = load.get(sorted[Math.floor((sorted.length - 1) / 2)]!) ?? 0;
  return new Set(sorted.filter((k) => (load.get(k) ?? 0) <= median));
}

/** Thrown when every eligible vault is busy with another job (retry soon). */
export class VaultsBusyError extends Error {
  constructor() {
    super("all eligible vaults are busy");
    this.name = "VaultsBusyError";
  }
}

/**
 * The pool's Solana vault shards. Picks a vault per job (pinned vault of the
 * mint, or rotation + least loaded for a new mint; balance filter) and holds
 * a VaultLock on it until `release`, so a vault never has two transactions
 * in flight.
 */
export class VaultPool {
  private readonly byKey: Map<string, Signer>;
  private readonly leases = new Map<string, VaultLease>();
  private readonly usage: VaultUsage;
  private readonly lock: VaultLock;

  constructor(
    vaults: readonly Signer[],
    private readonly inventory: VaultInventory,
    private readonly rng: Rng,
    opts: { usage?: VaultUsage; lock?: VaultLock } = {},
  ) {
    if (vaults.length === 0) throw new Error("vault pool is empty");
    this.byKey = new Map(vaults.map((v) => [v.publicKey.toBase58(), v]));
    this.usage = opts.usage ?? new MemoryVaultUsage();
    this.lock = opts.lock ?? new MemoryVaultLock();
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
   * Picks and locks a vault for `req`. Release it with `release()`.
   * Throws AdapterError `insufficient_sol` / `insufficient_tokens` (API
   * `pool_liquidity`) when no vault qualifies, VaultsBusyError when all
   * qualifying vaults are locked.
   */
  async acquire(req: VaultRequest): Promise<Signer> {
    let candidates = [...this.byKey.keys()];
    if (req.only !== undefined) {
      if (!this.byKey.has(req.only)) throw new AdapterError("internal", "pinned vault is not in the pool");
      candidates = [req.only];
    }
    const needTokens = req.mint !== undefined && req.minTokens !== undefined;
    const balances = await Promise.all(
      candidates.map(async (k) => {
        const pk = new PublicKey(k);
        const [sol, tok] = await Promise.all([
          this.inventory.solBalance(pk),
          needTokens ? this.inventory.tokenBalance(pk, req.mint!) : 0n,
        ]);
        return { key: k, sol, tok };
      }),
    );
    const withTokens = needTokens ? balances.filter((b) => b.tok >= req.minTokens!) : balances;
    if (withTokens.length === 0) {
      throw new AdapterError("insufficient_tokens", "no vault holds enough of this token");
    }
    const eligible = withTokens.filter((b) => b.sol >= req.minSol);
    if (eligible.length === 0) {
      throw new AdapterError("insufficient_sol", "no vault has enough SOL");
    }
    const last = await this.usage.lastUsed(eligible.map((b) => b.key));
    const withAge = eligible.map((b) => ({ key: b.key, lastUsed: last.get(b.key) }));
    let order: { key: string }[];
    if (req.load) {
      const preferred = leastLoaded(withAge.map((v) => v.key), req.load);
      order = [
        ...rotationOrder(withAge.filter((v) => preferred.has(v.key)), this.rng),
        ...rotationOrder(withAge.filter((v) => !preferred.has(v.key)), this.rng),
      ];
    } else {
      order = rotationOrder(withAge, this.rng);
    }
    for (const { key } of order) {
      if (this.leases.has(key)) continue;
      const lease = await this.lock.tryAcquire(key);
      if (!lease) continue;
      this.leases.set(key, lease);
      return this.byKey.get(key)!;
    }
    throw new VaultsBusyError();
  }

  /** Marks a vault as used now (call when a tx from it is broadcast). */
  async markUsed(vault: string, at: number): Promise<void> {
    await this.usage.touch(vault, at);
  }

  async release(vault: Signer | string): Promise<void> {
    const key = typeof vault === "string" ? vault : vault.publicKey.toBase58();
    const lease = this.leases.get(key);
    this.leases.delete(key);
    await lease?.release();
  }

  /**
   * Locks a specific vault (internal transfers of the shard balancer).
   * Null when it is busy.
   */
  async lockVault(key: string): Promise<Signer | null> {
    const signer = this.byKey.get(key);
    if (!signer || this.leases.has(key)) return null;
    const lease = await this.lock.tryAcquire(key);
    if (!lease) return null;
    this.leases.set(key, lease);
    return signer;
  }
}
