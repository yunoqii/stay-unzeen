/**
 * End-to-end on Solana devnet with real transactions:
 *   airdrop -> create (+ first buy, one tx) from vault-0 with a fresh creator
 *   -> quote -> buy from vault-1 -> error paths -> quote -> sell -> status.
 *
 *   pnpm e2e:devnet
 */
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  Keypair,
} from "@solana/web3.js";
import { AdapterError } from "../src/errors";
import { CreatorKeyring, ensureVaults } from "../src/keys";
import { explorerAddressUrl, explorerTxUrl, loadConfig, makeConnection } from "../src/config";
import { formatUnits, minOutWithSlippage } from "../src/math";
import { PumpFunAdapter } from "../src/pumpfun";
import { fetchTx } from "../src/tx";
import { lamportDelta } from "../src/events";
import type { TxResult } from "../src/types";

const SOL = BigInt(LAMPORTS_PER_SOL);
// vault-0: create + 0.05 first buy + rent + its lookup table (~0.08 SOL);
// vault-1: 0.02 buy + ATA/accumulator rent (~0.03 SOL). Funding only vault-0
// with >= 0.2 SOL is enough: vault-1 is topped up from it.
const TARGET = [(SOL * 12n) / 100n, (SOL * 4n) / 100n];
const INITIAL_BUY = SOL / 20n; //       0.05 SOL first buy at create
const BUY = SOL / 50n; //               0.02 SOL buy from vault-1
const SLIPPAGE_BPS = 100; //            1%

const cfg = loadConfig();
if (cfg.cluster !== "devnet" && cfg.cluster !== "localnet") {
  console.error(`refusing to run e2e on ${cfg.cluster}: devnet only`);
  process.exit(1);
}
const conn = makeConnection(cfg);
const tx = (sig: string) => explorerTxUrl(sig, cfg.cluster);
const sol = (l: bigint) => `${formatUnits(l, 9)} SOL`;

async function balance(pk: PublicKey): Promise<bigint> {
  return BigInt(await conn.getBalance(pk, "confirmed"));
}

