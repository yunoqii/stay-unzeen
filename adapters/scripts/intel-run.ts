/**
 * Token intel indexer (docs/analysis/token-intel.md, docs/INTEL.md).
 *
 *   pnpm intel:run              # Postgres (DATABASE_URL_INDEXER, role unzeen_indexer), until SIGINT / SIGTERM
 *   pnpm intel:run --once       # one tick, then exit (smoke test)
 *   pnpm intel:run --once --demo <mint>...   # devnet: in-memory store, mints enqueued as CA lookups, rows printed
 *
 * Store: PgIntelStore on core's 0007 tables (advisory lock, role check); --memory / --demo: in memory.
 * Env: SOLANA_READ_RPC_URL_* (Shyft), SOLANA_READ_WS_URL_* (optional),
 * SOLANA_INDEX_RPC_URL_* (getTokenLargestAccounts), INTEL_FULL=1 (off by default),
 * UNZEEN_METADATA_BASE_URL + UNZEEN_METADATA_DIR (re-encoded images), INTEL_IPFS_GATEWAY.
 * Logs: counts only; never mints, URLs or provider answers.
 */
import { PublicKey } from "@solana/web3.js";
import { loadRepoEnv, maskUrl, redactSecrets } from "../src/env";
import { LocalMetadataStore } from "../src/metadata";
import { cryptoRng } from "../src/relayer/random";
import { defaultMediaDir } from "../src/relayer/runtime";
import { loadIntelConfig } from "../src/intel/config";
import { RpcFullIntel } from "../src/intel/full";
import { ConnectionCurveWatcher, IntelIndexer, PollingCurveWatcher } from "../src/intel/indexer";
import { JsonRpcBackfill, TradeBackfill, type BackfillReport } from "../src/intel/backfill";
import { MemoryIntelStore } from "../src/intel/memory-store";
import { PgIntelStore } from "../src/intel/pg-store";
import { CreatorPubkeyFile } from "../src/keys";
import { solanaKeysDir } from "../src/config";
import { dbcConfigAddress } from "../src/meteora";
import { LAUNCHLAB_PROGRAM, launchLabCluster } from "../src/launchlab";
import pg from "pg";
import { RpcChainReader } from "../src/intel/reader";
import { Discovery, DbcStreamSource, MemoryDiscoveryStore, PumpLogsSource, PumpPollSource, launchLabCreatesFromNotification, launchLabStreamRequest, loadDiscoveryConfig, type CreateSource, type DiscoveryStore } from "../src/intel/discovery";
import { DevIndex, MemoryCreateIndex, PgCreateIndex, RpcRugChecker, type CreateIndexStore } from "../src/intel/dev-index";
import { ParsedTradeStream } from "../src/intel/trades";
import { PgDiscoveryStore, RpcDiscoveryChain } from "../src/intel/discovery-pg";

loadRepoEnv();
const log = (m: string) => console.error(`[intel] ${m}`);

