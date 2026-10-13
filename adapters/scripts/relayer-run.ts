/**
 * Production relayer: executes `relayer_jobs` from Postgres (docs/RELAYER.md).
 *
 *   pnpm relayer:run                 # until SIGINT / SIGTERM
 *   pnpm relayer:run --schema <s>    # devnet only: a throw-away schema (e2e tests)
 *
 * Env (repo-root .env): UNZEEN_SOLANA_CLUSTER / SOLANA_CLUSTER, SOLANA_RPC_URL_*,
 * DATABASE_URL_RELAYER (role unzeen_relayer; D8), SOLANA_KEYS_AGE_KEY_FILE,
 * UNZEEN_METADATA_BASE_URL (+ UNZEEN_METADATA_DIR) or PINATA_JWT, RELAYER_STATE=file|postgres.
 *
 * Logs: event kind + outcome code + duration class only. Never job ids,
 * signatures, mints, vaults, amounts or destinations (RELAYER.md "Приватность").
 */
import { poolQuoteInventoryWritable, poolSolInventoryWritable } from "../src/rebalance";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { describeConfig, loadConfig, makeConnection } from "../src/config";
import { buildFeeSweeper } from "../src/relayer/fee-runtime";
import { launchCurvesWritable } from "../src/relayer/launch-curves";
import { verifySnapshotsWritable } from "../src/relayer/verify-snapshot";
import { buildRelayer, checkMintVaultsAccess, checkRelayerRole, makePools, openKeys, relayerDatabaseUrl, relayerNetwork } from "../src/relayer/runtime";

