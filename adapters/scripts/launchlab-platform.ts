/**
 * Unzeen's own Raydium LaunchLab platform config ("Unzeen"), one per network
 * (PDA of the platform admin = the pool's partner key, never a vault):
 *
 *   pnpm launchlab:platform              # dry run: prints parameters and addresses
 *   pnpm launchlab:platform --send       # DEVNET only: creates it
 *   SOLANA_CLUSTER=mainnet-beta UNZEEN_ALLOW_MAINNET=yes pnpm launchlab:platform
 *                                        # mainnet: DESCRIBES the tx (message base64), never sends
 *
 * Fees (rates in 1e-6): protocol 0.25 % (GlobalConfig) + platform 0.45 % + creator 0.30 % = 1 %,
 * the same total as the DBC curve; creator 0.30 % = the rate core assumes for pump.fun.
 * LP after graduation: 100 % platform (locked NFT, fees only): the program requires creatorScale = 0.
 * Prints public addresses and signatures only.
 */
import BN from "bn.js";
import { CREATE_CPMM_POOL_PROGRAM, DEVNET_PROGRAM_ID, DEV_LAUNCHPAD_PROGRAM, LAUNCHPAD_PROGRAM, PlatformConfig, createPlatformConfig, getPdaPlatformId } from "@raydium-io/raydium-sdk-v2";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage } from "@solana/web3.js";
import { describeConfig, explorerAddressUrl, explorerTxUrl, loadConfig, makeConnection } from "../src/config";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { UNZEEN_PLATFORM } from "../src/launchlab";
import { derivePartnerKeypair } from "../src/meteora";
import { openKeys } from "../src/relayer/runtime";
import { broadcastAndConfirm, RpcBroadcaster, signTx } from "../src/tx";

loadRepoEnv();
const cfg = loadConfig();
const conn = makeConnection(cfg);

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
  if (!devnet) {
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({ payerKey: admin.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToLegacyMessage();
    console.log("MAINNET: not sent. Message (base64, sign with the partner key after the lead's approval):");
    console.log(Buffer.from(msg.serialize()).toString("base64"));
    return;
  }
  if (!process.argv.includes("--send")) {
    console.log("dry run (add --send on devnet to create it)");
    return;
  }
  // devnet: fund the partner from the richest vault if needed (devnet only; see meteora-config.ts)
  const need = BigInt(LAMPORTS_PER_SOL) / 50n;
  const bal = BigInt(await conn.getBalance(admin.publicKey, "confirmed"));
  if (bal < need) {
    const balances = await Promise.all(keys.vaults.map(async (v) => BigInt(await conn.getBalance(v.publicKey, "confirmed"))));
    const i = balances.reduce((b, x, k) => (x > balances[b]! ? k : b), 0);
    const t = await signTx(conn, [SystemProgram.transfer({ fromPubkey: keys.vaults[i]!.publicKey, toPubkey: admin.publicKey, lamports: need - bal })], keys.vaults[i]!, [], { computeUnits: 50_000, priorityMicroLamports: 0 });
    await broadcastAndConfirm(conn, t, new RpcBroadcaster(conn));
    console.log(`funded partner: ${explorerTxUrl(t.signature, cfg.cluster)}`);
  }
  const signed = await signTx(conn, [ix], admin, [], { computeUnits: 200_000, priorityMicroLamports: 0 });
  await broadcastAndConfirm(conn, signed, new RpcBroadcaster(conn));
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