async function main(): Promise<void> {
  const cfg = loadIntelConfig();
  log(`cluster=${cfg.cluster} read=${maskUrl(cfg.readUrl)} (${cfg.readSource}) ws=${cfg.readWsUrl ? maskUrl(cfg.readWsUrl) : "none"} index=${cfg.indexUrl ? `${maskUrl(cfg.indexUrl)} (${cfg.indexSource})` : "none"} curves=${cfg.curveMode} full=${cfg.full ? "ON" : "off"}`);
  for (const w of cfg.warnings) log(`WARN ${w}`);
  if (cfg.cluster === "mainnet-beta" && process.env.UNZEEN_ALLOW_MAINNET !== "yes") {
    throw new Error("mainnet-beta is disabled; set UNZEEN_ALLOW_MAINNET=yes only with the lead's approval (read-only)");
  }
  const reader = new RpcChainReader({ readUrl: cfg.readUrl, readWsUrl: cfg.readWsUrl, indexUrl: cfg.indexUrl, rps: cfg.rps });
  const demo = process.argv.indexOf("--demo");
  const memory = demo >= 0 || process.argv.includes("--memory");
  let store: MemoryIntelStore | PgIntelStore;
  let db: pg.Pool | null = null;
  if (memory) {
    const m = new MemoryIntelStore();
    if (demo >= 0) for (const a of process.argv.slice(demo + 1)) if (!a.startsWith("--")) m.enqueue(new PublicKey(a).toBase58());
    store = m;
  } else {
    const url = process.env.DATABASE_URL_INDEXER?.trim();
    if (!url) throw new Error("DATABASE_URL_INDEXER is not set (role unzeen_indexer, infra/indexer-role.sql); use --memory for a dry run");
    db = new pg.Pool({ connectionString: url, max: 3 });
    db.on("error", () => undefined);
    // Public creator list next to the relayer keys (T1 race); the indexer never opens the keys themselves.
    const p = new PgIntelStore(db, cfg.cluster, CreatorPubkeyFile.inDir(solanaKeysDir(cfg.cluster)));
    await p.start();
    store = p;
  }
  const base = process.env.UNZEEN_METADATA_BASE_URL?.trim();
  const media = base ? new LocalMetadataStore(process.env.UNZEEN_MEDIA_DIR?.trim() || process.env.UNZEEN_METADATA_DIR?.trim() || defaultMediaDir({ cluster: cfg.cluster }), base) : null;
  if (!media) log("WARN UNZEEN_METADATA_BASE_URL not set: token images are not mirrored (socials still are)");
  // INTEL_FULL: dev history = own index of creates (+ lazy rug checks on the read provider).
  let devIndex: DevIndex | null = null;
  if (cfg.full) {
    let cstore: CreateIndexStore = new MemoryCreateIndex();
    if (db) {
      const p = new PgCreateIndex(db, cfg.cluster);
      if (await p.available()) cstore = p;
      else log("WARN intel_creates (proposed core table) missing or not writable: dev index kept in memory only");
    }
    devIndex = new DevIndex(cstore, new RpcRugChecker(reader.read));
  }
  // UNZEEN_INTEL_FULL_TRADES: trade feed of hot warm mints (+ decoys) over Helius Parsed Streams.
  let tradeStream: ParsedTradeStream | null = null;
  if (cfg.fullTrades) {
    if (cfg.streamUrl) tradeStream = new ParsedTradeStream(cfg.streamUrl, { maxPerHour: cfg.tradesMaxPerHour });
    else log("WARN UNZEEN_INTEL_FULL_TRADES=1 but no Parsed Streams URL (INTEL_TRADES_STREAM_URL / Helius key, mainnet): feed off");
  }
  let discovery: Discovery | null = null;
  // Trade backfill (INTEL.md): batch + indexer-picked discovery candidates on the index provider. Logs: counts only.
  const bfAgg = { n: 0, mints: 0, credits: 0, trades: 0, errors: 0, ms: 0 };
  const backfill =
    cfg.backfill.enabled && tradeStream && cfg.indexUrl
      ? {
          lane: new TradeBackfill({ rpc: new JsonRpcBackfill(cfg.indexUrl, cfg.backfill.rps), maxTxCredits: cfg.backfill.maxTxCredits }),
          discoveryPerTick: cfg.backfill.discoveryPerTick,
          candidates: () => discovery?.backfillCandidates() ?? [],
          onReport: (r: BackfillReport) => {
            bfAgg.n++;
            bfAgg.mints += r.mints;
            bfAgg.credits += r.credits;
            bfAgg.trades += r.trades;
            bfAgg.errors += r.errors;
            bfAgg.ms = Math.max(bfAgg.ms, r.ms);
            if (bfAgg.n < 10) return;
            log(`backfill x${bfAgg.n} mints=${bfAgg.mints} credits=${bfAgg.credits} trades=${bfAgg.trades} errors=${bfAgg.errors} max=${bfAgg.ms}ms`);
            Object.assign(bfAgg, { n: 0, mints: 0, credits: 0, trades: 0, errors: 0, ms: 0 });
          },
        }
      : null;
  log(`trade backfill ${backfill ? `ON maxTx=${cfg.backfill.maxTxCredits}/tick discovery=${cfg.backfill.discoveryPerTick}/tick` : "off"}`);
  const indexer = new IntelIndexer({
    backfill,
    store,
    // Card lane (INTEL.md): fixed 6–10 s base snapshots so a cold CA opens in ~10 s. INTEL_CARD_LANE=0 turns it off.
    cardLane: process.env.INTEL_CARD_LANE?.trim() !== "0",
    // Discovery candidates are pre-indexed (warm set): public stream, never user-driven.
    discoveryMints: () => discovery?.activeMints() ?? [],
    reader,
    rng: cryptoRng,
    offchain: { media, ipfsGateway: cfg.ipfsGateway },
    watcher:
      cfg.curveMode === "ws" && cfg.readWsUrl
        ? new ConnectionCurveWatcher(reader.read)
        : cfg.curveMode === "off"
          ? null
          : new PollingCurveWatcher(reader.read, cryptoRng),
    full: cfg.full ? new RpcFullIntel(reader.read, devIndex) : null,
    trades: tradeStream ? { source: tradeStream, whaleLamports: cfg.whaleLamports, sniperSlots: cfg.sniperSlots } : null,
    // Meteora DBC launches of Unzeen's config: progress / graduated / locked LP.
    dbcConfig: dbcConfigAddress(cfg.cluster),
    // API v0.28: LaunchLab SOL pools of pinned mints (price, progress, curve state).
    launchLabProgram: launchLabCluster(cfg.cluster) ? LAUNCHLAB_PROGRAM[launchLabCluster(cfg.cluster)!] : null,
  });
  // INTEL.md rule 4: tick number, batch size, durations, error counts. Never mints or "real/decoy".
  const fmt = (r: Awaited<ReturnType<IntelIndexer["tick"]>>) =>
    `tick #${r.tick} batch=${r.batch} warm=${r.warm} saved=${r.saved} missing=${r.missing} subs+${r.subsAdded}/-${r.subsRemoved} errors=${r.errors} ${r.ms}ms next=${Math.round(r.nextInMs / 1000)}s`;
  // Discovery (FEATURES 9): all fresh pump.fun / DBC tokens, OFF unless INTEL_DISCOVERY=1. Own tick, public stream only.
  const dcfg = loadDiscoveryConfig(cfg.cluster);
  if (dcfg.enabled) {
    if (!dcfg.rpcUrl) throw new Error("INTEL_DISCOVERY=1 needs INTEL_DISCOVERY_RPC_URL_* or SOLANA_RPC_URL_* (Helius)");
    const chain = new RpcDiscoveryChain(dcfg.rpcUrl, { rps: dcfg.rps, wsUrl: dcfg.wsUrl });
    const sources: CreateSource[] = [];
    if (dcfg.pump === "poll") sources.push(new PumpPollSource(chain.conn));
    // ws: creates pushed with mint + creator (dev index), no poll / getTransaction; the poll is only the watchdog fallback.
    if (dcfg.pump === "ws") sources.push(new PumpLogsSource(chain.conn, 500, { fallback: new PumpPollSource(chain.conn) }));
    if (dcfg.dbcStreamUrl) sources.push(new DbcStreamSource(dcfg.dbcStreamUrl, { maxPerHour: dcfg.dbcMaxPerHour }));
    // Dev index: LaunchLab creates too (not discovery candidates); pump creators need the logs source.
    // API v0.28 Pulse: LaunchLab creates are discovery candidates too (mainnet, Parsed Streams; INTEL_DISCOVERY_LAUNCHLAB=0 turns it off).
    const llUrl = cfg.streamUrl ?? dcfg.dbcStreamUrl;
    const llDiscovery = cfg.cluster === "mainnet-beta" && process.env.INTEL_DISCOVERY_LAUNCHLAB?.trim() !== "0" && Boolean(llUrl);
    if ((devIndex || llDiscovery) && llUrl) sources.push(launchLabCreates(llUrl, cfg.createsMaxPerHour));
    if (devIndex && dcfg.pump !== "ws") log("WARN dev index: pump.fun creators need INTEL_DISCOVERY_PUMP=ws (the poll source has no CreateEvent)");
    let dstore: DiscoveryStore = new MemoryDiscoveryStore();
    if (db) {
      const pgs = new PgDiscoveryStore(db, cfg.cluster);
      if (await pgs.available().catch(() => false)) dstore = pgs;
      else log("WARN intel_discovery (proposed core table) missing or not writable: discovery kept in memory only");
    }
    discovery = new Discovery({
      store: dstore,
      chain,
      // Metrics pass on its own limiter: its batch of ~max/100 calls never queues ahead of the fast pass.
      metricsChain: new RpcDiscoveryChain(dcfg.rpcUrl, { rps: dcfg.rps }),
      passMs: dcfg.passMs,
      sources,
      rng: cryptoRng,
      max: dcfg.max,
      windowMs: dcfg.windowMs,
      burst: dcfg.burst,
      launchLabProgram: llDiscovery ? LAUNCHLAB_PROGRAM["mainnet-beta"] : null,
      ...(devIndex ? { onCreates: (c) => devIndex!.record(c) } : {}),
    });
    log(`discovery ON rpc=${maskUrl(dcfg.rpcUrl)} (${dcfg.rpcSource}) pump=${dcfg.pump} dbc=${dcfg.dbcStreamUrl ? "stream" : "off"} launchlab=${llDiscovery ? "stream" : "off"} max=${dcfg.max}/${dcfg.windowMs / 3_600_000}h admission=${dcfg.burst === 0 ? "unlimited" : `bucket(burst ${dcfg.burst})`} pass=${dcfg.passMs / 1000}s`);
  }
  // Dev index without discovery: the same public create streams, drained every 60 s.
  let createFeed: CreateSource[] = [];
  if (devIndex && !discovery) {
    if (!dcfg.rpcUrl) log("WARN INTEL_FULL: no Helius URL for the create streams: dev history stays empty");
    else {
      const chain = new RpcDiscoveryChain(dcfg.rpcUrl, { rps: dcfg.rps, wsUrl: dcfg.wsUrl });
      createFeed = [new PumpLogsSource(chain.conn)];
      if (dcfg.dbcStreamUrl) createFeed.push(new DbcStreamSource(dcfg.dbcStreamUrl, { maxPerHour: dcfg.dbcMaxPerHour }));
      if (cfg.streamUrl) createFeed.push(launchLabCreates(cfg.streamUrl, cfg.createsMaxPerHour));
    }
  }
  const drainCreates = async () => {
    for (const s of createFeed) await devIndex!.record(await s.drain()).catch(() => log("WARN dev index write failed"));
  };
  const dfmt = (r: Awaited<ReturnType<Discovery["tick"]>>) =>
    `discovery #${r.tick}${r.passes !== undefined ? ` passes=${r.passes}` : ""} seen=${r.seen} admitted=${r.admitted} active=${r.active} removed=${r.removed} reads=${r.reads} errors=${r.errors}` +
    `${r.lagMaxMs !== undefined ? ` lag=${(r.lagAvgMs! / 1000).toFixed(1)}/${(r.lagMaxMs / 1000).toFixed(1)}s` : ""} max=${r.ms}ms`;

  if (process.argv.includes("--once")) {
    const r = await indexer.tick();
    log(fmt(r));
    if (discovery) log(dfmt(await discovery.tick()));
    if (demo >= 0 && store instanceof MemoryIntelStore) {
      // Demo output: devnet only, explicit request; real and decoy rows are indistinguishable by design.
      if (cfg.cluster !== "devnet") throw new Error("--demo prints rows: devnet only");
      for (const row of store.safety.values()) console.log(JSON.stringify(row));
    }
  } else {
    const ac = new AbortController();
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => ac.abort());
    const feed = (async () => {
      while (!ac.signal.aborted && createFeed.length > 0) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, 60_000);
          ac.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
        });
        await drainCreates();
      }
      for (const s of createFeed) s.stop?.();
    })();
    // Card lane: one summary line per 10 card ticks (counts only).
    const agg = { n: 0, batch: 0, cards: 0, missing: 0, errors: 0, ms: 0 };
    const onCard = (r: Awaited<ReturnType<IntelIndexer["cardTick"]>>) => {
      agg.n++;
      agg.batch += r.batch;
      agg.cards += r.cards;
      agg.missing += r.missing;
      agg.errors += r.errors;
      agg.ms = Math.max(agg.ms, r.ms);
      if (agg.n < 10) return;
      log(`cards x${agg.n} batch=${agg.batch} cards=${agg.cards} missing=${agg.missing} errors=${agg.errors} max=${agg.ms}ms`);
      Object.assign(agg, { n: 0, batch: 0, cards: 0, missing: 0, errors: 0, ms: 0 });
    };
    await Promise.all([
      indexer.run(ac.signal, (r) => log(fmt(r) + (r.trades !== undefined ? ` trades=${r.trades}` : "")), onCard),
      discovery ? discovery.run(ac.signal, (r) => log(dfmt(r))) : Promise.resolve(),
      feed,
    ]);
    tradeStream?.stop();
  }
  if (store instanceof PgIntelStore) await store.stop();
  await db?.end();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[intel] fatal: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
    process.exit(1);
  });

/** LaunchLab creates over Parsed Streams (dev index only). */
function launchLabCreates(url: string, maxPerHour: number): CreateSource {
  return new DbcStreamSource(url, { request: launchLabStreamRequest(), parse: launchLabCreatesFromNotification, name: "launchlab-stream", maxPerHour });
}
