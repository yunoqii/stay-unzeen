import os from "node:os";
import path from "node:path";
import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import type { Connection, Keypair } from "@solana/web3.js";
import pg from "pg";
import type { AdapterConfig } from "../config";
import { CreatorKeyring, CreatorPubkeyFile, FileCreatorIndexCounter, type CreatorIndexCounter } from "../keys";
import { priorityFeeCacheFromConfig, type PriorityFeeCache } from "../fees";
import { KeyStore, ageCipher, resolveAgeIdentity } from "../keystore";
import { metadataStoreFromEnv, type MetadataStore } from "../metadata";
import { PumpFunAdapter } from "../pumpfun";
import { txPipeline, type TxPipeline } from "../sender";
import { TokenWithdrawer } from "../withdraw";
import { Relayer, type RelayerEvent } from "./engine";
import { PumpFunTradeExecutor, RpcChainProbe, WithdrawExecutor } from "./executors";
import { FileMintVaults, PgMintVaults, type MintVaults } from "./mint-vaults";
import { PostgresJobQueue, type SolanaNetwork } from "./postgres-queue";
import { JobsVaultUsage, PgAdvisoryVaultLock, PgCreatorIndexCounter, PgVaultUsage } from "./postgres-vaults";
import { cryptoRng } from "./random";
import { RpcVaultInventory, VaultPool, type VaultUsage } from "./vaults";

/**
 * Wiring of the production relayer (pnpm relayer:run) and the devnet e2e
 * script. Everything privacy-relevant is decided here:
 * - DB role (D8): DATABASE_URL_RELAYER = role `unzeen_relayer` (no SELECT on
 *   relayer_jobs.action_id). Missing or over-privileged: refuse on mainnet,
 *   warn on devnet.
 * - keys: age-encrypted KeyStore (required on mainnet).
 * - shared state: advisory vault locks (Postgres), rotation from relayer_jobs.
 *   Mint pins: core's `mint_vaults` (0003) when the role can use it, else a file.
 *   Creator counter: file until core adds `relayer_creator_counter`
 *   (RELAYER_STATE=postgres also switches it and vault usage to the proposed tables).
 */

export type Warn = (msg: string) => void;

export function relayerNetwork(cfg: AdapterConfig): SolanaNetwork {
  if (cfg.cluster !== "devnet" && cfg.cluster !== "mainnet-beta") {
    throw new Error(`relayer runs on devnet or mainnet-beta, not ${cfg.cluster}`);
  }
  return cfg.cluster;
}

/** D8: connection string of the least-privilege relayer role. */
export function relayerDatabaseUrl(network: SolanaNetwork, env: NodeJS.ProcessEnv, warn: Warn): string {
  const url = env.DATABASE_URL_RELAYER?.trim();
  if (url) return url;
  if (network === "mainnet-beta") {
    throw new Error("DATABASE_URL_RELAYER is not set (role unzeen_relayer, infra/relayer-role.sql); refusing on mainnet");
  }
  const owner = env.DATABASE_URL?.trim();
  if (!owner) throw new Error("DATABASE_URL_RELAYER is not set");
  warn("DATABASE_URL_RELAYER is not set: devnet fallback to DATABASE_URL (owner role, action_id readable). Not allowed on mainnet.");
  return owner;
}

/** D8: the role must not be able to read relayer_jobs.action_id. */
export async function checkRelayerRole(pool: pg.Pool, network: SolanaNetwork, warn: Warn): Promise<void> {
  const r = await pool.query<{ can: boolean }>(
    `SELECT has_column_privilege(current_user, 'relayer_jobs', 'action_id', 'SELECT') AS can`,
  );
  if (r.rows[0]?.can !== true) return;
  const msg = "this DB role can read relayer_jobs.action_id (the only link to a user)";
  if (network === "mainnet-beta") throw new Error(`${msg}; refusing on mainnet`);
  warn(`${msg}; devnet only`);
}

