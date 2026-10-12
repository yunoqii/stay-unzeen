/**
 * Backfills the PUBLIC creator list (keys dir / creator-pubkeys.json) for
 * creator indices already used, so the token indexer treats every past pool
 * launch as an Unzeen launch (T1). New launches are recorded automatically
 * when the relayer derives the address. Run with the relayer's key access:
 *   pnpm keys:creators-pub
 * Prints only counts.
 */
import path from "node:path";
import pg from "pg";
import { loadConfig } from "../src/config";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { CreatorKeyring, CreatorPubkeyFile, FileCreatorIndexCounter, MemoryCreatorIndexCounter } from "../src/keys";
import { openKeys, relayerNetwork } from "../src/relayer/runtime";

loadRepoEnv();

async function main(): Promise<void> {
  const cfg = loadConfig();
  const network = relayerNetwork(cfg);
  const keys = await openKeys(cfg, process.env, (m) => console.error(`[creators-pub] WARN ${m}`));
  let next = new FileCreatorIndexCounter(path.join(cfg.keysDir, "creator-counter.json")).peek();
  if (process.env.RELAYER_STATE?.trim() === "postgres" && process.env.DATABASE_URL_RELAYER) {
    const db = new pg.Pool({ connectionString: process.env.DATABASE_URL_RELAYER, max: 1 });
    const r = await db.query<{ next_index: number }>("SELECT next_index FROM relayer_creator_counter WHERE network = $1", [network]);
    next = Math.max(next, r.rows[0]?.next_index ?? 0);
    await db.end();
  }
  const file = CreatorPubkeyFile.inDir(cfg.keysDir);
  const ring = new CreatorKeyring(keys.creatorSeed, new MemoryCreatorIndexCounter(), file);
  for (let i = 0; i < next; i++) ring.publicKey(i); // records each address
  console.error(`[creators-pub] ${next} creator address(es) recorded in ${path.basename(file.file)}`);
}

main().catch((e) => {
  console.error(`[creators-pub] fatal: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
  process.exit(1);
});
