/**
 * Creates Unzeen's Meteora DBC config key (once per network):
 *
 *   pnpm meteora:config            # dry run: prints parameters, validates them, partner funding
 *   pnpm meteora:config --simulate # + simulates the create tx on the RPC (read-only)
 *   pnpm meteora:config --send     # devnet: creates the config account
 *   pnpm meteora:config --quote USDC [--send]   # non-SOL pair: one config per quote mint
 *     (same curve shape, fees and creator share in quote units: start 3 000, graduation 44 088)
 *
 * MAINNET (src/mainnet-setup.ts gate):
 *   SOLANA_CLUSTER=mainnet-beta UNZEEN_ALLOW_MAINNET=yes pnpm meteora:config [--simulate]
 *   SOLANA_CLUSTER=mainnet-beta UNZEEN_ALLOW_MAINNET=yes UNZEEN_ALLOW_MAINNET_SETUP=yes \
 *     pnpm meteora:config --send [--confirm-mainnet <partner pubkey>]
 *   The partner is NEVER funded from a vault on mainnet: the script prints its
 *   address and the missing SOL (rent of the config + fee margin) and stops; the
 *   operator funds it from an external wallet (same rule as the attestation keys).
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
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { describeConfig, explorerAddressUrl, explorerTxUrl, loadConfig, makeConnection } from "../src/config";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { formatUnits } from "../src/math";
import { UNZEEN_DBC_CURVE, UNZEEN_DBC_CURVE_USD, dbcConfigAddress, derivePartnerKeypair, unzeenDbcConfigParameters } from "../src/meteora";
import { quoteAssets } from "../src/pool-a";
import { priorityFeeCacheFromConfig } from "../src/fees";
import { FEE_ESTIMATE_PROGRAMS, openKeys } from "../src/relayer/runtime";
import { txPipeline } from "../src/sender";
import { broadcastAndConfirm, signTx } from "../src/tx";
import { confirmMainnet, fundingHint, setupFunding, setupGate, ttyAsk } from "../src/mainnet-setup";
import { DBC_CONFIG_ACCOUNT_SIZE, dbcConfigEnvName } from "../src/meteora";

const PARTNER_MIN = BigInt(LAMPORTS_PER_SOL) / 50n; // 0.02 SOL (devnet auto-funding target)

loadRepoEnv();
const cfg = loadConfig();
if (cfg.cluster !== "devnet" && cfg.cluster !== "mainnet-beta") {
  console.error(`refusing to run on ${cfg.cluster}: devnet or mainnet-beta only`);
  process.exit(1);
}
const gate = (() => {
  try {
    return setupGate({ cluster: cfg.cluster, argv: process.argv, env: process.env });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
})();
const conn = makeConnection(cfg);
const sol = (l: bigint) => `${formatUnits(l, 9)} SOL`;

async function main(): Promise<void> {
  console.log(describeConfig(cfg));
  const qi = process.argv.indexOf("--quote");
  const sym = qi >= 0 ? process.argv[qi + 1]?.toUpperCase() : undefined;
  const asset = sym ? quoteAssets(cfg.cluster).find((a) => a.symbol === sym) : undefined;
  if (sym && !asset) throw new Error(`unknown quote ${sym} on ${cfg.cluster}`);
  const quoteMint = asset ? asset.mint : NATIVE_MINT;
  const params = unzeenDbcConfigParameters(asset ?? null);
  if (asset) {
    console.log(`quote ${asset.symbol} ${asset.mint.toBase58()} (${asset.decimals} decimals): start mcap ${UNZEEN_DBC_CURVE_USD.initialMarketCap}, graduation mcap ${UNZEEN_DBC_CURVE_USD.migrationMarketCap}, threshold ${formatUnits(BigInt(params.migrationQuoteThreshold.toString()), asset.decimals)} ${asset.symbol}`);
  } else console.log(
    `curve: supply ${UNZEEN_DBC_CURVE.totalTokenSupply}, start mcap ${UNZEEN_DBC_CURVE.initialMarketCapSol} SOL, ` +
      `graduation at ${sol(BigInt(params.migrationQuoteThreshold.toString()))} raised (mcap ${UNZEEN_DBC_CURVE.migrationMarketCapSol} SOL), ` +
      `fee ${UNZEEN_DBC_CURVE.feeBps} bps (creator ${UNZEEN_DBC_CURVE.creatorTradingFeePercentage} % of the non-protocol part)`,
  );
  const existing = asset ? asset.dbcConfig : dbcConfigAddress(cfg.cluster);
  if (existing) console.log(`note: a config is already configured for ${cfg.cluster}: ${existing.toBase58()}`);

  const keys = await openKeys(cfg, process.env, (m) => console.log(`  WARN ${m}`));
  const partner = derivePartnerKeypair(keys.creatorSeed);
  console.log(`partner (fee claimer): ${partner.publicKey.toBase58()}`);
  // Throws with the reason when the SDK rejects the parameters.
  validateConfigParameters({ ...params, leftoverReceiver: partner.publicKey, quoteMint } as Parameters<typeof validateConfigParameters>[0]);
  console.log("parameters: valid");

  // Partner funding: rent of the config account + fee margin.
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(DBC_CONFIG_ACCOUNT_SIZE));
  const partnerBal = BigInt(await conn.getBalance(partner.publicKey, "confirmed"));
  const funding = setupFunding([rent], partnerBal);
  console.log(`partner needs ${sol(funding.need)} (config rent ${sol(rent)} + fee margin), holds ${sol(partnerBal)}`);
  if (gate.mainnet && funding.missing > 0n) console.log(fundingHint(partner.publicKey.toBase58(), funding.missing, funding.need));

  if (gate.mode === "dry") {
    console.log(`dry run (--simulate to simulate the tx, --send to create the config${gate.mainnet ? "; mainnet: see the header for the gate" : ""})`);
    return;
  }

  const pipeline = txPipeline(cfg, conn);
  // Same quantized pool-wide CU price as every relayer tx.
  const fees = priorityFeeCacheFromConfig(cfg, conn, FEE_ESTIMATE_PROGRAMS);
  await fees.refresh().catch(() => undefined);
  const prefix = { computeUnits: 200_000, priorityMicroLamports: fees.microLamports(), tip: pipeline.tip };

  const configKp = Keypair.generate();
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const build = () =>
    client.partner.createConfig({
      ...params,
      config: configKp.publicKey,
      feeClaimer: partner.publicKey,
      leftoverReceiver: partner.publicKey,
      quoteMint,
      payer: partner.publicKey,
    });

  if (gate.mode === "simulate") {
    const tx = await build();
    const signed = await signTx(conn, tx.instructions, partner, [configKp], prefix);
    const sim = await conn.simulateTransaction(VersionedTransaction.deserialize(signed.raw), { sigVerify: false, replaceRecentBlockhash: true });
    console.log(`simulation: ${sim.value.err ? `FAILED ${JSON.stringify(sim.value.err)}` : "ok"} (${sim.value.unitsConsumed ?? "?"} CU), nothing sent`);
    for (const l of (sim.value.logs ?? []).slice(-8)) console.log(`  ${l}`);
    return;
  }

  if (gate.mainnet) {
    if (funding.missing > 0n) throw new Error("partner not funded: fund it from the operator's external wallet first (see above)");
    await confirmMainnet(partner.publicKey.toBase58(), gate.confirm, ttyAsk());
  }

  let bal = partnerBal;
  if (!gate.mainnet && bal < PARTNER_MIN) {
    const balances = await Promise.all(keys.vaults.map(async (v) => BigInt(await conn.getBalance(v.publicKey, "confirmed"))));
    const i = balances.reduce((best, b, k) => (b > balances[best]! ? k : best), 0);
    const need = PARTNER_MIN - bal;
    if (balances[i]! < need + PARTNER_MIN) throw new Error(`no vault can fund the partner (${sol(need)}); fund ${partner.publicKey.toBase58()} at https://faucet.solana.com`);
    const t = await signTx(conn, [SystemProgram.transfer({ fromPubkey: keys.vaults[i]!.publicKey, toPubkey: partner.publicKey, lamports: need })], keys.vaults[i]!, [], prefix);
    await broadcastAndConfirm(conn, t, pipeline.broadcaster);
    console.log(`funded partner with ${sol(need)} from vault-${i}: ${explorerTxUrl(t.signature, cfg.cluster)}`);
    bal += need;
  }

  const tx = await build();
  const signed = await signTx(conn, tx.instructions, partner, [configKp], prefix);
  await broadcastAndConfirm(conn, signed, pipeline.broadcaster);
  console.log(`config created: ${configKp.publicKey.toBase58()}`);
  console.log(`  tx      ${explorerTxUrl(signed.signature, cfg.cluster)}`);
  console.log(`  account ${explorerAddressUrl(configKp.publicKey.toBase58(), cfg.cluster)}`);
  console.log(`set ${dbcConfigEnvName(cfg.cluster)}${asset ? `_${asset.symbol}` : ""}=${configKp.publicKey.toBase58()}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(redactSecrets(e instanceof Error ? (e.stack ?? e.message) : String(e)));
    process.exit(1);
  });
