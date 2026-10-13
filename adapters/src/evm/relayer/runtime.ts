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

/** Starts everything; resolves when `signal` aborts. */
export async function runHoodRelayer(o: HoodRuntimeOptions, signal: AbortSignal): Promise<void> {
  const log = o.log ?? (() => undefined);
  const { relayer, fees } = buildHoodRelayer(o);
  o.executor.fees.start(10 * 60_000, () => log("hood fee cache refresh failed"));
  const rec = await relayer.reconcileLaunches();
  log(`hood launches reconciled: kept=${rec.kept} dropped=${rec.dropped} refunded=${rec.refunded} orphan=${rec.orphanLaunches}`);
  const errs = (what: string) => () => log(`hood ${what} error`);
  await Promise.all([relayer.run(signal, errs("relayer")), o.feeLoop === false ? Promise.resolve() : fees.runForever(signal, errs("fee loop"))]);
  o.executor.fees.stop();
}
