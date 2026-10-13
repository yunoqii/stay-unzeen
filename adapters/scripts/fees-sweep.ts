/**
 * Global creator-fee sweep (docs/ARCHITECTURE.md "Сбор комиссий", H7).
 *
 *   pnpm fees:sweep                    # one run now ("by command", devnet)
 *   pnpm fees:sweep --dry-run          # plan only: what is claimable, nothing signed
 *   pnpm fees:sweep --daemon           # random 6-12 h between runs, until SIGINT
 *   options: --pause 2000-8000 (ms between targets), --min-lamports N, --mint <addr> (repeatable),
 *            --quote-any (devnet only: quote-token fees of any size pass the threshold)
 *
 * Inside the relayer instead: RELAYER_FEE_SWEEP=1 pnpm relayer:run.
 * Env: UNZEEN_SOLANA_CLUSTER, SOLANA_RPC_URL_*, SOLANA_KEYS_AGE_KEY_FILE,
 * DATABASE_URL_RELAYER (optional on devnet: candidate mints, advisory vault
 * locks shared with the relayer), FEE_SWEEP_STORE=file|postgres,
 * FEE_SWEEP_MIN_LAMPORTS.
 *
 * Output: counts and totals. Devnet one-shot runs also print explorer links
 * per tx (public data); the daemon never prints mint + amount + signature.
 */
import { describeConfig, explorerTxUrl, loadConfig, makeConnection } from "../src/config";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { priorityFeeCacheFromConfig } from "../src/fees";
import { txPipeline } from "../src/sender";
import { buildFeeSweeper } from "../src/relayer/fee-runtime";
import { JobsVaultUsage, PgAdvisoryVaultLock } from "../src/relayer/postgres-vaults";
import { cryptoRng } from "../src/relayer/random";
import { FEE_ESTIMATE_PROGRAMS, makePools, openKeys, relayerNetwork } from "../src/relayer/runtime";
import { MemoryVaultLock, MemoryVaultUsage, RpcVaultInventory, VaultPool } from "../src/relayer/vaults";

loadRepoEnv();
const log = (m: string) => console.error(`[fees] ${m}`);
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const arg = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const args = (n: string) => argv.flatMap((a, i) => (a === n && argv[i + 1] ? [argv[i + 1]!] : []));

async function main(): Promise<void> {
  const cfg = loadConfig();
  const network = relayerNetwork(cfg);
  const daemon = flag("--daemon");
  const dryRun = flag("--dry-run");
  log(`${describeConfig(cfg)} network=${network} mode=${daemon ? "daemon" : dryRun ? "dry-run" : "once"}`);
  const connection = makeConnection(cfg);
  const keys = await openKeys(cfg, process.env, log);
  const url = process.env.DATABASE_URL_RELAYER?.trim();
  if (!url && network === "mainnet-beta") throw new Error("DATABASE_URL_RELAYER is required on mainnet");
  const pools = url ? makePools(url, keys.vaults.length) : null;
  const db = pools?.db ?? null;

  const fees = priorityFeeCacheFromConfig(cfg, connection, FEE_ESTIMATE_PROGRAMS);
  await fees.refresh();
  fees.start();
  const pipeline = txPipeline(cfg, connection);
  const pool = new VaultPool(keys.vaults, new RpcVaultInventory(connection), cryptoRng, {
    usage: db ? new JobsVaultUsage(db, network) : new MemoryVaultUsage(),
    lock: pools ? new PgAdvisoryVaultLock(pools.lockDb, network) : new MemoryVaultLock(),
  });
  const pause = arg("--pause")?.split("-").map(Number);
  const min = arg("--min-lamports");
  const verbose = !daemon && network === "devnet";
  const { sweeper, store, venues, creators } = await buildFeeSweeper({
    cfg,
    connection,
    network,
    keys,
    db,
    pool,
    fees,
    pipeline,
    log,
    extraMints: args("--mint"),
    ...(min ? { minLamports: BigInt(min) } : {}),
    // --quote-any (devnet only): any non-zero quote fee passes the threshold (path checks with tiny fees).
    ...(flag("--quote-any") ? { quoteValuer: devnetQuoteAny(network) } : {}),
    ...(pause && pause.length === 2 ? { schedule: { pauseMinMs: pause[0]!, pauseMaxMs: pause[1]! } } : {}),
    ...(verbose
      ? {
          onTx: (e) =>
            log(
              `${e.ok ? "ok  " : "FAIL"} ${e.target.venue}/${e.target.kind} mint=${e.target.mint} -> vault ${e.vault.slice(0, 6)}… ` +
                `${e.lamports ?? "-"} lamports ${e.signature ? explorerTxUrl(e.signature, cfg.cluster) : ""}${e.error ? ` (${redactSecrets(e.error)})` : ""}`,
            ),
        }
      : {}),
  });
  log(`${creators.size} creator address(es), ${keys.vaults.length} vault(s), venues: ${venues.map((v) => v.venue).join(", ")}, send via ${pipeline.broadcaster.name}`);

  try {
    if (dryRun) {
      const { targets, considered, belowThreshold } = await sweeper.plan();
      log(`plan: ${considered} claimable target(s), ${belowThreshold} below threshold, ${targets.length} to sweep`);
      if (verbose) {
        const all = (await Promise.all(venues.map((v) => v.discover()))).flat();
        for (const t of all) {
          const q = t.quote ? ` quote=${t.quote.mint.slice(0, 6)}… units=${t.quote.units}` : ` claimable=${t.lamports}`;
          log(`  ${t.venue}/${t.kind} mint=${t.mint}${q} threshold=${sweeper.thresholdOf(t)} sweep=${await sweeper.eligible(t)}`);
        }
      }
    } else if (daemon) {
      const ac = new AbortController();
      for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, () => ac.abort());
      await sweeper.runForever(ac.signal, (e) => log(`run error: ${redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 200)}`));
    } else {
      const r = await sweeper.runOnce();
      if (verbose) for (const m of r.byMint) log(`  collected ${m.venue}/${m.kind} ${m.mint}: ${m.lamports} lamports`);
      if (verbose) for (const q of r.quote) log(`  collected quote ${q.mint}: ${q.units} units (vault quote stock)`);
      if (verbose) for (const m of await store.totals(network)) log(`  total ${m.venue}/${m.kind} ${m.mint}: ${m.lamports} lamports`);
    }
  } finally {
    fees.stop();
    await pools?.db.end();
    await pools?.lockDb.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[fees] fatal: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
    process.exit(1);
  });

function devnetQuoteAny(network: string) {
  if (network !== "devnet") throw new Error("--quote-any is devnet only");
  return { lamports: async () => null, minUnits: () => 1n };
}
