/**
 * DEVNET e2e of the Raydium LaunchLab adapter on Unzeen's own platform:
 *   pnpm launchlab:devnet
 * [1] SOL pair: create + first buy (fresh HD creator, vault pays), buy, sell half.
 * [2] USDC pair (Raydium devnet USDC, GlobalConfig 4wHbNk…): create + first buy from the
 *     vault's quote stock, a buy bigger than the stock (pool-A leg in the same tx), sell.
 * stonk.fun / bonk.fun have no devnet platform: their IDs are mainnet constants.
 */
import path from "node:path";
import type { Keypair } from "@solana/web3.js";
import { getPdaPlatformId } from "@raydium-io/raydium-sdk-v2";
import { explorerAddressUrl, explorerTxUrl, loadConfig, makeConnection } from "../src/config";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { CreatorKeyring, FileCreatorIndexCounter } from "../src/keys";
import { LAUNCHLAB_PROGRAM, LaunchLabAdapter } from "../src/launchlab";
import { formatUnits } from "../src/math";
import { derivePartnerKeypair } from "../src/meteora";
import { quoteAssets } from "../src/pool-a";
import { openKeys } from "../src/relayer/runtime";
import type { TxResult } from "../src/types";

loadRepoEnv();
const cfg = loadConfig();
if (cfg.cluster !== "devnet") {
  console.error("devnet only");
  process.exit(1);
}
const conn = makeConnection(cfg);
const sol = (l: bigint) => `${formatUnits(l, 9)} SOL`;

function show(label: string, r: TxResult): void {
  console.log(
    `  ${label}: tokens=${formatUnits(r.tokenAmount, r.decimals)} ledger=${sol(r.solAmount)}${r.quoteAmount !== undefined ? ` quote=${formatUnits(r.quoteAmount, 6)} USDC source=${r.quoteSource ?? "-"}` : ""} fee=${r.networkFee}`,
  );
  console.log(`    ${explorerTxUrl(r.signature, cfg.cluster)}`);
}

async function run(a: LaunchLabAdapter, label: string, quote: string | undefined, createBuy: bigint, buy: bigint): Promise<void> {
  console.log(`\n${label}`);
  const p = await a.prepareCreate({ name: `Unzeen LL ${quote ?? "SOL"}`, symbol: quote ? "UNZLU" : "UNZLS", uri: "https://unzeen.invalid/meta/ll-test.json" }, createBuy, 0n, { ...(quote ? { quote } : {}), platform: "unzeen" });
  const sent = await a.submit(p);
  const created = await a.createResult(sent.signature, p.vault);
  if (!created) throw new Error("create not readable");
  show("create", created);
  console.log(`    mint ${explorerAddressUrl(created.mint, cfg.cluster)}  creator ${created.creator} (fresh, index ${p.creatorIndex})`);
  const q = await a.quote(created.mint, "buy", buy);
  console.log(`  quote: ${formatUnits(q.amountOut, q.decimals)} tokens, price ${q.priceSol} SOL${q.priceQuote ? ` (${q.priceQuote} USDC)` : ""}, mcap ${q.marketCapSol} SOL`);
  const pb = await a.prepareBuy(created.mint, buy, (q.amountOut * 95n) / 100n);
  const sb = await a.submit(pb);
  const bought = await a.tradeResult("buy", sb.signature, pb.vault, created.mint);
  if (!bought) throw new Error("buy not readable");
  show("buy", bought);
  const half = (created.tokenAmount + bought.tokenAmount) / 2n;
  const ps = await a.prepareSell(created.mint, half, 0n);
  const ss = await a.submit(ps);
  const sold = await a.tradeResult("sell", ss.signature, ps.vault, created.mint);
  if (!sold) throw new Error("sell not readable");
  show("sell", sold);
  console.log(`  market: ${JSON.stringify(await a.market(created.mint))}`);
}

async function main(): Promise<void> {
  const keys = await openKeys(cfg, process.env, (m) => console.log(`  WARN ${m}`));
  const v0 = keys.vaults[0] as Keypair;
  const unzeen = getPdaPlatformId(LAUNCHLAB_PROGRAM.devnet, derivePartnerKeypair(keys.creatorSeed).publicKey).publicKey;
  const a = new LaunchLabAdapter({
    connection: conn,
    cluster: "devnet",
    defaultVault: v0,
    vaults: keys.vaults,
    creators: new CreatorKeyring(keys.creatorSeed, new FileCreatorIndexCounter(path.join(cfg.keysDir, "creator-counter.json"))),
    stateDir: cfg.keysDir,
    unzeenPlatform: unzeen,
    quotes: quoteAssets("devnet", process.env, "meteora-dbc"),
    priorityMicroLamports: cfg.priorityMicroLamports,
  });
  console.log(`LaunchLab ${LAUNCHLAB_PROGRAM.devnet.toBase58()} platform unzeen ${unzeen.toBase58()}; vault-0 ${v0.publicKey.toBase58()} ${sol(BigInt(await conn.getBalance(v0.publicKey)))}`);
  await run(a, "[1] SOL pair", undefined, 10_000_000n, 10_000_000n);
  await run(a, "[2] USDC pair (stock, then leg)", "USDC", 4_000_000n, 20_000_000n);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    const f = e as { message?: string; cause?: { logs?: string[] } };
    console.error(redactSecrets(e instanceof Error ? (e.stack ?? e.message) : JSON.stringify(f)).slice(0, 2000));
    process.exit(1);
  });
