/**
 * Live check of Discovery (FEATURES 9), READ-ONLY, in-memory store, no keys, no sends:
 *   pnpm intel:discovery-probe [ticks=3] [--mainnet]   (--mainnet: read-only reads on mainnet)
 * Ticks every ~20 s here (the real loop is 45–75 s). Prints counts per tick and the
 * newest rows (public chain data). Uses the same env as intel:run (INTEL_DISCOVERY_*,
 * SOLANA_RPC_URL_*). URLs are never printed.
 */
import { loadRepoEnv, maskUrl, redactSecrets } from "../src/env";
import { Discovery, DbcStreamSource, MemoryDiscoveryStore, PumpLogsSource, PumpPollSource, loadDiscoveryConfig, type CreateSource } from "../src/intel/discovery";
import { RpcDiscoveryChain } from "../src/intel/discovery-pg";
import { cryptoRng } from "../src/relayer/random";

loadRepoEnv();

async function main(): Promise<void> {
  const cluster = process.argv.includes("--mainnet") ? "mainnet-beta" : "devnet";
  const ticks = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 3);
  const cfg = loadDiscoveryConfig(cluster, { ...process.env, INTEL_DISCOVERY: "1" });
  if (!cfg.rpcUrl) throw new Error(`no RPC for ${cluster} (INTEL_DISCOVERY_RPC_URL_* / SOLANA_RPC_URL_*)`);
  console.error(`[discovery-probe] ${cluster} rpc=${maskUrl(cfg.rpcUrl)} (${cfg.rpcSource}) pump=${cfg.pump} dbc=${cfg.dbcStreamUrl ? "stream" : "off"}`);
  const chain = new RpcDiscoveryChain(cfg.rpcUrl, { rps: cfg.rps, wsUrl: cfg.wsUrl });
  const sources: CreateSource[] = [];
  if (cfg.pump === "poll") sources.push(new PumpPollSource(chain.conn));
  if (cfg.pump === "ws") sources.push(new PumpLogsSource(chain.conn));
  const dbc = cfg.dbcStreamUrl ? new DbcStreamSource(cfg.dbcStreamUrl, { maxPerHour: cfg.dbcMaxPerHour }) : null;
  if (dbc) sources.push(dbc);
  const store = new MemoryDiscoveryStore();
  const d = new Discovery({ store, chain, sources, rng: cryptoRng, max: cfg.max, windowMs: cfg.windowMs, burst: cfg.burst });
  for (let i = 0; i < ticks; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 20_000));
    const r = await d.tick();
    console.error(`[discovery-probe] tick #${r.tick} seen=${r.seen} admitted=${r.admitted} active=${r.active} reads=${r.reads} errors=${r.errors} ${r.ms}ms${dbc ? ` dbcEvents=${dbc.events}` : ""}`);
  }
  for (const s of sources) s.stop?.();
  for (const row of store.list().slice(0, 8)) {
    console.log(`${row.venue.padEnd(11)} ${row.mint} ${String(row.symbol ?? "?").padEnd(10)} ${row.status} mcap=${row.marketCapSol} SOL progress=${row.progressPct ?? "-"}% age=${Math.round((Date.now() - row.createdAt) / 1000)}s`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[discovery-probe] fatal: ${redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    process.exit(1);
  });
