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
import { FunderPool, funderOptionsFromEnv, funderPollMsFromEnv } from "../funders";
import { hoodPoolMints, hoodSnapshotSigners, hoodSnapshotTick, readInventory, writeInventory, writePonsLaunchCurve, writeTokenPrices } from "./pool-state";
import { FileLaunchStore, FileSentClock, type LaunchStore } from "./launches";
import { FileOwedStore } from "../pons/creator";
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
  /**
   * The SAME FunderPool the adapter picks from (thresholds from HOOD_FUNDER_*_WEI);
   * default: a new pool with `funderCount` and the env thresholds.
   */
  funders?: FunderPool;
  /** GAP-8: poll of the rebalance address for new ETH, ms (HOOD_FUNDER_POLL_SECS, default 300 s). */
  funderPollMs?: number;
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
    sentClock: FileSentClock.inDir(o.cfg.keysDir),
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
    owed: new FileOwedStore(path.join(o.cfg.keysDir, "fees-owed.json")),
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
 * the rebalance address (at start, then 1–3 h) + on ETH arrival on the rebalance
 * address (poll every HOOD_FUNDER_POLL_SECS ±10 %, GAP-8).
 */
export async function runHoodRelayer(o: HoodRuntimeOptions, signal: AbortSignal): Promise<void> {
  const log = o.log ?? (() => undefined);
  const network = hoodNetworkId(o.cfg);
  const { relayer, fees, vaults } = buildHoodRelayer(o);
  const funderCount = o.funderCount ?? 8;
  const funders = o.funders ?? new FunderPool({ executor: o.executor, keyring: o.keyring, count: funderCount, ...funderOptionsFromEnv() });
  const pollMs = o.funderPollMs ?? funderPollMsFromEnv();
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
    // GAP-8: ETH delivered to the rebalance address (1Click lot) reaches the funders within minutes.
    every(signal, Math.round(pollMs * 0.9), Math.round(pollMs * 1.1), async () => {
      const r = await funders.topUpOnArrival();
      if (r.arrived) log(`hood funder top-up on arrival: sent=${r.sent}`);
    }, errs("funder arrival poll")),
    every(signal, 60_000, 120_000, () => writeTokenPrices(o.db, network, o.adapter), errs("token prices")),
  ]);
  o.executor.fees.stop();
}
