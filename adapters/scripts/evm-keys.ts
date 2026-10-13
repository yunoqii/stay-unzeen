/**
 * Creates (on first run) the pool's EVM seed for Robinhood Chain and prints
 * ADDRESSES ONLY: vaults, rotating funders (HOOD_FUNDERS, default 8), rebalance, Verify attest key.
 *   pnpm evm:keys [vaultCount=2]
 *
 * Network: HOOD_NETWORK (testnet default). Dir: HOOD_KEYS_DIR or
 * $UNZEEN_HOME/hood-<network>/evm. Encryption: HOOD_KEYS_AGE_KEY_FILE (falls back
 * to SOLANA_KEYS_AGE_KEY_FILE); required on mainnet. Never prints the mnemonic
 * or private keys; creator addresses are derived per launch (only their count is shown).
 */
import fs from "node:fs";
import path from "node:path";
import { loadRepoEnv } from "../src/env";
import { describeHoodConfig, hoodEnabled, loadHoodConfig } from "../src/evm/chain";
import { openEvmKeys } from "../src/evm/keys";

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 2);
  if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error("vault count must be 1..64");
  loadRepoEnv();
  if (!hoodEnabled()) console.error("note: UNZEEN_HOOD is not 'on' (feature flag off); keys are created anyway");
  const cfg = loadHoodConfig();
  console.log(describeHoodConfig(cfg));
  const store = await openEvmKeys(cfg.keysDir, cfg.network, process.env, (m) => console.error(`WARN ${m}`));
  const kr = await store.keyring({ registry: null });
  console.log(`keys dir: ${cfg.keysDir} (${store.encrypted ? "age-encrypted" : "PLAINTEXT"})`);
  kr.vaultAddresses(count).forEach((a, i) => console.log(`vault-${i}:     ${a}`));
  const funders = Number(process.env.HOOD_FUNDERS ?? 8);
  for (let i = 0; i < funders; i++) console.log(`funder-${i}:    ${kr.funder(i).address}`);
  console.log(`rebalance-0: ${kr.rebalance(0).address}`);
  console.log(`attest:      ${kr.attest("verify").address}  (Verify, EIP-712)`);
  const counter = path.join(cfg.keysDir, "creator-counter.json");
  const used = fs.existsSync(counter) ? (JSON.parse(fs.readFileSync(counter, "utf8")) as { next?: number }).next ?? 0 : 0;
  console.log(`creators used: ${used}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
