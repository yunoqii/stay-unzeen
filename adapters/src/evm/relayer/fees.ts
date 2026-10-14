import { randomInt } from "node:crypto";
import type { Pool } from "pg";
import { getAddress, type Address, type LocalAccount } from "viem";
import type { FeeSweepStore } from "../../relayer/fee-sweeper";
import type { EvmExecutor } from "../executor";
import type { EvmKeyring } from "../keys";
import type { PonsAdapter } from "../pons/adapter";
import { PonsFeeSweeper, type OwedStore, type PonsLaunchRef } from "../pons/creator";
import type { HoodNetworkId } from "./queue";

/**
 * Global creator-fee sweep of the hood instance (Solana parity:
 * relayer/fee-sweeper.ts). Runs on its own random schedule, never on a request.
 * Bookkeeping in core's `creator_fee_sweeps` (venue `pons`, kind `creator`):
 * a `sent` row with the creator -> vault transfer hash BEFORE broadcast
 * (`last_valid_block_height` = nonce, as in relayer_jobs), then `confirmed`
 * with the wei that reached the vault, or `failed`.
 */
export interface HoodFeeLoopOptions {
  pool: Pool;
  network: HoodNetworkId;
  store: FeeSweepStore;
  adapter: PonsAdapter;
  executor: EvmExecutor;
  keyring: EvmKeyring;
  vaults: LocalAccount[];
  /** Creator indexes ever allocated (file / Postgres counter). */
  creatorCount: () => Promise<number>;
  minCollectWei?: bigint;
  /** Claimed-not-forwarded fees (production: FileOwedStore in the keys dir). */
  owed?: OwedStore;
  /** Random interval between runs, ms. Default 6-12 h. */
  intervalMs?: [number, number];
  jitterMs?: [number, number];
}

export class HoodFeeLoop {
  private readonly sweeper: PonsFeeSweeper;
  private lastVault = -1;

  constructor(private readonly o: HoodFeeLoopOptions) {
    this.sweeper = new PonsFeeSweeper({
      adapter: o.adapter,
      executor: o.executor,
      keyring: o.keyring,
      pickVault: () => this.pickVault(),
      ...(o.minCollectWei !== undefined ? { minCollectWei: o.minCollectWei } : {}),
      ...(o.owed ? { owed: o.owed } : {}),
      ...(o.jitterMs ? { jitterMs: o.jitterMs } : {}),
      onTransferSigned: async (t, tx, _value, _vault) => {
        await o.store.recordSent({
          network: o.network as never,
          venue: "pons" as never,
          kind: "creator",
          mint: t.token,
          authority: t.creator,
          signature: tx.hash,
          lastValidBlockHeight: tx.nonce,
        });
      },
    });
  }

  /** Rotation: never the same vault twice in a row. */
  private pickVault(): LocalAccount {
    const n = this.o.vaults.length;
    let i = randomInt(n);
    if (n > 1 && i === this.lastVault) i = (i + 1 + randomInt(n - 1)) % n;
    this.lastVault = i;
    return this.o.vaults[i]!;
  }

  /** Pool launches: pinned mints of this network, mapped to the creator index by derivation. */
  async refs(): Promise<PonsLaunchRef[]> {
    const r = await this.o.pool.query<{ mint: string }>(`SELECT mint FROM mint_vaults WHERE network = $1`, [this.o.network]);
    const count = await this.o.creatorCount();
    const byCreator = new Map<string, number>();
    for (let i = 0; i < count; i++) byCreator.set(getAddress(this.o.keyring.account("creator", i).address), i);
    const out: PonsLaunchRef[] = [];
    for (const { mint } of r.rows) {
      const info = await this.o.adapter.launchInfo(mint as Address).catch(() => null);
      const idx = info ? byCreator.get(info.creatorFeeRecipient) : undefined;
      if (info && idx !== undefined) out.push({ creatorIndex: idx, token: info.token });
    }
    return out;
  }

  /** Resolves `sent` rows of earlier runs (restart). */
  async resolvePending(): Promise<number> {
    let n = 0;
    for (const row of await this.o.store.pending(this.o.network as never)) {
      let st: Awaited<ReturnType<EvmExecutor["lookup"]>>;
      try {
        st = await this.o.executor.lookup(row.signature as `0x${string}`);
      } catch {
        continue; // RPC error (429, timeout): never "not sent"; resolved on a later run (review-hood-final #1)
      }
      if (st.state === "landed") {
        if (st.receipt.status === "success") {
          const tx = await this.o.executor.read.getTransaction({ hash: st.receipt.transactionHash });
          const blk = await this.o.executor.read.getBlock({ blockNumber: st.receipt.blockNumber });
          await this.o.store.confirm(row.signature, tx.value, Number(st.receipt.blockNumber), Number(blk.timestamp));
        } else await this.o.store.fail(row.signature);
        n++;
      } else if (st.state === "unknown") {
        const used = await this.o.executor.read.getTransactionCount({ address: getAddress(row.authority), blockTag: "latest" });
        if (used > row.lastValidBlockHeight) {
          await this.o.store.fail(row.signature);
          n++;
        }
      }
    }
    return n;
  }

  /** One pass: resolve pending rows, sweep every target above threshold; counts only. */
  async runOnce(signal?: AbortSignal): Promise<{ swept: number; failed: number; collectedWei: bigint }> {
    await this.resolvePending();
    const { outcomes, failed } = await this.sweeper.runOnce(await this.refs(), signal);
    let swept = 0;
    let collectedWei = 0n;
    for (const o of outcomes) {
      const t = o.steps.find((s) => s.kind === "to_vault");
      if (!t) continue;
      const rc = await this.o.executor.read.getTransactionReceipt({ hash: t.hash });
      const blk = await this.o.executor.read.getBlock({ blockNumber: rc.blockNumber });
      await this.o.store.confirm(t.hash, t.value ?? 0n, Number(rc.blockNumber), Number(blk.timestamp));
      swept++;
      collectedWei += o.collected;
    }
    return { swept, failed, collectedWei };
  }

  async runForever(signal: AbortSignal, onError: (e: unknown) => void = () => undefined): Promise<void> {
    const [lo, hi] = this.o.intervalMs ?? [6 * 3600_000, 12 * 3600_000];
    while (!signal.aborted) {
      await this.runOnce(signal).catch(onError);
      await new Promise((r) => setTimeout(r, lo + randomInt(Math.max(1, hi - lo))));
    }
  }
}
