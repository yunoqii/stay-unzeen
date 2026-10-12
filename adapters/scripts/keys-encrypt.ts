/**
 * Encrypts the pool's Solana secrets (vault-*.json, creator-master.hex) with age, in place, without loss.
 *
 *   SOLANA_KEYS_AGE_KEY_FILE=~/.unzeen/solana-devnet.agekey pnpm keys:encrypt
 *
 * Creates the identity file (0600) if it does not exist yet; it must be OUTSIDE the keys dir
 * (production: /etc/unzeen or a systemd credential, not on the data volume; review-day3 N2/N9).
 * Then add SOLANA_KEYS_AGE_KEY_FILE to the repo-root .env. Prints only public keys and file names.
 */
import fs from "node:fs";
import path from "node:path";
import { loadRepoEnv, PKG_ROOT } from "../src/env";
import { loadConfig } from "../src/config";
import { KeyStore, ageCipher, createAgeIdentityFile, resolveAgeIdentity } from "../src/keystore";

loadRepoEnv();
const cfg = loadConfig();

async function main(): Promise<void> {
  const fileVar = process.env.SOLANA_KEYS_AGE_KEY_FILE?.trim();
  if (!fileVar && !process.env.SOLANA_KEYS_AGE_KEY) throw new Error("set SOLANA_KEYS_AGE_KEY_FILE (path outside the keys dir)");
  if (fileVar) {
    const file = path.resolve(PKG_ROOT, fileVar.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    if (!fs.existsSync(file)) console.log(`created age identity ${file} (recipient ${await createAgeIdentityFile(file, cfg.keysDir)})`);
  }
  const id = resolveAgeIdentity(cfg.keysDir)!;
  const cipher = await ageCipher(id.identity);
  console.log(`keys dir: ${cfg.keysDir}\nrecipient: ${cipher.recipient}`);
  const before = (await KeyStore.open(cfg.keysDir, { cipher: null }).vaults()).map((k) => k.publicKey.toBase58());
  const { encrypted } = await KeyStore.forMigration(cfg.keysDir, cipher).migrate();
  console.log(encrypted.length ? `encrypted: ${encrypted.join(", ")}` : "nothing to encrypt");
  const ks = KeyStore.open(cfg.keysDir, { cipher });
  const after = (await ks.vaults()).map((k) => k.publicKey.toBase58());
  await ks.creatorSeed();
  if (before.length > 0 && JSON.stringify(before) !== JSON.stringify(after)) throw new Error("vault set changed during migration");
  after.forEach((v, i) => console.log(`vault-${i}: ${v}`));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
