/**
 * Funds Bags launch wallets IN ADVANCE (mainnet; lead approval required for any mainnet send):
 *   pnpm bags:fund --count 3 [--dry-run]
 * Each wallet = a freshly allocated creator index, ONE transfer of BAGS_WALLET_FUND_LAMPORTS
 * (default 0.05 SOL, a round amount) from the pool's Bags funder key (never a vault). Run on its
 * own schedule, not around launches. Wallets are listed (public data) in <keys dir>/bags-wallets.json.
 */
import path from "node:path";
import { loadConfig, makeConnection } from "../src/config";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { BagsCreatorFunder, BagsWalletStore, deriveBagsFunderKeypair } from "../src/bags";
import { CreatorKeyring, FileCreatorIndexCounter } from "../src/keys";
import { formatUnits } from "../src/math";
import { openKeys } from "../src/relayer/runtime";

loadRepoEnv();
const argv = process.argv.slice(2);
const count = Number(argv[argv.indexOf("--count") + 1] ?? "1");

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.cluster !== "mainnet-beta") throw new Error("Bags is mainnet only");
  const conn = makeConnection(cfg);
  const keys = await openKeys(cfg, process.env, (m) => console.error(`WARN ${m}`));
  const funder = deriveBagsFunderKeypair(keys.creatorSeed);
  const amount = BigInt(process.env.BAGS_WALLET_FUND_LAMPORTS?.trim() || "50000000");
  const store = new BagsWalletStore(path.join(cfg.keysDir, "bags-wallets.json"));
  const bal = BigInt(await conn.getBalance(funder.publicKey, "confirmed"));
  console.log(`funder ${funder.publicKey.toBase58()} ${formatUnits(bal, 9)} SOL; ${store.unused().length} funded unused wallet(s); target ${count}, ${formatUnits(amount, 9)} SOL each`);
  if (argv.includes("--dry-run")) return;
  const creators = new CreatorKeyring(keys.creatorSeed, new FileCreatorIndexCounter(path.join(cfg.keysDir, "creator-counter.json")));
  const n = await new BagsCreatorFunder({ connection: conn, funder, creators, store, amount, priorityMicroLamports: cfg.priorityMicroLamports }).ensure(count);
  console.log(`funded ${n} wallet(s)`);
}

main().catch((e) => {
  console.error(redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 400));
  process.exit(1);
});