async function airdrop(pk: PublicKey, lamports: bigint): Promise<boolean> {
  // Separate connection without web3.js's built-in 429 backoff (~8 s per call):
  // a rate-limited faucet answers "limit reached" for the whole day anyway.
  const faucet = new Connection(cfg.rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true });
  for (let i = 0; i < 2; i++) {
    try {
      const sig = await faucet.requestAirdrop(pk, Number(lamports));
      const bh = await conn.getLatestBlockhash("confirmed");
      await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
      console.log(`  airdrop ${sol(lamports)} -> ${pk.toBase58()}  ${tx(sig)}`);
      return true;
    } catch (e) {
      const msg = (e as Error).message.split("\n", 1)[0] ?? "";
      console.log(`  airdrop attempt ${i + 1} failed: ${msg.slice(0, 120)}`);
      if (/429|limit/i.test(msg)) return false;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return false;
}

async function fund(vaults: Keypair[]): Promise<void> {
  console.log("\n[1] funding vaults (existing balance -> transfer from another vault -> devnet airdrop)");
  for (let i = 0; i < vaults.length; i++) {
    const v = vaults[i]!;
    const want = TARGET[i] ?? SOL / 10n;
    const have = await balance(v.publicKey);
    console.log(`  vault-${i} ${v.publicKey.toBase58()} has ${sol(have)}`);
    if (have >= want) continue;
    // Prefer an internal top-up: no faucet round-trips when the pool has SOL.
    let donated = false;
    for (let j = 0; j < vaults.length && !donated; j++) {
      const d = vaults[j]!;
      if (d === v) continue;
      if ((await balance(d.publicKey)) > (TARGET[j] ?? 0n) + want) {
        const t = new Transaction().add(
          SystemProgram.transfer({ fromPubkey: d.publicKey, toPubkey: v.publicKey, lamports: want - have }),
        );
        const sig = await sendAndConfirmTransaction(conn, t, [d], { commitment: "confirmed" });
        console.log(`  transfer ${sol(want - have)} from vault-${j}  ${tx(sig)}`);
        donated = true;
      }
    }
    if (donated) continue;
    if (await airdrop(v.publicKey, SOL)) continue;
    console.error(
      `\nCannot fund vault-${i}. Devnet faucet refused. Fund it manually at https://faucet.solana.com ` +
        `(address ${v.publicKey.toBase58()}) and rerun.`,
    );
    process.exit(2);
  }
}

async function crossCheck(c: Connection, r: TxResult): Promise<void> {
  const t = await fetchTx(c, r.signature);
  if (!t) return;
  const d = lamportDelta(t, new PublicKey(r.vault)) + r.networkFee;
  console.log(`    check: vault SOL delta excl. network fee = ${sol(d)} (includes rent on first touch)`);
}

function show(label: string, r: TxResult): void {
  console.log(`  ${label}: ${r.signature}`);
  console.log(`    ${tx(r.signature)}`);
  console.log(
    `    tokens=${formatUnits(r.tokenAmount, r.decimals)} sol=${sol(r.solAmount)} networkFee=${r.networkFee} slot=${r.slot}`,
  );
}

async function expectError(label: string, code: string, f: () => Promise<unknown>): Promise<void> {
  try {
    await f();
    console.log(`  [FAIL] ${label}: expected ${code}, call succeeded`);
    process.exitCode = 1;
  } catch (e) {
    if (e instanceof AdapterError && e.code === code) {
      console.log(`  [ok] ${label}: ${e.code} -> API ${e.apiCode} (${e.message})`);
    } else {
      console.log(`  [FAIL] ${label}: expected ${code}, got ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
}

async function main(): Promise<void> {
  console.log(`cluster=${cfg.cluster} rpc=${new URL(cfg.rpcUrl).host}`);
  const vaults = ensureVaults(cfg.keysDir, 2);
  const [v0, v1] = vaults as [Keypair, Keypair];
  await fund(vaults);

  const adapter = new PumpFunAdapter({
    connection: conn,
    defaultVault: v0,
    vaults,
    creators: new CreatorKeyring(cfg.keysDir),
    stateDir: cfg.keysDir,
    priorityMicroLamports: cfg.priorityMicroLamports,
  });

  console.log("\n[2] create + first buy (one tx), payer vault-0, fresh creator");
  const created = await adapter.create(
    { name: "Unzeen Devnet Test", symbol: "UNZT", uri: "https://unzeen.invalid/meta/devnet-test.json" },
    INITIAL_BUY,
  );
  show("create", created);
  console.log(`    mint=${created.mint}  ${explorerAddressUrl(created.mint, cfg.cluster)}`);
  console.log(`    creator=${created.creator} (index ${created.creatorIndex}), vault-0=${v0.publicKey.toBase58()}`);
  await crossCheck(conn, created);
  const mint = created.mint;

  console.log("\n[3] status");
  console.log(`  status=${await adapter.status(mint)}`);

  console.log("\n[4] quote + buy from vault-1");
  const qb = await adapter.quote(mint, "buy", BUY);
  console.log(
    `  quote buy ${sol(BUY)} -> ${formatUnits(qb.amountOut, qb.decimals)} tokens, price=${qb.priceSol} SOL, mcap=${qb.marketCapSol} SOL`,
  );
  const minOut = minOutWithSlippage(qb.amountOut, SLIPPAGE_BPS);
  const bought = await adapter.buy(mint, BUY, minOut, { vault: v1 });
  show("buy", bought);
  await crossCheck(conn, bought);

  console.log("\n[5] error paths (no tx sent)");
  await expectError("buy with unreachable minOut", "slippage", () =>
    adapter.buy(mint, BUY, qb.amountOut * 2n, { vault: v1 }),
  );
  await expectError("sell more than held", "insufficient_tokens", () =>
    adapter.sell(mint, bought.tokenAmount * 10n, 0n, { vault: v1 }),
  );
  await expectError("quote unknown mint", "not_found", () =>
    adapter.quote(Keypair.generate().publicKey.toBase58(), "buy", BUY),
  );

  console.log("\n[6] quote + sell half from vault-1");
  const toSell = bought.tokenAmount / 2n;
  const qs = await adapter.quote(mint, "sell", toSell);
  console.log(`  quote sell ${formatUnits(toSell, qs.decimals)} tokens -> ${sol(qs.amountOut)}`);
  const sold = await adapter.sell(mint, toSell, minOutWithSlippage(qs.amountOut, SLIPPAGE_BPS), { vault: v1 });
  show("sell", sold);
  await crossCheck(conn, sold);

  console.log("\n[7] status");
  console.log(`  status=${await adapter.status(mint)}`);

  console.log("\nsummary");
  console.log(`  create ${tx(created.signature)}`);
  console.log(`  buy    ${tx(bought.signature)}`);
  console.log(`  sell   ${tx(sold.signature)}`);
}

main().catch((e) => {
  if (e instanceof AdapterError) {
    console.error(`AdapterError ${e.code} (API ${e.apiCode}): ${e.message}`, e.programError ?? "", e.signature ?? "");
    const cause = (e as { cause?: unknown }).cause;
    if (cause) console.error(cause);
  } else {
    console.error(e);
  }
  process.exit(1);
});
