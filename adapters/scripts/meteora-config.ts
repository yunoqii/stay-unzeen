/**
 * Creates Unzeen's Meteora DBC config key on DEVNET (once per network):
 *
 *   pnpm meteora:config            # dry run: prints parameters, validates them
 *   pnpm meteora:config --send     # creates the config account
 *
 * - curve / fees: `unzeenDbcConfigParameters()` (pump.fun-equivalent curve,
 *   1 % fee in SOL, partner share to the pool, 100 % LP locked after DAMM v2);
 * - partner (fee_claimer + leftover_receiver + payer): the pool's partner key
 *   derived from the creator master seed (`derivePartnerKeypair`), never a
 *   vault. It needs ~0.01 SOL: on devnet it is funded from the richest vault
 *   (that on-chain link is acceptable on devnet only; on mainnet fund it from
 *   a source unrelated to the vaults);
 * - the transaction gets the pool-wide prefix (same CU price / tip policy).
 *
 * Then set METEORA_DBC_CONFIG_DEVNET=<config> (or keep the default in
 * src/meteora.ts). Prints public addresses and signatures only.
 */
import { NATIVE_MINT } from "@solana/spl-token";
import { DynamicBondingCurveClient, validateConfigParameters } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { describeConfig, explorerAddressUrl, explorerTxUrl, loadConfig, makeConnection } from "../src/config";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { formatUnits } from "../src/math";
import { UNZEEN_DBC_CURVE, dbcConfigAddress, derivePartnerKeypair, unzeenDbcConfigParameters } from "../src/meteora";
import { priorityFeeCacheFromConfig } from "../src/fees";
import { FEE_ESTIMATE_PROGRAMS, openKeys } from "../src/relayer/runtime";
import { txPipeline } from "../src/sender";
import { broadcastAndConfirm, signTx } from "../src/tx";

const PARTNER_MIN = BigInt(LAMPORTS_PER_SOL) / 50n; // 0.02 SOL

loadRepoEnv();
const cfg = loadConfig();
if (cfg.cluster !== "devnet") {
  console.error(`refusing to run on ${cfg.cluster}: devnet only`);
  process.exit(1);
}
const conn = makeConnection(cfg);
const sol = (l: bigint) => `${formatUnits(l, 9)} SOL`;

async function main(): Promise<void> {
  console.log(describeConfig(cfg));
  const params = unzeenDbcConfigParameters();
  console.log(
    `curve: supply ${UNZEEN_DBC_CURVE.totalTokenSupply}, start mcap ${UNZEEN_DBC_CURVE.initialMarketCapSol} SOL, ` +
      `graduation at ${sol(BigInt(params.migrationQuoteThreshold.toString()))} raised (mcap ${UNZEEN_DBC_CURVE.migrationMarketCapSol} SOL), ` +
      `fee ${UNZEEN_DBC_CURVE.feeBps} bps (creator ${UNZEEN_DBC_CURVE.creatorTradingFeePercentage} % of the non-protocol part)`,
  );
  const existing = dbcConfigAddress(cfg.cluster);
  if (existing) console.log(`note: a config is already configured for ${cfg.cluster}: ${existing.toBase58()}`);

  const keys = await openKeys(cfg, process.env, (m) => console.log(`  WARN ${m}`));
  const partner = derivePartnerKeypair(keys.creatorSeed);
  console.log(`partner (fee claimer): ${partner.publicKey.toBase58()}`);
  // Throws with the reason when the SDK rejects the parameters.
  validateConfigParameters({ ...params, leftoverReceiver: partner.publicKey, quoteMint: NATIVE_MINT } as Parameters<typeof validateConfigParameters>[0]);
  console.log("parameters: valid");
  if (!process.argv.includes("--send")) {
    console.log("dry run (add --send to create the config)");
    return;
  }

  const pipeline = txPipeline(cfg, conn);
  // Same quantized pool-wide CU price as every relayer tx.
  const fees = priorityFeeCacheFromConfig(cfg, conn, FEE_ESTIMATE_PROGRAMS);
  await fees.refresh().catch(() => undefined);
  const prefix = { computeUnits: 200_000, priorityMicroLamports: fees.microLamports(), tip: pipeline.tip };

  let bal = BigInt(await conn.getBalance(partner.publicKey, "confirmed"));
  if (bal < PARTNER_MIN) {
    const balances = await Promise.all(keys.vaults.map(async (v) => BigInt(await conn.getBalance(v.publicKey, "confirmed"))));
    const i = balances.reduce((best, b, k) => (b > balances[best]! ? k : best), 0);
    const need = PARTNER_MIN - bal;
    if (balances[i]! < need + PARTNER_MIN) throw new Error(`no vault can fund the partner (${sol(need)}); fund ${partner.publicKey.toBase58()} at https://faucet.solana.com`);
    const t = await signTx(conn, [SystemProgram.transfer({ fromPubkey: keys.vaults[i]!.publicKey, toPubkey: partner.publicKey, lamports: need })], keys.vaults[i]!, [], prefix);
    await broadcastAndConfirm(conn, t, pipeline.broadcaster);
    console.log(`funded partner with ${sol(need)} from vault-${i}: ${explorerTxUrl(t.signature, cfg.cluster)}`);
    bal += need;
  }

  const configKp = Keypair.generate();
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const tx = await client.partner.createConfig({
    ...params,
    config: configKp.publicKey,
    feeClaimer: partner.publicKey,
    leftoverReceiver: partner.publicKey,
    quoteMint: NATIVE_MINT,
    payer: partner.publicKey,
  });
  const signed = await signTx(conn, tx.instructions, partner, [configKp], prefix);
  await broadcastAndConfirm(conn, signed, pipeline.broadcaster);
  console.log(`config created: ${configKp.publicKey.toBase58()}`);
  console.log(`  tx      ${explorerTxUrl(signed.signature, cfg.cluster)}`);
  console.log(`  account ${explorerAddressUrl(configKp.publicKey.toBase58(), cfg.cluster)}`);
  console.log(`set METEORA_DBC_CONFIG_DEVNET=${configKp.publicKey.toBase58()}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(redactSecrets(e instanceof Error ? (e.stack ?? e.message) : String(e)));
    process.exit(1);
  });
