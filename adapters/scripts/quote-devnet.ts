/**
 * DEVNET e2e of a non-SOL pair (Meteora DBC, quote = Raydium's devnet USDC `USDCoct…`):
 *   pnpm quote:devnet           # Meteora DBC, Raydium's devnet USDC
 *   pnpm quote:devnet --pump    # pump.fun, pump's devnet USDC 4zMMC9…
 * 1. quote stock: vault-0 buys a small USDC stock on pool A (DAMM v2 SOL/USDC) — the scheduled
 *    `fund_quote` operation, run here once by hand;
 * 2. create + first buy in USDC, paid from the stock (no swap leg);
 * 3. buy bigger than the stock: the SAME tx carries the pool-A ExactOut leg (fallback);
 * 4. sell half: proceeds stay as USDC stock; the ledger value is in lamports.
 * Prints explorer links, lamport amounts the ledger would book, quote amounts for the feed.
 */
import path from "node:path";
import type { Keypair } from "@solana/web3.js";
import { explorerAddressUrl, explorerTxUrl, loadConfig, makeConnection } from "../src/config";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { CreatorKeyring, FileCreatorIndexCounter } from "../src/keys";
import { formatUnits } from "../src/math";
import { MeteoraDbcAdapter, dbcConfigAddress } from "../src/meteora";
import { PumpFunAdapter } from "../src/pumpfun";
import { quoteAssets } from "../src/pool-a";
import { QuoteStocker } from "../src/relayer/quote-stock";
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
const usdc = (u: bigint) => `${formatUnits(u, 6)} USDC`;

function show(label: string, r: TxResult & { quoteSource?: string }): void {
  console.log(
    `  ${label}: tokens=${formatUnits(r.tokenAmount, r.decimals)} ledger=${sol(r.solAmount)} quote=${r.quoteAmount !== undefined ? usdc(r.quoteAmount) : "-"} source=${r.quoteSource ?? "-"} fee=${r.networkFee}`,
  );
  console.log(`    ${explorerTxUrl(r.signature, cfg.cluster)}`);
}

async function main(): Promise<void> {
  const keys = await openKeys(cfg, process.env, (m) => console.log(`  WARN ${m}`));
  const v0 = keys.vaults[0] as Keypair;
  const pump = process.argv.includes("--pump");
  const asset = quoteAssets(cfg.cluster, process.env, pump ? "pumpfun" : "meteora-dbc").find((a) => a.symbol === "USDC");
  if (!asset?.poolA || (!pump && !asset.dbcConfig)) throw new Error("devnet USDC route not configured");
  const solConfig = dbcConfigAddress(cfg.cluster);
  if (!solConfig) throw new Error("no SOL DBC config on devnet");
  const creators = new CreatorKeyring(keys.creatorSeed, new FileCreatorIndexCounter(path.join(cfg.keysDir, "creator-counter.json")));
  const adapter = pump
    ? new PumpFunAdapter({ connection: conn, defaultVault: v0, vaults: keys.vaults, creators, stateDir: cfg.keysDir, priorityMicroLamports: cfg.priorityMicroLamports, quotes: [asset] })
    : new MeteoraDbcAdapter({ connection: conn, config: solConfig, defaultVault: v0, vaults: keys.vaults, creators, stateDir: cfg.keysDir, priorityMicroLamports: cfg.priorityMicroLamports, quotes: [asset] });
  // pump's devnet pool A prices 1 USDC at ~0.086 SOL: keep amounts small there.
  const STOCK = pump ? 200_000n : 1_000_000n;
  const CREATE_BUY = pump ? 5_000_000n : 4_000_000n;
  const BIG_BUY = pump ? 30_000_000n : 20_000_000n;
  console.log(`${pump ? "pump.fun" : "Meteora DBC"}; vault-0 ${v0.publicKey.toBase58()} ${sol(BigInt(await conn.getBalance(v0.publicKey)))}; quote ${asset.mint.toBase58()} pool A ${asset.poolA.toBase58()}${asset.dbcConfig ? ` config ${asset.dbcConfig.toBase58()}` : ""}`);

  console.log(`\n[1] quote stock (fund_quote): target ${usdc(STOCK)} on vault-0`);
  const stocker = new QuoteStocker({ connection: conn, asset, policy: { target: STOCK, low: STOCK / 2n, high: STOCK * 3n }, priorityMicroLamports: cfg.priorityMicroLamports });
  const before = await stocker.stock(v0.publicKey);
  const p = await stocker.prepare(v0);
  if (p) {
    await stocker.submit(p);
    const r = await stocker.result(p.signature, p.vault);
    console.log(`  ${p.action.kind} ${usdc(p.action.units)}: ${r ? `${usdc(r.quoteDelta)} for ${sol(r.lamports)}` : "?"}`);
    console.log(`    ${explorerTxUrl(p.signature, cfg.cluster)}`);
  } else console.log(`  stock ${usdc(before)} already within bounds`);
  console.log(`  stock now ${usdc(await stocker.stock(v0.publicKey))}`);

  console.log(`\n[2] create + first buy in USDC from the stock (${sol(CREATE_BUY)} worth)`);
  const created = await adapter.create({ name: "Unzeen USDC Test", symbol: "UNZU", uri: "https://unzeen.invalid/meta/usdc-test.json" }, CREATE_BUY, { quote: "USDC" });
  show("create", created);
  console.log(`    mint ${explorerAddressUrl(created.mint, cfg.cluster)}`);
  const mint = created.mint;
  console.log(`  stock now ${usdc(await stocker.stock(v0.publicKey))}`);

  console.log(`\n[3] buy bigger than the stock (${sol(BIG_BUY)} worth): pool-A leg in the same tx`);
  const q = await adapter.quote(mint, "buy", BIG_BUY);
  console.log(`  quote: ${formatUnits(q.amountOut, q.decimals)} tokens, price ${q.priceSol} SOL (${q.priceQuote} USDC), mcap ${q.marketCapSol} SOL`);
  const bought = await adapter.buy(mint, BIG_BUY, (q.amountOut * 95n) / 100n);
  show("buy", bought);
  console.log(`  stock now ${usdc(await stocker.stock(v0.publicKey))}`);

  console.log("\n[4] sell half: USDC proceeds stay as stock");
  const half = (created.tokenAmount + bought.tokenAmount) / 2n;
  const sold = await adapter.sell(mint, half, 0n);
  show("sell", sold);
  console.log(`  stock now ${usdc(await stocker.stock(v0.publicKey))}`);
  console.log(`  market: ${JSON.stringify(await adapter.market(mint))}`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(redactSecrets(e instanceof Error ? (e.stack ?? e.message) : String(e)).slice(0, 2000));
    process.exit(1);
  });
