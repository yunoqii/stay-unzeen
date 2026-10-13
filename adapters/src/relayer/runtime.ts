import os from "node:os";
import path from "node:path";
import { OnlinePumpSdk, PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { Attester, deriveAttestKeypair } from "../attest";
import { Connection, type Keypair, type PublicKey } from "@solana/web3.js";
import pg from "pg";
import type { AdapterConfig } from "../config";
import { CreatorKeyring, CreatorPubkeyFile, FileCreatorIndexCounter, deriveCreatorKeypair, type CreatorIndexCounter } from "../keys";
import { FileMintSource, PgMintSource, creatorCount } from "./fee-sweeper";
import { PgVerifySnapshotStore, RpcFinalizedReader, VaultSnapshotter, type SnapshotSigner } from "./verify-snapshot";
import { priorityFeeCacheFromConfig, type PriorityFeeCache } from "../fees";
import { KeyStore, ageCipher, resolveAgeIdentity } from "../keystore";
import { metadataStoreFromEnv, type MetadataStore } from "../metadata";
import { LookupTables } from "../alt";
import { JUPITER_PROGRAM_ID, JupiterAdapter, JupiterClient, jupiterOptionsFromEnv } from "../jupiter";
import { DBC_PROGRAM_ID, MeteoraDbcAdapter, dbcConfigAddress, derivePartnerKeypair } from "../meteora";
import { PumpFunAdapter } from "../pumpfun";
import { txPipeline, type TxPipeline } from "../sender";
import { TokenWithdrawer } from "../withdraw";
import { jitoConfigFromEnv, type JitoConfig, type JitoTipCache } from "../jito";
import { jitoFairBundler, type FairBundler } from "./fair-bundler";
import { Relayer, type RelayerEvent } from "./engine";
import { AttestExecutor, RpcChainProbe, VenueTradeExecutor, WithdrawExecutor, type JobExecutor } from "./executors";
import { LaunchCurveWriter, pumpLaunchCurve } from "./launch-curves";
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
  /**
   * Meteora DBC config key; default METEORA_DBC_CONFIG_<NETWORK> / the
   * built-in devnet config; null = venue "meteora-dbc" not served here.
   */
  meteoraConfig?: PublicKey | null;
  /** Count-only log lines of background jobs (Verify snapshot). */
  log?: (m: string) => void;
  /**
   * Fair-launch v2 Jito config; default from env (JITO_*, FAIR_*) on mainnet,
   * null elsewhere (devnet has no Jito: every fair_create is one tx).
   */
  jito?: JitoConfig | null;
}

export interface RelayerRuntime {
  relayer: Relayer;
  adapter: PumpFunAdapter;
  /** Meteora DBC adapter; null when no config key is set for this network. */
  meteora: MeteoraDbcAdapter | null;
  /** Jupiter venue; mainnet only (null elsewhere: jobs fail venue_unavailable unsigned). */
  jupiter: JupiterAdapter | null;
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
  /** Verify attestation / operator key (own HD branch, not a vault / creator / partner); public on /verify. */
  attester: Attester;
  /** F14: fair-launch attestation key (separate HD path, never listed in Verify before 28.10). */
  fairAttester: Attester;
  /** RELAYER v3 launch_curves writer (pump Global); run it only when the table is writable. */
  launchCurves: LaunchCurveWriter;
  /** RELAYER v4 Verify vault snapshot; run it only when `verifySnapshotsWritable`. */
  snapshotter: VaultSnapshotter;
  /** Fair-launch v2 bundler (mainnet + Jito on); null = v1 single-tx launches. */
  fairBundler: FairBundler | null;
  /** Background Jito tip floor: `await refresh(); start()` with the fee cache, `stop()` after. Null when off. */
  jitoTips: JitoTipCache | null;
}

