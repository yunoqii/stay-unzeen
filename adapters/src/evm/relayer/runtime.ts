import { randomInt } from "node:crypto";
import path from "node:path";
import type { Pool } from "pg";
import { getAddress, type LocalAccount } from "viem";
import { FileCreatorIndexCounter } from "../../keys";
import { PgFeeSweepStore } from "../../relayer/fee-sweeper";
import { PgMintVaults } from "../../relayer/mint-vaults";
import { PgAdvisoryVaultLock } from "../../relayer/postgres-vaults";
import type { HoodConfig } from "../chain";
import type { EvmExecutor } from "../executor";
import type { EvmKeyring } from "../keys";
import type { PonsAdapter } from "../pons/adapter";
import { EvmWithdrawer } from "../withdraw";
import { HoodRelayer, type HoodRelayerEvent } from "./engine";
import { HoodFeeLoop } from "./fees";
import { FunderPool } from "../funders";
import { hoodPoolMints, hoodSnapshotSigners, hoodSnapshotTick, readInventory, writeInventory, writePonsLaunchCurve } from "./pool-state";
import { FileLaunchStore, type LaunchStore } from "./launches";
import { PgHoodQueue, type HoodNetworkId } from "./queue";

/**
 * Wiring of the hood relayer process: queue + engine (3 lanes) + background fee
 * cache + global creator-fee loop + restart reconcile of pending launches.
 * Logs: counts only.
 */
export interface HoodRuntimeOptions {
  cfg: HoodConfig;
  db: Pool;
  /** Dedicated pool for advisory locks (one connection per held lock). */
  lockDb: Pool;
  executor: EvmExecutor;
  adapter: PonsAdapter;
  keyring: EvmKeyring;
  vaultCount: number;
  launches?: LaunchStore;
  publishImage?: (dataUrl: string) => Promise<string | null>;
  log?: (m: string) => void;
  onEvent?: (e: HoodRelayerEvent) => void;
  feeLoop?: boolean;
  /** Funders in rotation (must match the adapter's FunderPool). Default 8. */
  funderCount?: number;
}

export function hoodNetworkId(cfg: HoodConfig): HoodNetworkId {
  return cfg.network === "mainnet" ? "hood" : "hood-testnet";
}

export function buildHoodRelayer(o: HoodRuntimeOptions): { relayer: HoodRelayer; fees: HoodFeeLoop; vaults: LocalAccount[] } {
  const network = hoodNetworkId(o.cfg);
  const vaults = Array.from({ length: o.vaultCount }, (_, i) => o.keyring.vault(i));
  const pool = new Set([...vaults.map((v) => getAddress(v.address)), ...Array.from({ length: o.funderCount ?? 8 }, (_, i) => getAddress(o.keyring.funder(i).address)), getAddress(o.keyring.rebalance().address), getAddress(o.keyring.attest("verify").address), getAddress(o.keyring.attest("fair").address)]);
  const relayer = new HoodRelayer({
    queue: new PgHoodQueue(o.db, network),
    adapter: o.adapter,
    executor: o.executor,
    keyring: o.keyring,
    vaults,
    mintVaults: new PgMintVaults(o.db, network as never),
    lock: new PgAdvisoryVaultLock(o.lockDb, network as never),
    launches: o.launches ?? FileLaunchStore.inDir(o.cfg.keysDir),
    withdrawer: new EvmWithdrawer({ executor: o.executor, isPoolAddress: (a) => pool.has(getAddress(a)) }),
    ...(o.publishImage ? { publishImage: o.publishImage } : {}),
    ...(o.onEvent ? { onEvent: o.onEvent } : {}),
  });
  const counter = new FileCreatorIndexCounter(path.join(o.cfg.keysDir, "creator-counter.json"));
  const fees = new HoodFeeLoop({
    pool: o.db,
    network,
    store: new PgFeeSweepStore(o.db),
    adapter: o.adapter,
    executor: o.executor,
    keyring: o.keyring,
    vaults,
    creatorCount: async () => counter.peek(),
  });
  return { relayer, fees, vaults };
}

/** `fn` now, then every [lo, hi] ms (random) until `signal` aborts; errors -> onError. */
async function every(signal: AbortSignal, lo: number, hi: number, fn: () => Promise<unknown>, onError: () => void): Promise<void> {
  while (!signal.aborted) {
    await fn().catch(onError);
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, lo + randomInt(Math.max(1, hi - lo)));
      function done() {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
  }
}

/**
 * Starts everything; resolves when `signal` aborts:
 * relayer lanes, fee cache, creator-fee loop, launch_curves (start + 10 min),
 * pool_sol_inventory (~5 min), Verify snapshot poll (1–2 s), funder top-ups from
 * the rebalance address (1–3 h).
 */
export async function runHoodRelayer(o: HoodRuntimeOptions, signal: AbortSignal): Promise<void> {
  const log = o.log ?? (() => undefined);
  const network = hoodNetworkId(o.cfg);
  const { relayer, fees, vaults } = buildHoodRelayer(o);
  const funderCount = o.funderCount ?? 8;
  const funders = new FunderPool({ executor: o.executor, keyring: o.keyring, count: funderCount });
  const counter = new FileCreatorIndexCounter(path.join(o.cfg.keysDir, "creator-counter.json"));
  o.executor.fees.start(10 * 60_000, () => log("hood fee cache refresh failed"));
  const rec = await relayer.reconcileLaunches();
  log(`hood launches reconciled: kept=${rec.kept} dropped=${rec.dropped} refunded=${rec.refunded} orphan=${rec.orphanLaunches}`);
  const errs = (what: string) => () => log(`hood ${what} error`);
  await Promise.all([
    relayer.run(signal, errs("relayer")),
    o.feeLoop === false ? Promise.resolve() : fees.runForever(signal, errs("fee loop")),
    every(signal, 10 * 60_000, 10 * 60_000, () => writePonsLaunchCurve(o.db, network, o.adapter), errs("launch curve")),
    every(signal, 4.5 * 60_000, 5.5 * 60_000, async () => writeInventory(o.db, network, await readInventory(o.executor, vaults.map((v) => v.address), o.keyring.rebalance(0).address)), errs("inventory")),
    every(signal, 1_000, 2_000, () =>
      hoodSnapshotTick({
        db: o.db,
        network,
        ex: o.executor,
        chainId: o.cfg.chainId,
        signers: async () => hoodSnapshotSigners(o.keyring, vaults.length, funderCount, counter.peek()),
        mints: () => hoodPoolMints(o.db, network),
      }), errs("verify snapshot")),
    every(signal, 3_600_000, 3 * 3_600_000, () => funders.topUp(), errs("funder top-up")),
  ]);
  o.executor.fees.stop();
}
