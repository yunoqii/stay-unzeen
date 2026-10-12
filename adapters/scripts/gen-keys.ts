/**
 * Creates vault keypairs (and the creator master seed) in the Solana keys dir
 * ($UNZEEN_HOME/<cluster>/solana). Encrypted with age when SOLANA_KEYS_AGE_KEY_FILE
 * is set (required on mainnet). Prints only public keys.
 *   pnpm keys:gen [count=2]
 */
import { explorerAddressUrl, loadConfig } from "../src/config";
import { loadRepoEnv } from "../src/env";
import { openKeys } from "../src/relayer/runtime";

const count = Number(process.argv[2] ?? 2);
if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error("count must be 1..64");
loadRepoEnv();
const cfg = loadConfig();
openKeys(cfg, process.env, (m) => console.error(`WARN ${m}`), count)
  .then(({ vaults, store }) => {
    console.log(`keys dir: ${cfg.keysDir} (${store.encrypted ? "age-encrypted" : "PLAINTEXT"})`);
    vaults.forEach((v, i) => console.log(`vault-${i}: ${v.publicKey.toBase58()}  ${explorerAddressUrl(v.publicKey.toBase58(), cfg.cluster)}`));
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
