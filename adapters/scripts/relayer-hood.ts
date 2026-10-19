/**
 * Production relayer of the Robinhood Chain instance (venue pons, RELAYER v14).
 *
 *   pnpm relayer:hood              # until SIGINT / SIGTERM
 *
 * Env (repo-root .env, see docs/RUNBOOK.md "Robinhood Chain (hood)"):
 *   UNZEEN_HOOD=on, HOOD_NETWORK=mainnet|testnet, HOOD_RPC_URL_<NET>, HOOD_SEND_RPC_URL_<NET>,
 *   UNZEEN_ALLOW_HOOD_MAINNET=yes (mainnet sends; lead's approval), HOOD_KEYS_AGE_KEY_FILE,
 *   DATABASE_URL_RELAYER (role unzeen_relayer of the HOOD instance DB), HOOD_VAULTS (2), HOOD_FUNDERS (8),
 *   HOOD_FEE_SWEEP=1 (creator-fee loop), HOOD_FUNDER_TARGET_WEI / HOOD_FUNDER_LOW_WEI / HOOD_FUNDER_LOT_WEI
 *   (funder thresholds, default 0.02 / 0.011 / 0.005 ETH), HOOD_FUNDER_POLL_SECS (rebalance poll, 300),
 *   HOOD_CREATOR_FUND_STEP_WEI / HOOD_CREATOR_GAS_RESERVE_WEI (funder -> creator step and creator gas
 *   reserve, default 0.01 / 0.002 ETH; a reserve below one create's upfront gas refuses to start).
 *
 * Logs: event kind + outcome code + counts only. Never per-job hashes, addresses, amounts or ids;
 * pool-wide config constants (env thresholds, fee cap, launch fee) at start-up are allowed.
 */
import path from "node:path";
import pg from "pg";
import { CreatorPubkeyFile, FileCreatorIndexCounter } from "../src/keys";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { describeHoodConfig, hoodEnabled, hoodSecretUrls, loadHoodConfig } from "../src/evm/chain";
import { FunderPool, funderOptionsFromEnv, funderPollMsFromEnv } from "../src/evm/funders";
import { openEvmKeys } from "../src/evm/keys";
import { PgLaunchStore, FileLaunchStore, type LaunchStore } from "../src/evm/relayer/launches";
import { hoodNetworkId, runHoodRelayer } from "../src/evm/relayer/runtime";
import { hoodClients, hoodExecutor, hoodPonsAdapter } from "../src/evm/runtime";
import { creatorFundingFromEnv, creatorFundingWarning } from "../src/evm/pons/creator-funding";
import { checkMintVaultsAccess, checkRelayerRole } from "../src/relayer/runtime";

loadRepoEnv();
const log = (m: string) => console.error(`[hood-relayer] ${redactSecrets(m, hoodSecretUrls())}`);