/**
 * Read provider of the Verify snapshot (RELAYER v4 §2: Shyft, SOLANA_READ_RPC_URL_*).
 * The addresses are public, so falling back to the main RPC leaks nothing new; warned.
 */
export function verifyReadConnection(cfg: AdapterConfig, main: Connection, env: NodeJS.ProcessEnv, warn: Warn): Connection {
  const sfx = cfg.cluster === "mainnet-beta" ? "MAINNET" : "DEVNET";
  const url = env[`SOLANA_READ_RPC_URL_${sfx}`]?.trim();
  if (url) return new Connection(url, { commitment: "finalized" });
  warn(`SOLANA_READ_RPC_URL_${sfx} not set: Verify snapshot reads go to the main RPC`);
  return main;
}

/**
 * Every address of the pool the relayer holds a key for (verify.md §4.1):
 * vaults, attestation key, DBC partner (when a config is served) — always;
 * creators — only if they hold something at the snapshot slot.
 */
export async function poolSnapshotSigners(o: {
  keys: OpenedKeys;
  attester: Attester;
  meteora: boolean;
  keysDir: string;
  db: pg.Pool | null;
  network: SolanaNetwork;
}): Promise<SnapshotSigner[]> {
  const out: SnapshotSigner[] = o.keys.vaults.map((key) => ({ key, always: true }));
  // Verify operator key only: the fair-launch key stays out of the public list (F14).
  out.push({ key: o.attester.key, always: true });
  if (o.meteora) out.push({ key: derivePartnerKeypair(o.keys.creatorSeed), always: true });
  const fileNext = new FileCreatorIndexCounter(path.join(o.keysDir, "creator-counter.json")).peek();
  const n = await creatorCount(fileNext, o.db, o.network);
  for (let i = 0; i < n; i++) out.push({ key: deriveCreatorKeypair(o.keys.creatorSeed, i), always: false });
  return out;
}

/**
 * Venue programs the fee estimate is asked for (programs only: no vault, mint
 * or user). One estimate over all venues -> ONE price for every pool tx.
 */
