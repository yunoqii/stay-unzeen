/**
 * Relayer end-to-end on Solana devnet with real transactions:
 *   in-memory queue -> buy -> sell -> withdraw (gas drop + transfer to a fresh
 *   address, from a vault other than the buyer's), all through the relayer engine.
 *
 *   pnpm relayer:devnet                # auto-picks a pump.fun mint held by the vaults
 *   pnpm relayer:devnet --mint <mint>  # explicit mint
 *   pnpm relayer:devnet --status       # balances only, no transactions
 *
 * Reads <repo>/.env (SOLANA_RPC_URL_DEVNET etc.); the RPC URL is never printed.
 * Dev tool: prints signatures (public data). There are no users here, so no
 * job/action ids are linked to anything.
 */
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { bondingCurvePda } from "@pump-fun/pump-sdk";
import { AdapterError } from "../src/errors";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { describeConfig, explorerAddressUrl, explorerTxUrl, loadConfig, makeConnection } from "../src/config";
import { CreatorKeyring, ensureVaults } from "../src/keys";
import { formatUnits, minOutWithSlippage } from "../src/math";
import { PumpFunAdapter } from "../src/pumpfun";
import { TokenWithdrawer } from "../src/withdraw";
import {
  InMemoryJobQueue,
  PumpFunTradeExecutor,
  Relayer,
  RpcChainProbe,
  RpcVaultInventory,
  VaultPool,
  WithdrawExecutor,
  cryptoRng,
  withdrawSchedule,
  type Execution,
  type JobSpec,
  type RelayerEvent,
} from "../src/relayer";

const SOL = BigInt(LAMPORTS_PER_SOL);
const VAULTS = 3;
const MIN_VAULT_SOL = (SOL * 3n) / 100n; // 0.03 SOL per vault for buys / gas drops
const BUY = SOL / 100n; //                  0.01 SOL
const SLIPPAGE_BPS = 300;
// Demo-sized delays (production: API.md jitter / 1–10 min for withdrawals).
const DEMO_JITTER = { epochMinMs: 1_000, epochMaxMs: 3_000, jitterMaxMs: 4_000 };
const DEMO_WITHDRAW_DELAY = { minMs: 5_000, maxMs: 20_000 };

loadRepoEnv();
const cfg = loadConfig();
if (cfg.cluster !== "devnet") {
  console.error(`refusing to run on ${cfg.cluster}: devnet only`);
  process.exit(1);
}
const conn = makeConnection(cfg);
const txUrl = (sig: string) => explorerTxUrl(sig, cfg.cluster);
const sol = (l: bigint) => `${formatUnits(l, 9)} SOL`;
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function holdings(vault: PublicKey): Promise<Map<string, bigint>> {
  const m = new Map<string, bigint>();
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const r = await conn.getParsedTokenAccountsByOwner(vault, { programId }, "confirmed");
    for (const a of r.value) {
      const info = (a.account.data as { parsed: { info: { mint: string; tokenAmount: { amount: string } } } }).parsed.info;
      m.set(info.mint, (m.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount));
    }
  }
  return m;
}

async function topUp(vaults: Keypair[]): Promise<void> {
  const bal = await Promise.all(vaults.map(async (v) => BigInt(await conn.getBalance(v.publicKey, "confirmed"))));
  for (let i = 0; i < vaults.length; i++) {
    if (bal[i]! >= MIN_VAULT_SOL) continue;
    const need = MIN_VAULT_SOL - bal[i]! + SOL / 100n;
    const j = bal.findIndex((b, k) => k !== i && b > need + MIN_VAULT_SOL);
    if (j < 0) {
      console.error(`vault-${i} ${vaults[i]!.publicKey.toBase58()} needs ~${sol(need)}; fund it at https://faucet.solana.com`);
      process.exit(2);
    }
    const t = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: vaults[j]!.publicKey, toPubkey: vaults[i]!.publicKey, lamports: need }),
    );
    const sig = await sendAndConfirmTransaction(conn, t, [vaults[j]!], { commitment: "confirmed" });
    bal[j]! -= need;
    bal[i]! += need;
    console.log(`  top-up vault-${i} with ${sol(need)} from vault-${j}  ${txUrl(sig)}`);
  }
}