async function main(): Promise<void> {
  if (!hoodEnabled()) throw new Error("UNZEEN_HOOD is not 'on'");
  const cfg = loadHoodConfig();
  log(describeHoodConfig(cfg));
  // Mainnet guard (unchanged): without UNZEEN_ALLOW_HOOD_MAINNET=yes the executor is read-only,
  // so a relayer would only fail every job: refuse to start instead.
  if (!cfg.allowSend) throw new Error("hood mainnet sends are disabled (UNZEEN_ALLOW_HOOD_MAINNET=yes with the lead's approval)");
  const network = hoodNetworkId(cfg);

  const url = process.env.DATABASE_URL_RELAYER?.trim();
  if (!url) throw new Error("DATABASE_URL_RELAYER is not set (role unzeen_relayer of the hood DB)");
  const vaultCount = Number(process.env.HOOD_VAULTS ?? 2);
  const funderCount = Number(process.env.HOOD_FUNDERS ?? 8);
  if (!Number.isInteger(vaultCount) || vaultCount < 1 || vaultCount > 64) throw new Error("HOOD_VAULTS must be 1..64");
  // GAP-7/8: validated before anything starts (bad values refuse to start).
  const funderOpts = funderOptionsFromEnv();
  const funderPollMs = funderPollMsFromEnv();
  const creatorFunding = creatorFundingFromEnv();
  const db = new pg.Pool({ connectionString: url, max: 6 });
  const lockDb = new pg.Pool({ connectionString: url, max: vaultCount + 4 });
  db.on("error", () => undefined);
  lockDb.on("error", () => undefined);
  await checkRelayerRole(db, network === "hood" ? "mainnet-beta" : "devnet", (m) => log(`WARN ${m}`));
  if (!(await checkMintVaultsAccess(db))) throw new Error("mint_vaults missing or not writable for this role");

  const store = await openEvmKeys(cfg.keysDir, cfg.network, process.env, (m) => log(`WARN ${m}`));
  const keyring = await store.keyring({
    counter: new FileCreatorIndexCounter(path.join(cfg.keysDir, "creator-counter.json")),
    registry: new CreatorPubkeyFile(path.join(cfg.keysDir, "creator-addresses.json")),
  });
  const clients = hoodClients(cfg);
  const executor = hoodExecutor(cfg, clients);
  await executor.fees.refresh();
  // ONE pool: the adapter picks from it, the runtime tops it up (shared serialization).
  const funders = new FunderPool({ executor, keyring, count: funderCount, ...funderOpts });
  const adapter = hoodPonsAdapter(cfg, executor, keyring, funders, undefined, creatorFunding);
  if (!adapter) throw new Error("Pons V2 is not deployed on this network (testnet): nothing to relay");
  await adapter.verifyDeployment();
  // A funder at its target must be able to pay one create (warning only: funders may hold more).
  await adapter
    .factoryTerms()
    .then((t) => {
      const w = creatorFundingWarning(creatorFunding, { funderTargetWei: funderOpts.targetWei, launchFeeWei: t.launchFee, maxFeePerGas: executor.fees.maxFeePerGas });
      if (w) log(`WARN ${w}`);
    })
    .catch(() => log("WARN could not read the Pons launch fee: creator funding not checked"));

  // relayer_launches (core 0028) when this role may use it; else the 0600 file next to the keys.
  const pgLaunches = await db
    .query<{ ok: boolean }>(
      `SELECT to_regclass('relayer_launches') IS NOT NULL
              AND has_table_privilege(current_user, 'relayer_launches', 'INSERT')
              AND has_table_privilege(current_user, 'relayer_launches', 'DELETE') AS ok`,
    )
    .then((r) => r.rows[0]?.ok === true, () => false);
  const launches: LaunchStore = pgLaunches ? new PgLaunchStore(db, network) : FileLaunchStore.inDir(cfg.keysDir);
  log(`launch store: ${pgLaunches ? "postgres" : "file"}; vaults=${vaultCount} funders=${funderCount}`);

  // The attestation key pays its own fees and is topped up by the OWNER from an outside source
  // (never a vault, never the rebalance address): warn when low.
  for (const p of ["verify", "fair"] as const) {
    const bal = await executor.balance(keyring.attest(p).address).catch(() => null);
    if (bal !== null && bal < 200_000_000_000_000n) log(`WARN ${p} attestation key < 0.0002 ETH: its attest jobs will fail (owner tops it up, not from a vault)`);
  }

  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => ac.abort());
  await runHoodRelayer(
    {
      cfg,
      db,
      lockDb,
      executor,
      adapter,
      keyring,
      vaultCount,
      funderCount,
      funders,
      funderPollMs,
      launches,
      feeLoop: process.env.HOOD_FEE_SWEEP?.trim() === "1",
      log,
      onEvent: (e) => log(`${e.event} ${e.kind}${e.code ? ` ${e.code}` : ""}`),
    },
    ac.signal,
  );
  await db.end();
  await lockDb.end();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
