import path from "node:path";
import { PublicKey, type Connection } from "@solana/web3.js";
import type pg from "pg";
import type { AdapterConfig } from "../config";
import { getPdaPlatformId } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  CreatorDirectory,
  DbcFeeVenue,
  LaunchLabFeeVenue,
  MemeFunFeeVenue,
  PumpFeeVenue,
  RpcDbcPoolLister,
  StaticMintSource,
  UnionMintSource,
  DEFAULT_THRESHOLD,
  type DbcFeeConfig,
  type FeeVenue,
} from "../creator-fees";
import { LAUNCHLAB_CONFIGS, LAUNCHLAB_PROGRAM, launchLabCluster } from "../launchlab";
import { makeQuotePool, quoteAssets, type QuoteAsset } from "../pool-a";
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
  type QuoteValuer,
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
  /** Override of the quote valuation (devnet checks); default: pool A + FEE_SWEEP_MIN_<SYM>. */
  quoteValuer?: QuoteValuer;
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
  const venues: FeeVenue[] = [new PumpFeeVenue(o.connection, creators, mints), new MemeFunFeeVenue(o.connection, creators, mints)];
  const partner = derivePartnerKeypair(o.keys.creatorSeed);
  // RELAYER v8 A8: every Unzeen DBC config (SOL + quote ones), fees in their quote.
  const dbcAssets = quoteAssets(o.cfg.cluster, env);
  const dbcConfigs: DbcFeeConfig[] = [];
  const dbcConfig = dbcConfigAddress(o.cfg.cluster, env);
  if (dbcConfig) dbcConfigs.push({ address: dbcConfig, quoteMint: NATIVE_MINT, decimals: 9 });
  for (const a of dbcAssets) if (a.dbcConfig) dbcConfigs.push({ address: a.dbcConfig, quoteMint: a.mint, decimals: a.decimals });
  if (dbcConfigs.length) venues.push(new DbcFeeVenue(new RpcDbcPoolLister(o.connection), dbcConfigs, creators, partner));
  // Raydium LaunchLab: creator fee vaults of our launches + Unzeen platform fees (partner = claim wallet).
  const ll = launchLabCluster(o.cfg.cluster);
  const pumpAssets = quoteAssets(o.cfg.cluster, env, "pumpfun");
  if (ll) {
    const program = LAUNCHLAB_PROGRAM[ll];
    const llQuotes = [...dbcAssets, ...pumpAssets.filter((a) => a.stockOnly)].filter((a) => LAUNCHLAB_CONFIGS[ll][a.mint.toBase58()]);
    venues.push(
      new LaunchLabFeeVenue(
        o.connection,
        program,
        [{ mint: NATIVE_MINT, decimals: 9 }, ...llQuotes.map((a) => ({ mint: a.mint, decimals: a.decimals }))],
        creators,
        mints,
        partner,
        getPdaPlatformId(program, partner.publicKey).publicKey,
      ),
    );
  }

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
    quoteValuer: o.quoteValuer ?? new PoolAQuoteValuer(o.connection, [...dbcAssets, ...pumpAssets], env),
  });
  return { sweeper, store, venues, creators };
}

/**
 * Quote fees for the sweep threshold: priced quotes on their pool A (SOL value of the units),
 * stock-only quotes (ZEC SPL) by a minimum in whole tokens: FEE_SWEEP_MIN_<SYM> (default 0.05).
 */
export class PoolAQuoteValuer implements QuoteValuer {
  private readonly byMint = new Map<string, QuoteAsset>();
  constructor(
    private readonly connection: Connection,
    assets: readonly QuoteAsset[],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    for (const a of assets) if (!this.byMint.has(a.mint.toBase58())) this.byMint.set(a.mint.toBase58(), a);
  }
  /** null = stock-only (no SOL value by design); throws when a priced quote cannot be valued now. */
  async lamports(mint: string, units: bigint): Promise<bigint | null> {
    const a = this.byMint.get(mint);
    if (!a) throw new Error(`unknown quote mint ${mint.slice(0, 8)}…`);
    if (!a.poolA) return null;
    const pool = makeQuotePool(this.connection, a);
    if (!pool) throw new Error("no pool A");
    return pool.solForQuote(await pool.load(), units);
  }
  minUnits(mint: string): bigint | null {
    const a = this.byMint.get(mint);
    if (!a || a.poolA) return null; // priced quotes: only by value
    const v = this.env[`FEE_SWEEP_MIN_${a.symbol}`]?.trim();
    const whole = v ? Number(v) : 0.05;
    if (!Number.isFinite(whole) || whole <= 0) return null;
    return (BigInt(Math.round(whole * 1e6)) * 10n ** BigInt(a.decimals)) / 1_000_000n;
  }
}
