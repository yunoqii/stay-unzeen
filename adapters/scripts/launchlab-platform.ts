/**
 * Unzeen's own Raydium LaunchLab platform config ("Unzeen"), one per network
 * (PDA of the platform admin = the pool's partner key, never a vault):
 *
 *   pnpm launchlab:platform              # dry run: prints parameters, addresses, partner funding
 *   pnpm launchlab:platform --simulate   # + simulates the create tx on the RPC (read-only)
 *   pnpm launchlab:platform --send       # devnet: creates it (partner funded from a vault, devnet only)
 *
 * MAINNET (src/mainnet-setup.ts gate, same as meteora:config):
 *   SOLANA_CLUSTER=mainnet-beta UNZEEN_ALLOW_MAINNET=yes pnpm launchlab:platform [--simulate]
 *   SOLANA_CLUSTER=mainnet-beta UNZEEN_ALLOW_MAINNET=yes UNZEEN_ALLOW_MAINNET_SETUP=yes \
 *     pnpm launchlab:platform --send [--confirm-mainnet <partner pubkey>]
 *   Cost: rent of the PlatformConfig account (~0.0055 SOL, mainnet simulation 16.10) + fee margin,
 *   paid by the partner key (platform admin). Creating a platform is permissionless
 *   (stonk.fun / bonk.fun are such configs). The partner is funded from the
 *   operator's EXTERNAL wallet, never from a vault: the script prints the address
 *   and the missing SOL and stops.
 *
 * Fees (rates in 1e-6): protocol 0.25 % (GlobalConfig) + platform 0.45 % + creator 0.30 % = 1 %,
 * the same total as the DBC curve; creator 0.30 % = the rate core assumes for pump.fun.
 * LP after graduation: 100 % platform (locked NFT, fees only): the program requires creatorScale = 0.
 * Prints public addresses and signatures only.
 */
import BN from "bn.js";
import { CREATE_CPMM_POOL_PROGRAM, DEVNET_PROGRAM_ID, DEV_LAUNCHPAD_PROGRAM, LAUNCHPAD_PROGRAM, PlatformConfig, createPlatformConfig, getPdaPlatformId } from "@raydium-io/raydium-sdk-v2";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { describeConfig, explorerAddressUrl, explorerTxUrl, loadConfig, makeConnection } from "../src/config";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { UNZEEN_PLATFORM } from "../src/launchlab";
import { derivePartnerKeypair } from "../src/meteora";
import { FEE_ESTIMATE_PROGRAMS, openKeys } from "../src/relayer/runtime";
import { priorityFeeCacheFromConfig } from "../src/fees";
import { txPipeline } from "../src/sender";
import { broadcastAndConfirm, RpcBroadcaster, signTx } from "../src/tx";
import { confirmMainnet, fundingHint, setupFunding, setupGate, ttyAsk } from "../src/mainnet-setup";

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
const sol = (l: bigint) => `${(Number(l) / 1e9).toFixed(6)} SOL`;

