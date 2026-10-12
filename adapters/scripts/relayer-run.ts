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
import { loadRepoEnv, redactSecrets } from "../src/env";
import { describeConfig, loadConfig, makeConnection } from "../src/config";
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

  const { relayer } = buildRelayer({
    cfg,
    connection: makeConnection(cfg),
    network,
    keys,
    db,
    lockDb,
    warn,
    onEvent: (e) => console.error(`[relayer] ${e.event} ${e.kind}${e.code ? ` ${e.code}` : ""}`),
  });

  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => ac.abort());
  console.error(`[relayer] running with ${keys.vaults.length} vault(s)`);
  await relayer.run(ac.signal, 1_000 + Math.floor(Math.random() * 2_000), (e) =>
    // Message only, redacted: DB/RPC errors may carry URLs; never row data (SQLSTATE detail is not printed).
    console.error(`[relayer] loop error: ${redactSecrets(e instanceof Error ? e.message.split("\n", 1)[0]! : "unknown").slice(0, 200)}`),
  );
  await db.end();
  await lockDb.end();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`[relayer] fatal: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
    process.exit(1);
  });
