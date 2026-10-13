import type { Address } from "viem";

/**
 * Per-address async mutex + local nonce counter.
 *
 * Robinhood Chain (Arbitrum Nitro) has no public mempool: the sequencer either
 * accepts a transaction at once or rejects it, so stuck transactions /
 * replace-by-fee practically do not exist. The rules:
 * - every send from an address runs inside `withNonce(addr, fn)` (one at a time);
 * - the nonce comes from `eth_getTransactionCount(addr, "pending")` the first time
 *   and after any error, then a local counter;
 * - `fn` reports whether the tx reached the sequencer (`broadcast: true`), only
 *   then the counter advances; on `nonce too low` / `already known` / any error
 *   the cache is dropped and the next call re-reads the chain.
 *
 * In-process only. Several relayer processes must also hold the per-vault
 * Postgres advisory lock (as on Solana) around a send.
 */
export class NonceManager {
  private readonly next = new Map<string, number>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly fetchPending: (addr: Address) => Promise<number>) {}

  async withNonce<T>(addr: Address, fn: (nonce: number) => Promise<{ value: T; broadcast: boolean }>): Promise<T> {
    const key = addr.toLowerCase();
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => mine);
    this.locks.set(key, chained);
    await prev;
    try {
      let nonce = this.next.get(key);
      if (nonce === undefined) nonce = await this.fetchPending(addr);
      try {
        const { value, broadcast } = await fn(nonce);
        if (broadcast) this.next.set(key, nonce + 1);
        else this.next.set(key, nonce);
        return value;
      } catch (e) {
        // Unknown state (maybe broadcast, maybe not): re-read from the chain next time.
        this.next.delete(key);
        throw e;
      }
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  /** Drops the cached nonce of an address (after an external send, tests). */
  reset(addr?: Address): void {
    if (addr) this.next.delete(addr.toLowerCase());
    else this.next.clear();
  }

  /** Cached next nonce (tests / diagnostics). */
  peek(addr: Address): number | undefined {
    return this.next.get(addr.toLowerCase());
  }
}

export function isNonceError(message: string): boolean {
  return /nonce too low|nonce too high|already known|replacement transaction underpriced|invalid nonce/i.test(message);
}
