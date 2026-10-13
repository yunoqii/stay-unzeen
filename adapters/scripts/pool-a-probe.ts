/**
 * Pool A (SOL <-> quote leg of non-SOL pairs) probe, READ-ONLY:
 *   pnpm pool-a:probe [--mainnet] [--quote USDC|USD1|<mint>] [--pool <address>]
 * 1) lists DAMM v2 (cp-amm) pools SOL/quote by reserves (one getProgramAccounts per mint order);
 * 2) simulates swap2 ExactOut (buy q quote for SOL) and ExactIn (sell q quote for SOL) on the
 *    deepest pool with `simulateTransaction` (sigVerify off, a funded public address as payer:
 *    nothing is signed or sent).
 * URLs and keys are never printed.
 */
import BN from "bn.js";
import { CP_AMM_PROGRAM_ID, CpAmm, POOL_TOKEN_A_MINT_OFFSET, POOL_TOKEN_B_MINT_OFFSET, SwapMode, getCurrentPoint, type PoolState } from "@meteora-ag/cp-amm-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { QUOTE_MINTS } from "../src/pool-a";

loadRepoEnv();
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const mainnet = process.argv.includes("--mainnet");
  const url = (mainnet ? process.env.SOLANA_RPC_URL_MAINNET : process.env.SOLANA_RPC_URL_DEVNET)?.trim();
  if (!url) throw new Error("no RPC URL");
  const conn = new Connection(url, "confirmed");
  const q = arg("--quote") ?? "USDC";
  const net = mainnet ? "mainnet-beta" : "devnet";
  const quote = new PublicKey(QUOTE_MINTS[net][q as "USDC"]?.mint ?? q);
  const amm = new CpAmm(conn);
  const pools: { address: PublicKey; state: PoolState; sol: bigint; quote: bigint }[] = [];
  const only = arg("--pool");
  // Candidates: one getProgramAccounts per side with a 64-byte slice (mint A | mint B), filtered here
  // (two memcmp filters at once returned nothing on our provider, 13.10).
  let candidates: PublicKey[] = [];
  if (only) candidates = [new PublicKey(only)];
  else {
    for (const off of [POOL_TOKEN_A_MINT_OFFSET, POOL_TOKEN_B_MINT_OFFSET]) {
      const r = await conn.getProgramAccounts(CP_AMM_PROGRAM_ID, { filters: [{ memcmp: { offset: off, bytes: quote.toBase58() } }], dataSlice: { offset: POOL_TOKEN_A_MINT_OFFSET, length: 64 } });
      for (const x of r) {
        const a = new PublicKey(x.account.data.subarray(0, 32));
        const b = new PublicKey(x.account.data.subarray(32, 64));
        if ((a.equals(NATIVE_MINT) && b.equals(quote)) || (a.equals(quote) && b.equals(NATIVE_MINT))) candidates.push(x.pubkey);
      }
    }
  }
  console.log(`candidates: ${candidates.length}`);
  for (let i = 0; i < candidates.length; i += 100) {
    const chunk = candidates.slice(i, i + 100);
    const accs = await conn.getMultipleAccountsInfo(chunk);
    const states = accs.map((a) => {
      try {
        return a ? (amm._program.coder.accounts.decode("pool", a.data) as PoolState) : null;
      } catch {
        return null;
      }
    });
    const vaults = states.flatMap((s) => (s ? [s.tokenAVault, s.tokenBVault] : []));
    const vaultAccs: (Awaited<ReturnType<typeof conn.getMultipleAccountsInfo>>[number])[] = [];
    for (let j = 0; j < vaults.length; j += 100) vaultAccs.push(...(await conn.getMultipleAccountsInfo(vaults.slice(j, j + 100))));
    let k = 0;
    states.forEach((state, n) => {
      if (!state) return;
      const amt = (acc: (typeof vaultAccs)[number]) => (acc && acc.data.length >= 72 ? acc.data.readBigUInt64LE(64) : 0n);
      const a = amt(vaultAccs[k++] ?? null);
      const b = amt(vaultAccs[k++] ?? null);
      const aIsSol = state.tokenAMint.equals(NATIVE_MINT);
      pools.push({ address: chunk[n]!, state, sol: aIsSol ? a : b, quote: aIsSol ? b : a });
    });
  }
  pools.sort((x, y) => (y.sol > x.sol ? 1 : -1));
  console.log(`${net} DAMM v2 SOL/${q}: ${pools.length} pool(s)`);
  for (const p of pools.slice(0, 5)) {
    console.log(`  ${p.address.toBase58()}  SOL=${Number(p.sol) / 1e9}  quote=${Number(p.quote) / 1e6}  status=${p.state.poolStatus} collectFeeMode=${p.state.collectFeeMode}`);
  }
  const best = pools[0];
  if (!best) return;
  // A funded public address only as the simulated fee payer (sigVerify off): nothing is signed.
  const payer = new PublicKey(arg("--payer") ?? "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  const point = await getCurrentPoint(conn, best.state.activationType);
  const common = {
    payer,
    pool: best.address,
    tokenAMint: best.state.tokenAMint,
    tokenBMint: best.state.tokenBMint,
    tokenAVault: best.state.tokenAVault,
    tokenBVault: best.state.tokenBVault,
    tokenAProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    tokenBProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    referralTokenAccount: null,
    poolState: best.state,
  };
  const qOut = new BN(arg("--amount") ?? "50000000"); // 50 USDC
  const quoteOut = amm.getQuote2({ inputTokenMint: NATIVE_MINT, slippage: 0, currentPoint: point, poolState: best.state, tokenADecimal: best.state.tokenAMint.equals(NATIVE_MINT) ? 9 : 6, tokenBDecimal: best.state.tokenAMint.equals(NATIVE_MINT) ? 6 : 9, hasReferral: false, swapMode: SwapMode.ExactOut, amountOut: qOut });
  const maxIn = quoteOut.includedFeeInputAmount.muln(101).divn(100);
  const sims: [string, Awaited<ReturnType<CpAmm["swap2"]>>][] = [
    ["ExactOut SOL->quote", await amm.swap2({ ...common, inputTokenMint: NATIVE_MINT, outputTokenMint: quote, swapMode: SwapMode.ExactOut, amountOut: qOut, maximumAmountIn: maxIn })],
  ];
  console.log(`local quote: ${qOut.toString()} quote units for ~${quoteOut.includedFeeInputAmount.toString()} lamports (max ${maxIn.toString()})`);
  for (const [name, txb] of sims) {
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...txb.instructions] }).compileToV0Message();
    const sim = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
    console.log(`simulate ${name}: err=${JSON.stringify(sim.value.err)} cu=${sim.value.unitsConsumed}`);
    if (sim.value.err) console.log((sim.value.logs ?? []).slice(-6).join("\n"));
  }
}

main().catch((e) => {
  console.error(`[pool-a-probe] fatal: ${redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
  process.exit(1);
});