async function main(): Promise<void> {
  console.log(describeConfig(cfg));
  const devnet = cfg.cluster === "devnet";
  const program = devnet ? DEV_LAUNCHPAD_PROGRAM : LAUNCHPAD_PROGRAM;
  const cpmm = devnet ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM : CREATE_CPMM_POOL_PROGRAM;
  const keys = await openKeys(cfg, process.env, (m) => console.log(`  WARN ${m}`));
  const admin = derivePartnerKeypair(keys.creatorSeed);
  const platformId = getPdaPlatformId(program, admin.publicKey).publicKey;
  // CPMM fee config index 0: [b"amm_config", u16 BE]
  const idx = Buffer.alloc(2);
  const cpConfigId = PublicKey.findProgramAddressSync([Buffer.from("amm_config"), idx], cpmm)[0];
  console.log(`program ${program.toBase58()}  admin (partner) ${admin.publicKey.toBase58()}`);
  console.log(`platform ${platformId.toBase58()}  cpConfig ${cpConfigId.toBase58()} (exists: ${!!(await conn.getAccountInfo(cpConfigId))})`);
  console.log(`fees: platform ${UNZEEN_PLATFORM.feeRate / 1e4} %, creator ${UNZEEN_PLATFORM.creatorFeeRate / 1e4} %; LP ${UNZEEN_PLATFORM.platformScale / 1e4}/${UNZEEN_PLATFORM.creatorScale / 1e4}/${UNZEEN_PLATFORM.burnScale / 1e4} %`);
  const existing = await conn.getAccountInfo(platformId);
  if (existing) {
    const p = PlatformConfig.decode(existing.data);
    console.log(`already exists: "${Buffer.from(p.name).toString("utf8").replace(/\0+$/, "")}" fee=${p.feeRate} creatorFee=${p.creatorFeeRate}`);
    console.log(`  ${explorerAddressUrl(platformId.toBase58(), cfg.cluster)}`);
    return;
  }
  const ix = createPlatformConfig(
    program,
    admin.publicKey,
    admin.publicKey, // platform fee claim wallet
    admin.publicKey, // LP lock NFT wallet
    admin.publicKey, // vesting wallet (scale 0)
    platformId,
    cpConfigId,
    admin.publicKey, // transfer-fee extension authority (unused)
    { platformScale: new BN(UNZEEN_PLATFORM.platformScale), creatorScale: new BN(UNZEEN_PLATFORM.creatorScale), burnScale: new BN(UNZEEN_PLATFORM.burnScale) },
    new BN(UNZEEN_PLATFORM.feeRate),
    new BN(UNZEEN_PLATFORM.creatorFeeRate),
    UNZEEN_PLATFORM.name,
    UNZEEN_PLATFORM.web,
    UNZEEN_PLATFORM.img,
    new BN(0),
  );
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(PlatformConfig.span));
  const bal = BigInt(await conn.getBalance(admin.publicKey, "confirmed"));
  const funding = setupFunding([rent], bal);
  console.log(`partner needs ${sol(funding.need)} (platform rent ${sol(rent)} + fee margin), holds ${sol(bal)}`);
  if (gate.mainnet && funding.missing > 0n) console.log(fundingHint(admin.publicKey.toBase58(), funding.missing, funding.need));
  if (gate.mode === "dry") {
    console.log(`dry run (--simulate to simulate the tx, --send to create it${gate.mainnet ? "; mainnet: see the header for the gate" : ""})`);
    return;
  }
  if (gate.mode === "simulate") {
    const t = await signTx(conn, [ix], admin, [], { computeUnits: 200_000, priorityMicroLamports: 0 });
    const sim = await conn.simulateTransaction(VersionedTransaction.deserialize(t.raw), { sigVerify: false, replaceRecentBlockhash: true });
    console.log(`simulation: ${sim.value.err ? `FAILED ${JSON.stringify(sim.value.err)}` : "ok"} (${sim.value.unitsConsumed ?? "?"} CU), nothing sent`);
    for (const l of (sim.value.logs ?? []).slice(-8)) console.log(`  ${l}`);
    return;
  }
  if (gate.mainnet) {
    if (funding.missing > 0n) throw new Error("partner not funded: fund it from the operator's external wallet first (see above)");
    await confirmMainnet(admin.publicKey.toBase58(), gate.confirm, ttyAsk());
  }
  // devnet only: fund the partner from the richest vault if needed (see meteora-config.ts)
  const need = BigInt(LAMPORTS_PER_SOL) / 50n;
  if (devnet && bal < need) {
    const balances = await Promise.all(keys.vaults.map(async (v) => BigInt(await conn.getBalance(v.publicKey, "confirmed"))));
    const i = balances.reduce((b, x, k) => (x > balances[b]! ? k : b), 0);
    const t = await signTx(conn, [SystemProgram.transfer({ fromPubkey: keys.vaults[i]!.publicKey, toPubkey: admin.publicKey, lamports: need - bal })], keys.vaults[i]!, [], { computeUnits: 50_000, priorityMicroLamports: 0 });
    await broadcastAndConfirm(conn, t, new RpcBroadcaster(conn));
    console.log(`funded partner: ${explorerTxUrl(t.signature, cfg.cluster)}`);
  }
  // Same pool-wide prefix as every relayer tx (CU price; mainnet: Sender tip).
  const pipeline = txPipeline(cfg, conn);
  const fees = priorityFeeCacheFromConfig(cfg, conn, FEE_ESTIMATE_PROGRAMS);
  await fees.refresh().catch(() => undefined);
  const signed = await signTx(conn, [ix], admin, [], { computeUnits: 200_000, priorityMicroLamports: fees.microLamports(), tip: pipeline.tip });
  await broadcastAndConfirm(conn, signed, pipeline.broadcaster);
  console.log(`platform created: ${platformId.toBase58()}`);
  console.log(`  tx ${explorerTxUrl(signed.signature, cfg.cluster)}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    const f = e as { error?: unknown; logs?: string[] | null };
    if (f && typeof f === "object" && "error" in f) {
      console.error(redactSecrets(String(f.error)).slice(0, 500));
      for (const l of f.logs ?? []) console.error(`  ${l}`);
    } else console.error(redactSecrets(e instanceof Error ? (e.stack ?? e.message) : String(e)).slice(0, 2000));
    process.exit(1);
  });
