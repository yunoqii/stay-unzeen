/**
 * LaunchLab USD1 create + pool-A leg (Raydium CLMM) in ONE v0 tx, run by the real
 * LaunchLabAdapter against a LOCAL validator loaded with mainnet state. Nothing is sent
 * to mainnet: a local ALT cannot be simulated over a mainnet RPC (tables are resolved
 * on chain), so the full tx is checked here.
 *
 *   pnpm launchlab:leg-local dump <dir>   # READ-ONLY mainnet: accounts + program .so files into <dir>,
 *                                         # prints the solana-test-validator command (no RPC URL in it)
 *   pnpm launchlab:leg-local run          # against http://127.0.0.1:8899
 *
 * run: vault without USD1 stock -> create (stonk.fun: Token-2022; bonk.fun: SPL) with the leg,
 * then buy (leg) and sell, with worst realistic metadata (name 32 B, symbol 10 B, uri 80 B
 * = ipfs.io gateway + CIDv1) plus the pool Sender tip, so the size is the production one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getPdaLaunchpadAuth, getPdaPlatformCurveRule, getPdaPlatformVault } from "@raydium-io/raydium-sdk-v2";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, type Commitment } from "@solana/web3.js";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { CreatorKeyring, MemoryCreatorIndexCounter } from "../src/keys";
import { LAUNCHLAB_CONFIGS, LAUNCHLAB_PLATFORMS, LAUNCHLAB_PROGRAM, LaunchLabAdapter } from "../src/launchlab";
import { formatUnits } from "../src/math";
import { quoteAssets } from "../src/pool-a";
import { ClmmPoolA } from "../src/pool-a-clmm";
import { SENDER_TIP_ACCOUNTS, senderTip } from "../src/sender";
import type { Broadcaster } from "../src/tx";

loadRepoEnv();
const USD1 = new PublicKey("USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB");
const POOL_A = new PublicKey("AQAGYQsdU853WAKhXM79CgNdoyhrRwXvYHX6qrDyC1FS");
const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const PROGRAMS = [LAUNCHLAB_PROGRAM["mainnet-beta"], new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"), METAPLEX];

async function dump(dir: string): Promise<void> {
  const conn = new Connection(process.env.SOLANA_RPC_URL_MAINNET!, "confirmed");
  fs.mkdirSync(dir, { recursive: true });
  const program = LAUNCHLAB_PROGRAM["mainnet-beta"];
  const configId = new PublicKey(LAUNCHLAB_CONFIGS["mainnet-beta"][USD1.toBase58()]!);
  const keys = new Map<string, PublicKey>();
  const add = (k: PublicKey) => keys.set(k.toBase58(), k);
  [configId, USD1, POOL_A, getPdaLaunchpadAuth(program).publicKey, ...SENDER_TIP_ACCOUNTS.map((a) => new PublicKey(a))].forEach(add);
  for (const id of Object.values(LAUNCHLAB_PLATFORMS["mainnet-beta"])) {
    const p = new PublicKey(id);
    [p, getPdaPlatformCurveRule(program, p, configId).publicKey, getPdaPlatformVault(program, p, USD1).publicKey].forEach(add);
  }
  // Pool A: every account its ExactOut / ExactIn swaps touch (config, bitmap ext, vaults, observation, tick arrays).
  const pa = new ClmmPoolA(conn, POOL_A, { mint: USD1, decimals: 6, tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
  const s = await pa.load();
  const dummy = Keypair.generate().publicKey;
  for (const ix of [...(await pa.buyQuoteExactOut(dummy, s, 50_000_000n, 10n ** 9n)), ...(await pa.sellQuoteExactIn(dummy, s, 50_000_000n, 1n))]) {
    for (const k of ix.keys) add(k.pubkey);
  }
  // Every tick array of the pool's cache too (prices move between dump and run).
  for (const t of Object.values(s.ticks as unknown as Record<string, { address: PublicKey }>)) add(t.address);
  const list = [...keys.values()].filter((k) => !PROGRAMS.some((p) => p.equals(k)));
  const args: string[] = [];
  for (let i = 0; i < list.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(list.slice(i, i + 100));
    infos.forEach((a, j) => {
      const k = list[i + j]!;
      if (!a || a.executable || a.owner.equals(new PublicKey("Sysvar1111111111111111111111111111111111111"))) return;
      if (a.owner.equals(new PublicKey("11111111111111111111111111111111")) && a.data.length === 0 && !SENDER_TIP_ACCOUNTS.includes(k.toBase58())) return; // wallets
      const f = path.join(dir, `${k.toBase58()}.json`);
      fs.writeFileSync(f, JSON.stringify({ pubkey: k.toBase58(), account: { lamports: a.lamports, data: [a.data.toString("base64"), "base64"], owner: a.owner.toBase58(), executable: false, rentEpoch: 0, space: a.data.length } }));
      args.push(`--account ${k.toBase58()} ${f}`);
    });
  }
  for (const p of PROGRAMS) {
    const acc = await conn.getAccountInfo(p);
    if (!acc) throw new Error(`program ${p.toBase58()} not found`);
    const pd = new PublicKey(acc.data.subarray(4, 36));
    const data = await conn.getAccountInfo(pd);
    if (!data) throw new Error("programdata not found");
    const f = path.join(dir, `${p.toBase58()}.so`);
    fs.writeFileSync(f, data.data.subarray(45));
    args.push(`--bpf-program ${p.toBase58()} ${f}`);
  }
  console.log(`${args.length} items in ${dir}; pool A tick ${(s.compute as unknown as { tickCurrent: number }).tickCurrent}`);
  console.log(`solana-test-validator --reset --quiet --ledger ${path.join(dir, "ledger")} ${args.join(" ")}`);
}

async function run(): Promise<void> {
  const url = "http://127.0.0.1:8899";
  const commitment: Commitment = "confirmed";
  const conn = new Connection(url, commitment);
  const vault = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(vault.publicKey, 20 * LAMPORTS_PER_SOL), commitment);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ll-local-"));
  const broadcaster: Broadcaster = {
    name: "local",
    send: async (raw, o) => void (await conn.sendRawTransaction(raw, { skipPreflight: !o.preflight })),
    trySend: async (raw) => void (await conn.sendRawTransaction(raw, { skipPreflight: true }).catch(() => undefined)),
  };
  const a = new LaunchLabAdapter({
    connection: conn,
    cluster: "mainnet-beta",
    defaultVault: vault,
    creators: new CreatorKeyring(randomBytes(64), new MemoryCreatorIndexCounter()),
    stateDir,
    quotes: quoteAssets("mainnet-beta", {}, "meteora-dbc").filter((q) => q.symbol === "USD1"),
    priorityMicroLamports: 1_000,
    pipeline: { tip: senderTip(), broadcaster },
  });
  const meta = { name: "N".repeat(32), symbol: "S".repeat(10), uri: `https://ipfs.io/ipfs/${"b".repeat(59)}` };
  let failed = false;
  for (const platform of ["stonk", "bonk"]) {
    try {
      const p = await a.prepareCreate(meta, 50_000_000n, 0n, { quote: "USD1", platform });
      const sent = await a.submit(p);
      const tx = await conn.getTransaction(sent.signature, { maxSupportedTransactionVersion: 0, commitment });
      const c = await a.createResult(sent.signature, p.vault);
      console.log(`${platform} create: ${p.raw.length} B, source=${p.quoteSource}, cu=${tx?.meta?.computeUnitsConsumed}, tokens=${formatUnits(c?.tokenAmount ?? 0n, 6)}, quote=${formatUnits(c?.quoteAmount ?? 0n, 6)} USD1, ledger=${formatUnits(c?.solAmount ?? 0n, 9)} SOL (${c?.quoteSource})`);
      const mint = p.mint;
      const pb = await a.prepareBuy(mint, 30_000_000n, 0n);
      const sb = await a.submit(pb);
      const b = await a.tradeResult("buy", sb.signature, pb.vault, mint);
      const tb = await conn.getTransaction(sb.signature, { maxSupportedTransactionVersion: 0, commitment });
      console.log(`${platform} buy:    ${pb.raw.length} B, source=${pb.quoteSource}, cu=${tb?.meta?.computeUnitsConsumed}, tokens=${formatUnits(b?.tokenAmount ?? 0n, 6)}, ledger=${formatUnits(b?.solAmount ?? 0n, 9)} SOL`);
      const ps = await a.prepareSell(mint, (b?.tokenAmount ?? 0n) / 2n, 0n);
      const ss = await a.submit(ps);
      const sd = await a.tradeResult("sell", ss.signature, ps.vault, mint);
      console.log(`${platform} sell:   ${ps.raw.length} B, tokens=${formatUnits(sd?.tokenAmount ?? 0n, 6)}, quote=${formatUnits(sd?.quoteAmount ?? 0n, 6)} USD1, ledger=${formatUnits(sd?.solAmount ?? 0n, 9)} SOL`);
    } catch (e) {
      failed = true;
      const f = e as { message?: string; code?: string; stage?: string; cause?: { logs?: string[]; transactionLogs?: string[]; message?: string } };
      console.log(`${platform}: FAILED ${f.code ?? ""} stage=${f.stage ?? "-"} ${redactSecrets(f.message ?? String(e)).slice(0, 300)} | ${redactSecrets(f.cause?.message ?? "").slice(0, 300)}`);
      const logs = [f.cause?.logs, f.cause?.transactionLogs].find((x): x is string[] => Array.isArray(x)) ?? [];
      for (const l of logs.slice(-12)) console.log(`    ${l}`);
    }
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (failed) process.exitCode = 1;
}

const [mode, dir] = process.argv.slice(2);
(mode === "dump" && dir ? dump(dir) : mode === "run" ? run() : Promise.reject(new Error("usage: dump <dir> | run")))
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(redactSecrets(e instanceof Error ? (e.stack ?? e.message) : String(e)).slice(0, 1500));
    process.exit(1);
  });
