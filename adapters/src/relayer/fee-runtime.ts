import path from "node:path";
import { PublicKey, type Connection } from "@solana/web3.js";
import type pg from "pg";
import type { AdapterConfig } from "../config";
import { CreatorDirectory, DbcFeeVenue, PumpFeeVenue, RpcDbcPoolLister, StaticMintSource, UnionMintSource, DEFAULT_THRESHOLD, type FeeVenue } from "../creator-fees";
import { redactSecrets } from "../env";
import type { PriorityFeeCache } from "../fees";
import { CreatorPubkeyFile, FileCreatorIndexCounter } from "../keys";
import { dbcConfigAddress, derivePartnerKeypair } from "../meteora";
import type { TxPipeline } from "../sender";
import {
  DEFAULT_SWEEP_SCHEDULE,
  FeeSweeper,
  FileFeeSweepStore,
  FileMintSource,
  PgFeeSweepStore,
  PgMintSource,
  RpcSweepChain,
  creatorCount,
  type FeeSweepStore,
  type FeeSweeperOptions,
  type SweepSchedule,
} from "./fee-sweeper";
import type { SolanaNetwork } from "./postgres-queue";
import { cryptoRng } from "./random";
import { verifyFrozen } from "./verify-snapshot";
import type { OpenedKeys } from "./runtime";
import type { VaultPool } from "./vaults";

export interface FeeRuntimeOptions {
  cfg: AdapterConfig;
  connection: Connection;
  network: SolanaNetwork;
  keys: OpenedKeys;
  /** Relayer-role pool (candidate mints, counter); null = files only (devnet). */
  db: pg.Pool | null;
  /** The relayer's VaultPool when running inside it (same locks / rotation). */
  pool: VaultPool;
  fees: PriorityFeeCache;
  pipeline: TxPipeline;
  log: (m: string) => void;
  env?: NodeJS.ProcessEnv;
  extraMints?: readonly string[];
  minLamports?: bigint;
  schedule?: Partial<SweepSchedule>;
  onTx?: FeeSweeperOptions["onTx"];
}

/**
 * Wiring of the creator-fee sweeper (pnpm fees:sweep, or relayer:run with
 * RELAYER_FEE_SWEEP=1). Store: FEE_SWEEP_STORE=postgres once core has
 * `creator_fee_sweeps`, else `fee-sweeps.json` in the keys dir.
 */
export async function buildFeeSweeper(o: FeeRuntimeOptions): Promise<{ sweeper: FeeSweeper; store: FeeSweepStore; venues: FeeVenue[]; creators: CreatorDirectory }> {
  const env = o.env ?? process.env;
  const fileNext = new FileCreatorIndexCounter(path.join(o.cfg.keysDir, "creator-counter.json")).peek();
  const creators = new CreatorDirectory(o.keys.creatorSeed, await creatorCount(fileNext, o.db, o.network));
  const unknown = creators.missing(CreatorPubkeyFile.inDir(o.cfg.keysDir).read());
  if (unknown.length > 0) o.log(`WARN ${unknown.length} public creator address(es) are beyond the creator counter; their fees are not collected`);

  const mints = new UnionMintSource(
    [
      ...(o.db ? [new PgMintSource(o.db, o.network)] : []),
      new FileMintSource(path.join(o.cfg.keysDir, "mint-vaults.json")),
      new StaticMintSource((o.extraMints ?? []).map((m) => new PublicKey(m).toBase58())),
    ],
    (e) => o.log(`WARN mint source failed: ${redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 160)}`),
  );
  const venues: FeeVenue[] = [new PumpFeeVenue(o.connection, creators, mints)];
  const dbcConfig = dbcConfigAddress(o.cfg.cluster, env);
  if (dbcConfig) venues.push(new DbcFeeVenue(new RpcDbcPoolLister(o.connection), dbcConfig, creators, derivePartnerKeypair(o.keys.creatorSeed)));

  let store: FeeSweepStore;
  if (env.FEE_SWEEP_STORE?.trim() === "postgres") {
    if (!o.db) throw new Error("FEE_SWEEP_STORE=postgres needs DATABASE_URL_RELAYER");
    store = new PgFeeSweepStore(o.db);
  } else {
    store = new FileFeeSweepStore(path.join(o.cfg.keysDir, "fee-sweeps.json"));
  }
  const minEnv = env.FEE_SWEEP_MIN_LAMPORTS?.trim();
  const minLamports = o.minLamports ?? (minEnv ? BigInt(minEnv) : DEFAULT_THRESHOLD.minLamports);
  const sweeper = new FeeSweeper({
    network: o.network,
    venues,
    pool: o.pool,
    chain: new RpcSweepChain(o.connection, o.fees, o.pipeline),
    store,
    rng: cryptoRng,
    price: o.fees,
    tipLamports: o.pipeline.tip?.lamports ?? 0n,
    threshold: { ...DEFAULT_THRESHOLD, minLamports },
    schedule: { ...DEFAULT_SWEEP_SCHEDULE, ...o.schedule },
    log: o.log,
    ...(o.onTx ? { onTx: o.onTx } : {}),
    ...(o.db ? { paused: () => verifyFrozen(o.db!, o.network) } : {}),
  });
  return { sweeper, store, venues, creators };
}