export const FEE_ESTIMATE_PROGRAMS: readonly string[] = [PUMP_PROGRAM_ID.toBase58(), DBC_PROGRAM_ID.toBase58(), JUPITER_PROGRAM_ID.toBase58()];

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
  // ONE lookup-table registry for every venue (per-vault tables, no stale caches).
  const lookupTables = new LookupTables(o.connection, o.cfg.keysDir, fees, pipeline);
  // creator-pubkeys.json next to the keys: public creator list for the token indexer (T1 race).
  const creators = new CreatorKeyring(o.keys.creatorSeed, counter, o.creatorRegistry !== undefined ? o.creatorRegistry : CreatorPubkeyFile.inDir(o.cfg.keysDir));
  const adapter = new PumpFunAdapter({
    connection: o.connection,
    defaultVault: vaults[0]!,
    vaults,
    creators,
    stateDir: o.cfg.keysDir,
    priorityMicroLamports: fees,
    pipeline,
    lookupTables,
  });
  const meteoraConfig = o.meteoraConfig !== undefined ? o.meteoraConfig : dbcConfigAddress(o.cfg.cluster, env);
  const meteora = meteoraConfig
    ? new MeteoraDbcAdapter({
        connection: o.connection,
        config: meteoraConfig,
        defaultVault: vaults[0]!,
        vaults,
        // Same keyring and counter: creator indexes are never shared between venues.
        creators,
        stateDir: o.cfg.keysDir,
        priorityMicroLamports: fees,
        pipeline,
        lookupTables,
      })
    : null;
  const trade: Partial<Record<"pumpfun" | "meteora-dbc" | "jupiter", JobExecutor>> = { pumpfun: new VenueTradeExecutor(adapter, metadata) };
  if (meteora) trade["meteora-dbc"] = new VenueTradeExecutor(meteora, metadata);
  // Jupiter: mainnet only (no devnet deployment). Elsewhere the venue has no executor,
  // so its jobs fail `venue_unavailable` before anything is signed.
  const jupiter = o.cfg.cluster === "mainnet-beta" ? buildJupiter(o.cfg.cluster, o.connection, fees, pipeline, env) : null;
  if (jupiter) trade.jupiter = new VenueTradeExecutor(jupiter, null);
  const attester = new Attester(o.connection, deriveAttestKeypair(o.keys.creatorSeed, "verify"), fees, pipeline);
  const fairAttester = new Attester(o.connection, deriveAttestKeypair(o.keys.creatorSeed, "fair"), fees, pipeline);
  const online = new OnlinePumpSdk(o.connection);
  const launchCurves = new LaunchCurveWriter(o.db, o.network, async () => [pumpLaunchCurve(await online.fetchGlobal())]);
  const probe = new RpcChainProbe(o.connection, pipeline.broadcaster);
  const queue = new PostgresJobQueue({ pool: o.db, network: o.network, probe });
  const pool = new VaultPool(vaults, new RpcVaultInventory(o.connection), cryptoRng, {
    usage,
    lock: new PgAdvisoryVaultLock(o.lockDb, o.network),
  });
  const snapshotter = new VaultSnapshotter({
    store: new PgVerifySnapshotStore(o.db, o.network),
    reader: new RpcFinalizedReader(verifyReadConnection(o.cfg, o.connection, env, o.warn)),
    signers: () =>
      poolSnapshotSigners({ keys: o.keys, attester, meteora: meteora !== null, keysDir: o.cfg.keysDir, db: o.db, network: o.network }),
    // Fail closed: a mint source error aborts the snapshot (never under-report assets).
    mints: pinsInFile ? new FileMintSource(path.join(o.cfg.keysDir, "mint-vaults.json")) : new PgMintSource(o.db, o.network),
    ...(o.log ? { log: o.log } : {}),
  });
  const withdrawer = new TokenWithdrawer({ connection: o.connection, priorityMicroLamports: fees, pipeline });
  // Fair-launch v2: Jito bundles over several vaults, mainnet only (decision 13.10: Jito ONLY here, never Now).
  const jito = o.jito !== undefined ? o.jito : jitoConfigFromEnv(o.cfg.cluster, env);
  const fair = o.cfg.cluster === "mainnet-beta" && jito ? jitoFairBundler({ adapter, metadata, connection: o.connection, withdrawer, cfg: jito }) : null;
  const relayer = new Relayer({
    queue,
    pool,
    ...(fair ? { fairBundler: fair.bundler } : {}),
    executors: {
      trade,
      withdraw: new WithdrawExecutor(withdrawer, cryptoRng),
      attest: new AttestExecutor({ verify: attester, fair: fairAttester }),
    },
    probe,
    mintVaults,
    ...(o.leaseMs ? { leaseMs: o.leaseMs } : {}),
    ...(o.onEvent ? { onEvent: o.onEvent } : {}),
  });
  return {
    relayer,
    adapter,
    meteora,
    jupiter,
    pool,
    queue,
    mintVaults,
    metadata,
    fees,
    pipeline,
    attester,
    fairAttester,
    launchCurves,
    snapshotter,
    fairBundler: fair?.bundler ?? null,
    jitoTips: fair?.tips ?? null,
  };
}

/** Jupiter venue on the pool pipeline: same fee cache (one CU price), same tip and broadcaster. */
export function buildJupiter(cluster: string, connection: Connection, fees: PriorityFeeCache, pipeline: TxPipeline, env: NodeJS.ProcessEnv): JupiterAdapter {
  const j = jupiterOptionsFromEnv(env);
  return new JupiterAdapter({
    connection,
    cluster,
    client: new JupiterClient(j.client),
    priorityMicroLamports: fees,
    pipeline,
    computeUnits: j.computeUnits,
    slippageBps: j.slippageBps,
  });
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
