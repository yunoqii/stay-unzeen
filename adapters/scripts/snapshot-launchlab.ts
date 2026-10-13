/**
 * Test fixtures for test/launchlab.test.ts and test/pool-a-clmm.test.ts (public chain data only):
 *   pnpm tsx scripts/snapshot-launchlab.ts
 * - test/fixtures/launchlab-mainnet-accounts.json.gz: READ-ONLY mainnet accounts — LaunchLab
 *   GlobalConfigs (SOL, USD1, ZEC), stonk/bonk platforms and their curve rules, the USD1 pool A
 *   (Raydium CLMM) with its config, bitmap extension, vaults, observation and tick arrays.
 * - test/fixtures/launchlab-txs.json: a mainnet swap through pool A (SwapEvent) and the
 *   devnet LaunchLab e2e transactions of 13.10 (pnpm launchlab:devnet).
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { getPdaLaunchpadAuth, getPdaPlatformCurveRule, getPdaPlatformVault } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { LAUNCHLAB_CONFIGS, LAUNCHLAB_PLATFORMS, LAUNCHLAB_PROGRAM } from "../src/launchlab";
import { ClmmPoolA } from "../src/pool-a-clmm";

loadRepoEnv();
const USD1 = new PublicKey("USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB");
const POOL_A = new PublicKey("AQAGYQsdU853WAKhXM79CgNdoyhrRwXvYHX6qrDyC1FS");
const ZEC = new PublicKey("A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS");
const DEVNET_TXS = {
  solCreate: "3AT4cuzpr7RyqSrJn9APBbfkbkAqVtL8zLv1FYGkZjcJzMRcZ5K2m5ZAWEWTtYKUW7wqGx8ABzyFFwYntW485rR6",
  quoteCreateStock: "2twbqv9U88VwtYigC2ATUyfSJZvcMUeLoTNCWvcfSAUhbcVawE6Q2CckyiJNK8seBm7Vsspi6i4t5UWDvdVLsrmq",
  quoteBuyLeg: "27giiSWeEBvgzhV6YmwPaJE6pcVdTkLJ3hezEp2mhTHHMKxiZ29WHn955MQAweyfQ5SmoTnwoexEX9WcULJXruZH",
  quoteSell: "3oRvvSx5AqRccsjovo3ZZGdA3f24iuke7rUDUs9g4CVgrWX1zVUST9hoLbWXuPeYYyJZYzJhqkg9Er2cwrWB8FE7",
};

async function rawTx(conn: Connection, sig: string): Promise<unknown> {
  const r = await fetch(conn.rpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] }),
  });
  const j = (await r.json()) as { result: unknown };
  if (!j.result) throw new Error(`tx ${sig.slice(0, 8)} not found`);
  return j.result;
}

async function main(): Promise<void> {
  const main = new Connection(process.env.SOLANA_RPC_URL_MAINNET!, "confirmed");
  const dev = new Connection(process.env.SOLANA_RPC_URL_DEVNET || "https://api.devnet.solana.com", "confirmed");
  const program = LAUNCHLAB_PROGRAM["mainnet-beta"];
  const keys = new Map<string, PublicKey>();
  const add = (k: PublicKey) => keys.set(k.toBase58(), k);
  add(getPdaLaunchpadAuth(program).publicKey);
  for (const q of [NATIVE_MINT, USD1, ZEC]) {
    const configId = new PublicKey(LAUNCHLAB_CONFIGS["mainnet-beta"][q.toBase58()]!);
    add(configId);
    add(q);
    for (const id of Object.values(LAUNCHLAB_PLATFORMS["mainnet-beta"])) {
      const p = new PublicKey(id);
      [p, getPdaPlatformCurveRule(program, p, configId).publicKey, getPdaPlatformVault(program, p, q).publicKey].forEach(add);
    }
  }
  add(POOL_A);
  const pa = new ClmmPoolA(main, POOL_A, { mint: USD1, decimals: 6, tokenProgram: TOKEN_PROGRAM_ID });
  const s = await pa.load();
  const dummy = Keypair.generate().publicKey;
  for (const ix of [...(await pa.buyQuoteExactOut(dummy, s, 50_000_000n, 10n ** 9n)), ...(await pa.sellQuoteExactIn(dummy, s, 50_000_000n, 1n))]) for (const k of ix.keys) add(k.pubkey);
  for (const t of Object.values(s.ticks as unknown as Record<string, { address: PublicKey }>)) add(t.address);
  const list = [...keys.values()];
  const accounts: Record<string, { owner: string; lamports: number; data: string }> = {};
  for (let i = 0; i < list.length; i += 100) {
    const infos = await main.getMultipleAccountsInfo(list.slice(i, i + 100));
    infos.forEach((a, j) => {
      if (!a || a.executable || a.data.length === 0) return;
      accounts[list[i + j]!.toBase58()] = { owner: a.owner.toBase58(), lamports: a.lamports, data: a.data.toString("base64") };
    });
  }
  // One recent mainnet swap through pool A (any direction) for the SwapEvent decoder.
  const sigs = await main.getSignaturesForAddress(POOL_A, { limit: 25 });
  let poolASwap: { signature: string; result: unknown } | null = null;
  for (const x of sigs) {
    if (x.err) continue;
    const result = await rawTx(main, x.signature);
    const t = await main.getTransaction(x.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (t && pa.legs(t).length === 1) {
      poolASwap = { signature: x.signature, result };
      break;
    }
  }
  if (!poolASwap) throw new Error("no single-leg pool A swap in the last 25 signatures");
  const devnet: Record<string, { signature: string; result: unknown }> = {};
  for (const [k, sig] of Object.entries(DEVNET_TXS)) devnet[k] = { signature: sig, result: await rawTx(dev, sig) };
  const dir = path.join(__dirname, "..", "test", "fixtures");
  fs.writeFileSync(path.join(dir, "launchlab-mainnet-accounts.json.gz"), zlib.gzipSync(JSON.stringify({ slot: await main.getSlot(), accounts })));
  fs.writeFileSync(path.join(dir, "launchlab-txs.json"), JSON.stringify({ poolASwap, devnet }));
  console.log(`${Object.keys(accounts).length} accounts, pool A swap ${poolASwap.signature.slice(0, 8)}…, ${Object.keys(devnet).length} devnet txs`);
}

main().catch((e) => {
  console.error(redactSecrets(e instanceof Error ? (e.stack ?? e.message) : String(e)).slice(0, 1500));
  process.exit(1);
});