loadRepoEnv();
const warn = (m: string) => console.error(`[relayer] WARN ${m}`);
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const cfg = loadConfig();
  const network = relayerNetwork(cfg);
  const schema = arg("--schema");
  if (schema !== undefined && (network !== "devnet" || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema))) {
    throw new Error("--schema is a devnet test option and must be a plain identifier");
  }
  console.error(`[relayer] ${describeConfig(cfg)} network=${network}`);
  const keys = await openKeys(cfg, process.env, warn);
  const url = relayerDatabaseUrl(network, process.env, warn);
  const { db, lockDb } = makePools(url, keys.vaults.length, schema);
  await checkRelayerRole(db, network, warn);
  if (process.env.RELAYER_MINT_VAULTS?.trim() !== "file" && !(await checkMintVaultsAccess(db))) {
    throw new Error("mint_vaults (core 0003) is missing or not writable for this role; grant it or set RELAYER_MINT_VAULTS=file");
  }

  const connection = makeConnection(cfg);
  const { relayer, fees, pipeline, pool, attester, fairAttester, launchCurves, snapshotter, jitoTips, solInventory, quoteInventory, quoteStock, launchlab } = buildRelayer({
    cfg,
    connection,
    network,
    keys,
    db,
    lockDb,
    warn,
    onEvent: (e) => console.error(`[relayer] ${e.event} ${e.kind}${e.code ? ` ${e.code}` : ""}`),
    log: (m) => console.error(`[relayer] ${m}`),
  });

  // RELAYER v8 A1: third-party LaunchLab platforms must still match their pins (claim wallet, fees).
  if (launchlab) {
    for (const w of await launchlab.checkPlatforms()) warn(redactSecrets(w));
  }

  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => ac.abort());
  // Pool-wide priority fee: one estimate now, then the background loop (10–20 s).
  // Signing only reads this cache (R-relayer-5). Value is not logged.
  await fees.refresh();
  fees.start();
  // Fair-launch v2 (mainnet): Jito tip floor in the background (30-60 s), read-only GET; value not logged.
  if (jitoTips) {
    await jitoTips.refresh();
    jitoTips.start();
  }
  console.error(
    `[relayer] running with ${keys.vaults.length} vault(s), fee source ${cfg.priorityFeeSource}, send via ${pipeline.broadcaster.name}` +
      `${pipeline.tip ? ` (pool tip ${pipeline.tip.lamports} lamports on every tx)` : ""}, >= ${cfg.sendMinIntervalMs} ms between sends` +
      `, fair-launch ${jitoTips ? "multi-vault Jito bundles" : "single tx"}`,
  );
  // RELAYER v3: launch curve of this network (core caps), at start and every 10 min.
  const curves = (await launchCurvesWritable(db))
    ? launchCurves.run(ac.signal, (e) => warn(`launch_curves: ${redactSecrets(e instanceof Error ? e.message.split("\n", 1)[0]! : "unknown").slice(0, 160)}`))
    : (warn("launch_curves (core 0008) missing or not writable: fair launch unavailable on this network"), Promise.resolve());
  // RELAYER v4: Verify vault snapshot (poll 1-2 s; acts only while core collects).
  const verify = (await verifySnapshotsWritable(db))
    ? snapshotter.run(ac.signal, (e) => warn(`verify snapshot: ${redactSecrets(e instanceof Error ? e.message.split("\n", 1)[0]! : "unknown").slice(0, 160)}`))
    : (warn("verify_vaults (core 0009) missing or not writable: Verify snapshots will time out on this network"), Promise.resolve());
  // RELAYER v7: pool SOL inventory (vaults + rebalance address) at start and every ~5 min.
  // RELAYER v8 A7: pool_quote_inventory in the same loop (core plans ZEC SPL rebalances from it).
  const quotesOk = await poolQuoteInventoryWritable(db);
  if (!quotesOk) warn("pool_quote_inventory / pool_quotes (core 0019) missing or not writable: core will not plan ZEC SPL rebalances");
  const inventory = (await poolSolInventoryWritable(db))
    ? solInventory.run(ac.signal, (e) => warn(`pool inventory: ${redactSecrets(e instanceof Error ? e.message.split("\n", 1)[0]! : "unknown").slice(0, 160)}`), undefined, undefined, quotesOk ? quoteInventory : null)
    : (warn("pool_sol_inventory (core 0015) missing or not writable: core will not plan rebalances"), Promise.resolve());
  // Non-SOL pairs: quote stock per vault on a random 45-90 min schedule, until core schedules fund_quote.
  const stock = process.env.RELAYER_QUOTE_STOCK?.trim() === "1" ? quoteStock.run(ac.signal) : Promise.resolve();
  // Attestation key pays its own memo fees (never topped up from a vault).
  for (const [name, k] of [["Verify", attester], ["fair-launch", fairAttester]] as const) {
    const bal = await connection.getBalance(k.publicKey, "confirmed").catch(() => null);
    if (bal !== null && bal < 1_000_000) warn(`${name} attestation key balance < 0.001 SOL: its attest jobs will fail (fund it, not from a vault)`);
  }
  // Creator-fee sweep on its own random 6-12 h schedule (H7), same vault pool / locks / pipeline.
  const sweep =
    process.env.RELAYER_FEE_SWEEP?.trim() === "1"
      ? (
          await buildFeeSweeper({ cfg, connection, network, keys, db, pool, fees, pipeline, log: (m) => console.error(`[relayer] ${m}`) })
        ).sweeper.runForever(ac.signal, (e) =>
          console.error(`[relayer] fee sweep error: ${redactSecrets(e instanceof Error ? e.message.split("\n", 1)[0]! : "unknown").slice(0, 200)}`),
        )
      : Promise.resolve();
  // Two lanes (R-relayer-1); no lane / exec_mode in any log line (R-relayer-6).
  await relayer.runLanes(ac.signal, { nowMs: 300, batchMs: 1_000 + Math.floor(Math.random() * 1_000) }, (e) =>
    // Message only, redacted: DB/RPC errors may carry URLs; never row data (SQLSTATE detail is not printed).
    console.error(`[relayer] loop error: ${redactSecrets(e instanceof Error ? e.message.split("\n", 1)[0]! : "unknown").slice(0, 200)}`),
  );
  await sweep;
  await inventory;
  await stock;
  await curves;
  await verify;
  fees.stop();
  jitoTips?.stop();
  await db.end();
  await lockDb.end();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[relayer] fatal: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
    process.exit(1);
  });