/** The relayer role must be able to read and write core's `mint_vaults` (D4 pins). */
export async function checkMintVaultsAccess(pool: pg.Pool): Promise<boolean> {
  const r = await pool
    .query<{ ok: boolean }>(
      `SELECT to_regclass('mint_vaults') IS NOT NULL
              AND has_table_privilege(current_user, 'mint_vaults', 'SELECT')
              AND has_table_privilege(current_user, 'mint_vaults', 'INSERT') AS ok`,
    )
    .catch(() => null);
  return r?.rows[0]?.ok === true;
}

export interface OpenedKeys {
  store: KeyStore;
  vaults: Keypair[];
  creatorSeed: Buffer;
}

/** Encrypted keys (SOLANA_KEYS_AGE_KEY_FILE / _KEY); plaintext only on devnet, with a warning. */
export async function openKeys(cfg: AdapterConfig, env: NodeJS.ProcessEnv, warn: Warn, vaultCount?: number): Promise<OpenedKeys> {
  const id = resolveAgeIdentity(cfg.keysDir, env);
  const mainnet = cfg.cluster === "mainnet-beta";
  if (!id && !mainnet) warn("Solana keys are NOT encrypted (set SOLANA_KEYS_AGE_KEY_FILE, run pnpm keys:encrypt)");
  const store = KeyStore.open(cfg.keysDir, { cipher: id ? await ageCipher(id.identity) : null, requireEncryption: mainnet });
  const vaults = vaultCount ? await store.ensureVaults(vaultCount) : await store.vaults();
  if (vaults.length === 0) throw new Error("no vault keys (pnpm keys:gen)");
  return { store, vaults, creatorSeed: await store.creatorSeed() };
}

export interface RelayerRuntimeOptions {
  cfg: AdapterConfig;
  connection: Connection;
  network: SolanaNetwork;
  keys: OpenedKeys;
  /** Queue/feed pool (relayer role). */
  db: pg.Pool;
  /** Dedicated pool for advisory vault locks (one connection per held lock). */
  lockDb: pg.Pool;
  env?: NodeJS.ProcessEnv;
  warn: Warn;
  onEvent?: (e: RelayerEvent) => void;
  /** Overrides (devnet e2e uses a throw-away schema and its own files). */
  mintVaults?: MintVaults;
  creatorCounter?: CreatorIndexCounter;
  metadata?: MetadataStore | null;
  leaseMs?: number;
  /** Pool-wide compute unit price; default: background cache from cfg (not started). */
  fees?: PriorityFeeCache;
  /** Public creator list (T1); default creator-pubkeys.json in the keys dir; null = off (tests). */
  creatorRegistry?: CreatorPubkeyFile | null;
  /** Tip + broadcaster; default from cfg (mainnet: Helius Sender, same tip on every tx; devnet: RPC, no tip). */
  pipeline?: TxPipeline;
}

export interface RelayerRuntime {
  relayer: Relayer;
  adapter: PumpFunAdapter;
  pool: VaultPool;
  queue: PostgresJobQueue;
  mintVaults: MintVaults;
  metadata: MetadataStore | null;
  /**
   * ONE compute unit price for all pool tx (R-relayer-2). Call
   * `await fees.refresh(); fees.start()` before running, `fees.stop()` after.
   */
  fees: PriorityFeeCache;
  /** How every pool tx is tipped and sent (one instance shared by all builders). */
  pipeline: TxPipeline;
}

/** Venue programs the fee estimate is asked for (programs only: no vault, mint or user). */
export const FEE_ESTIMATE_PROGRAMS: readonly string[] = [PUMP_PROGRAM_ID.toBase58()];

export function defaultMediaDir(cfg: Pick<AdapterConfig, "cluster">, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.UNZEEN_HOME?.trim() || path.join(os.homedir(), ".unzeen");
  return path.resolve(home.replace(/^~(?=\/|$)/, os.homedir()), cfg.cluster, "media");
}

