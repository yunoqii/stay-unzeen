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
import { MemoryIntelStore } from "../src/intel/memory-store";
import { PgIntelStore } from "../src/intel/pg-store";
import { CreatorPubkeyFile } from "../src/keys";
import { solanaKeysDir } from "../src/config";
import { dbcConfigAddress } from "../src/meteora";
import pg from "pg";
import { RpcChainReader } from "../src/intel/reader";

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
  const indexer = new IntelIndexer({
    store,
    reader,
    rng: cryptoRng,
    offchain: { media, ipfsGateway: cfg.ipfsGateway },
    watcher:
      cfg.curveMode === "ws" && cfg.readWsUrl
        ? new ConnectionCurveWatcher(reader.read)
        : cfg.curveMode === "off"
          ? null
          : new PollingCurveWatcher(reader.read, cryptoRng),
    full: cfg.full ? new RpcFullIntel(reader.read) : null,
    // Meteora DBC launches of Unzeen's config: progress / graduated / locked LP.
    dbcConfig: dbcConfigAddress(cfg.cluster),
  });
  // INTEL.md rule 4: tick number, batch size, durations, error counts. Never mints or "real/decoy".
  const fmt = (r: Awaited<ReturnType<IntelIndexer["tick"]>>) =>
    `tick #${r.tick} batch=${r.batch} warm=${r.warm} saved=${r.saved} missing=${r.missing} subs+${r.subsAdded}/-${r.subsRemoved} errors=${r.errors} ${r.ms}ms next=${Math.round(r.nextInMs / 1000)}s`;
  if (process.argv.includes("--once")) {
    const r = await indexer.tick();
    log(fmt(r));
    if (demo >= 0 && store instanceof MemoryIntelStore) {
      // Demo output: devnet only, explicit request; real and decoy rows are indistinguishable by design.
      if (cfg.cluster !== "devnet") throw new Error("--demo prints rows: devnet only");
      for (const row of store.safety.values()) console.log(JSON.stringify(row));
    }
  } else {
    const ac = new AbortController();
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => ac.abort());
    await indexer.run(ac.signal, (r) => log(fmt(r)));
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
