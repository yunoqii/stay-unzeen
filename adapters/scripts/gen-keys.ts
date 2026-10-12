/**
 * Creates vault keypairs (and the creator master seed) in UNZEEN_KEYS_DIR.
 * Prints only public keys.
 *   pnpm keys:gen [count=2]
 */
import { CreatorKeyring, ensureVaults } from "../src/keys";
import { explorerAddressUrl, loadConfig } from "../src/config";

const count = Number(process.argv[2] ?? 2);
if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error("count must be 1..64");
const cfg = loadConfig();
const vaults = ensureVaults(cfg.keysDir, count);
new CreatorKeyring(cfg.keysDir); // creates creator-master.hex if missing
console.log(`keys dir: ${cfg.keysDir}`);
vaults.forEach((v, i) => console.log(`vault-${i}: ${v.publicKey.toBase58()}  ${explorerAddressUrl(v.publicKey.toBase58(), cfg.cluster)}`));