export function buildRelayer(o: RelayerRuntimeOptions): RelayerRuntime {
  const env = o.env ?? process.env;
  const pgState = env.RELAYER_STATE?.trim() === "postgres";
  const vaults = o.keys.vaults;
  const counter =
    o.creatorCounter ??
    (pgState
      ? new PgCreatorIndexCounter(o.db, o.network, new FileCreatorIndexCounter(path.join(o.cfg.keysDir, "creator-counter.json")).peek())
      : new FileCreatorIndexCounter(path.join(o.cfg.keysDir, "creator-counter.json")));
  // Core's mint_vaults (0003) by default; RELAYER_MINT_VAULTS=file for a DB without it.
  const pinsInFile = env.RELAYER_MINT_VAULTS?.trim() === "file";
  const mintVaults =
    o.mintVaults ?? (pinsInFile ? new FileMintVaults(path.join(o.cfg.keysDir, "mint-vaults.json")) : new PgMintVaults(o.db, o.network));
  const usage: VaultUsage = pgState ? new PgVaultUsage(o.db, o.network) : new JobsVaultUsage(o.db, o.network);
  const metadata = o.metadata !== undefined ? o.metadata : metadataStoreFromEnv(defaultMediaDir(o.cfg, env), env);
  if (!metadata) o.warn("no metadata store (UNZEEN_METADATA_BASE_URL or PINATA_JWT): create jobs will retry and fail");

  const fees = o.fees ?? priorityFeeCacheFromConfig(o.cfg, o.connection, FEE_ESTIMATE_PROGRAMS);
  // ONE pipeline for all builders: buy/sell/create (+ lookup tables) and withdraw get the same tip.
  const pipeline = o.pipeline ?? txPipeline(o.cfg, o.connection);
  const adapter = new PumpFunAdapter({
    connection: o.connection,
    defaultVault: vaults[0]!,
    vaults,
    // creator-pubkeys.json next to the keys: public creator list for the token indexer (T1 race).
    creators: new CreatorKeyring(o.keys.creatorSeed, counter, o.creatorRegistry !== undefined ? o.creatorRegistry : CreatorPubkeyFile.inDir(o.cfg.keysDir)),
    stateDir: o.cfg.keysDir,
    priorityMicroLamports: fees,
    pipeline,
  });
  const probe = new RpcChainProbe(o.connection, pipeline.broadcaster);
  const queue = new PostgresJobQueue({ pool: o.db, network: o.network, probe });
  const pool = new VaultPool(vaults, new RpcVaultInventory(o.connection), cryptoRng, {
    usage,
    lock: new PgAdvisoryVaultLock(o.lockDb, o.network),
  });
  const relayer = new Relayer({
    queue,
    pool,
    executors: {
      trade: { pumpfun: new PumpFunTradeExecutor(adapter, metadata) },
      withdraw: new WithdrawExecutor(
        new TokenWithdrawer({ connection: o.connection, priorityMicroLamports: fees, pipeline }),
        cryptoRng,
      ),
    },
    probe,
    mintVaults,
    ...(o.leaseMs ? { leaseMs: o.leaseMs } : {}),
    ...(o.onEvent ? { onEvent: o.onEvent } : {}),
  });
  return { relayer, adapter, pool, queue, mintVaults, metadata, fees, pipeline };
}

export function makePools(url: string, vaultCount: number, schema?: string): { db: pg.Pool; lockDb: pg.Pool } {
  const options = schema ? { options: `-c search_path=${schema}` } : {};
  const db = new pg.Pool({ connectionString: url, max: 4, ...options });
  const lockDb = new pg.Pool({ connectionString: url, max: vaultCount + 2, ...options });
  // Idle-client errors (DB restart) must not crash the process; queries fail and are retried.
  db.on("error", () => undefined);
  lockDb.on("error", () => undefined);
  return { db, lockDb };
}