async function pickMint(vaults: Keypair[]): Promise<string> {
  const explicit = arg("--mint");
  if (explicit) return explicit;
  const counts = new Map<string, number>();
  for (const v of vaults) for (const [m, a] of await holdings(v.publicKey)) if (a > 0n) counts.set(m, (counts.get(m) ?? 0) + 1);
  // Prefer a mint held by >= 2 vaults (withdraw must come from a non-buying vault).
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [m] of ranked) {
    if (await conn.getAccountInfo(bondingCurvePda(new PublicKey(m)))) return m;
  }
  throw new Error("no pump.fun mint held by the vaults; run pnpm e2e:devnet first or pass --mint");
}

async function runUntilDone(relayer: Relayer, queue: InMemoryJobQueue, id: string): Promise<Execution> {
  for (;;) {
    const j = queue.get(id)!;
    if (j.state === "executed" && j.result?.status === "executed") return j.result.execution;
    if (j.state === "failed" && j.result?.status === "failed") {
      throw new Error(`job failed: ${j.result.code} (${j.result.message})`);
    }
    if (!(await relayer.tick())) {
      const due = queue.nextDue();
      const wait = due === null ? 500 : Math.max(200, Math.min(2_000, due - Date.now()));
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

function show(label: string, e: Execution, vaultName: (k: string) => string): void {
  console.log(`  ${label}: ${txUrl(e.signature)}`);
  if (e.kind === "withdraw") {
    console.log(
      `    from ${vaultName(e.vault)} -> ${e.to}: tokens=${formatUnits(e.tokenAmount, e.decimals)} ` +
        `gasDrop=${sol(e.gasDropLamports)} networkFee=${e.networkFee}`,
    );
  } else {
    console.log(
      `    ${vaultName(e.vault)}: tokens=${formatUnits(e.tokenAmount, e.decimals)} sol=${sol(e.solAmount)} ` +
        `fee=${e.networkFee} fromEvent=${e.fromEvent} price=${e.market?.priceSol ?? "?"} SOL`,
    );
  }
}

async function main(): Promise<void> {
  console.log(describeConfig(cfg));
  const vaults = ensureVaults(cfg.keysDir, VAULTS);
  const names = new Map(vaults.map((v, i) => [v.publicKey.toBase58(), `vault-${i}`]));
  const vaultName = (k: string) => names.get(k) ?? k;

  console.log("\n[0] vaults");
  for (const v of vaults) {
    const b = BigInt(await conn.getBalance(v.publicKey, "confirmed"));
    const h = [...(await holdings(v.publicKey)).entries()].map(([m, a]) => `${m.slice(0, 6)}…=${a}`).join(" ");
    console.log(`  ${vaultName(v.publicKey.toBase58())} ${v.publicKey.toBase58()} ${sol(b)} ${h}`);
  }
  if (process.argv.includes("--status")) return;
  await topUp(vaults);
  const mint = await pickMint(vaults);
  console.log(`  mint ${mint}  ${explorerAddressUrl(mint, cfg.cluster)}`);

  const adapter = new PumpFunAdapter({
    connection: conn,
    defaultVault: vaults[0]!,
    vaults,
    creators: new CreatorKeyring(cfg.keysDir),
    stateDir: cfg.keysDir,
    priorityMicroLamports: cfg.priorityMicroLamports,
  });
  const queue = new InMemoryJobQueue(cryptoRng, DEMO_JITTER);
  const pool = new VaultPool(vaults, new RpcVaultInventory(conn), cryptoRng);
  const events: RelayerEvent[] = [];
  const relayer = new Relayer({
    queue,
    pool,
    executors: {
      trade: { pumpfun: new PumpFunTradeExecutor(adapter) },
      withdraw: new WithdrawExecutor(new TokenWithdrawer({ connection: conn, priorityMicroLamports: cfg.priorityMicroLamports }), cryptoRng),
    },
    probe: new RpcChainProbe(conn),
    onEvent: (e) => {
      events.push(e);
      console.log(`  [relayer] ${e.event} ${e.kind}${e.code ? ` ${e.code}` : ""}`);
    },
  });

  console.log(`\n[1] buy ${sol(BUY)} (queued with jitter)`);
  const qb = await adapter.quote(mint, "buy", BUY);
  const buySpec: JobSpec = { kind: "buy", venue: "pumpfun", mint, lamportsIn: BUY, minOut: minOutWithSlippage(qb.amountOut, SLIPPAGE_BPS) };
  const bought = await runUntilDone(relayer, queue, queue.enqueue(buySpec).id);
  show("buy", bought, vaultName);

  console.log("\n[2] sell half of it (any vault holding the token, rotation)");
  const toSell = bought.tokenAmount / 2n;
  const qs = await adapter.quote(mint, "sell", toSell);
  const sellSpec: JobSpec = { kind: "sell", venue: "pumpfun", mint, amount: toSell, minLamports: minOutWithSlippage(qs.amountOut, SLIPPAGE_BPS) };
  const sold = await runUntilDone(relayer, queue, queue.enqueue(sellSpec).id);
  show("sell", sold, vaultName);

  console.log("\n[3] withdraw a quarter of the buy to a fresh address (not from the buying vault)");
  const recipient = Keypair.generate().publicKey; // devnet: key discarded on purpose
  const amount = bought.tokenAmount / 4n;
  const [notBefore] = withdrawSchedule(Date.now(), 1, cryptoRng, DEMO_WITHDRAW_DELAY);
  const wSpec: JobSpec = { kind: "withdraw", mint, to: recipient.toBase58(), amount, avoidVaults: [bought.vault] };
  console.log(`  recipient ${recipient.toBase58()}, delay ${Math.round((notBefore! - Date.now()) / 1000)} s`);
  const withdrawn = await runUntilDone(relayer, queue, queue.enqueue(wSpec, { notBefore: notBefore! }).id);
  show("withdraw", withdrawn, vaultName);
  if (withdrawn.vault === bought.vault) throw new Error("withdraw used the buying vault");

  // Cross-check what the recipient really holds.
  const mintInfo = await conn.getAccountInfo(new PublicKey(mint));
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), recipient, false, mintInfo!.owner);
  const [rSol, rTok] = await Promise.all([conn.getBalance(recipient, "confirmed"), conn.getTokenAccountBalance(ata, "confirmed")]);
  console.log(`  recipient now holds ${sol(BigInt(rSol))} and ${rTok.value.uiAmountString} tokens`);

  console.log("\nsummary");
  console.log(`  buy      ${txUrl(bought.signature)}  (${vaultName(bought.vault)})`);
  console.log(`  sell     ${txUrl(sold.signature)}  (${vaultName(sold.vault)})`);
  console.log(`  withdraw ${txUrl(withdrawn.signature)}  (${vaultName(withdrawn.vault)}, gas drop + transfer in one tx)`);
  console.log(`  events   ${events.map((e) => `${e.event}:${e.kind}`).join(", ")}`);
}

main()
  .then(() => process.exit(process.exitCode ?? 0)) // web3.js websockets keep the loop alive
  .catch((e) => {
  if (e instanceof AdapterError) {
    console.error(`AdapterError ${e.code} (API ${e.apiCode}): ${redactSecrets(e.message)}`);
  } else {
    console.error(redactSecrets(e instanceof Error ? (e.stack ?? e.message) : String(e)));
  }
  process.exit(1);
});
