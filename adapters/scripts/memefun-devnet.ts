/**
 * DEVNET e2e of the meme.fun adapter (same program ID as mainnet):
 *   pnpm memefun:devnet [--uri <ipfs://… | https://…/ipfs/…>]
 * create (fresh HD creator funded by the vault in the same tx with exactly what the create
 * costs; first buy by the vault), a buy, a sell of half. meme.fun requires content-addressed
 * metadata; without Pinata this uses a fixed public CID (devnet only, the JSON is not ours).
 */
import path from "node:path";
import type { Keypair } from "@solana/web3.js";
import { explorerAddressUrl, explorerTxUrl, loadConfig, makeConnection } from "../src/config";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { CreatorKeyring, FileCreatorIndexCounter } from "../src/keys";
import { formatUnits } from "../src/math";
import { MemeFunAdapter } from "../src/memefun";
import { openKeys } from "../src/relayer/runtime";
import type { TxResult } from "../src/types";

loadRepoEnv();
const cfg = loadConfig();
if (cfg.cluster !== "devnet") {
  console.error("devnet only");
  process.exit(1);
}
const conn = makeConnection(cfg);
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sol = (l: bigint) => `${formatUnits(l, 9)} SOL`;
const show = (label: string, r: TxResult) => {
  console.log(`  ${label}: tokens=${formatUnits(r.tokenAmount, r.decimals)} sol=${sol(r.solAmount)} fee=${r.networkFee}`);
  console.log(`    ${explorerTxUrl(r.signature, cfg.cluster)}`);
};

async function main(): Promise<void> {
  const keys = await openKeys(cfg, process.env, (m) => console.log(`  WARN ${m}`));
  const v0 = keys.vaults[0] as Keypair;
  const a = new MemeFunAdapter({
    connection: conn,
    defaultVault: v0,
    vaults: keys.vaults,
    creators: new CreatorKeyring(keys.creatorSeed, new FileCreatorIndexCounter(path.join(cfg.keysDir, "creator-counter.json"))),
    stateDir: cfg.keysDir,
    priorityMicroLamports: cfg.priorityMicroLamports,
  });
  const before = BigInt(await conn.getBalance(v0.publicKey));
  console.log(`vault-0 ${v0.publicKey.toBase58()} ${sol(before)}`);
  const uri = arg("--uri") ?? "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
  const p = await a.prepareCreate({ name: "Unzeen meme test", symbol: "UNZM", uri }, 10_000_000n, 0n);
  console.log(`create: ${p.raw.length} B, creator ${p.creator} (fresh, index ${p.creatorIndex}), quoted ${formatUnits(p.expectedOut, 6)} tokens`);
  const s = await a.submit(p);
  const c = await a.createResult(s.signature, p.vault);
  if (!c) throw new Error("create not readable");
  show("create", c);
  console.log(`    mint ${explorerAddressUrl(c.mint, cfg.cluster)}`);
  const creatorLeft = await conn.getBalance(c.creator ? new (await import("@solana/web3.js")).PublicKey(c.creator) : v0.publicKey);
  console.log(`  creator balance after create: ${creatorLeft} lamports (expected 0)`);
  const q = await a.quote(c.mint, "buy", 20_000_000n);
  console.log(`  quote 0.02 SOL: ${formatUnits(q.amountOut, 6)} tokens, price ${q.priceSol} SOL, cap ${q.marketCapSol} SOL`);
  const pb = await a.prepareBuy(c.mint, 20_000_000n, (q.amountOut * 98n) / 100n);
  const sb = await a.submit(pb);
  const b = await a.tradeResult("buy", sb.signature, pb.vault, c.mint);
  if (!b) throw new Error("buy not readable");
  show("buy", b);
  const half = (c.tokenAmount + b.tokenAmount) / 2n;
  const ps = await a.prepareSell(c.mint, half, 0n);
  const ss = await a.submit(ps);
  const sd = await a.tradeResult("sell", ss.signature, ps.vault, c.mint);
  if (!sd) throw new Error("sell not readable");
  show("sell", sd);
  console.log(`  market: ${JSON.stringify(await a.market(c.mint))}`);
  const after = BigInt(await conn.getBalance(v0.publicKey));
  console.log(`vault-0 spent ${sol(before - after)} in total`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    const f = e as { message?: string; cause?: { logs?: string[] } };
    console.error(redactSecrets(e instanceof Error ? (e.stack ?? e.message) : JSON.stringify(f)).slice(0, 2000));
    for (const l of (f.cause?.logs ?? []).slice(-15)) console.error(`  ${l}`);
    process.exit(1);
  });
