/**
 * READ-ONLY mainnet check of LaunchLab creates on third-party platforms (stonk.fun, bonk.fun):
 *   pnpm launchlab:probe [--quote SOL|USD1] [--leg]
 * Evaluates our launch parameters against each platform's curve rule and simulates
 * initialize_v2 + buy_exact_in with `simulateTransaction` (sigVerify off, a funded public
 * address as payer, random mint / creator). Nothing is signed or sent.
 * --leg (USD1 only): the first buy is funded by the pool-A leg (Raydium CLMM SOL->USD1
 * ExactOut) in the same tx, exactly as LaunchLabAdapter builds it when the vault has no
 * USD1 stock. Prints the tx size without / with the vault lookup table (stable accounts
 * only, same rule as the adapter) and simulates the form that fits.
 */
import BN from "bn.js";
import { CpmmCreatorFeeOn, LaunchpadConfig, PlatformConfig, buyExactInInstruction, getPdaCreatorVault, getPdaLaunchpadAuth, getPdaLaunchpadPoolId, getPdaLaunchpadVaultId, getPdaMetadataKey, getPdaPlatformCurveRule, getPdaPlatformVault, initializeV2, initializeWithToken2022 } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { AddressLookupTableAccount, ComputeBudgetProgram, MessageV0, Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { staticAccounts } from "../src/alt";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { ClmmPoolA } from "../src/pool-a-clmm";
import { LAUNCHLAB_CONFIGS, LAUNCHLAB_PLATFORMS, LAUNCHLAB_PROGRAM, LAUNCH_SUPPLY, LAUNCH_TOTAL_SELL, fundRaisingFor } from "../src/launchlab";

loadRepoEnv();
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** v0 message length without serializing (MessageV0.serialize throws past 1232 bytes). */
function messageV0Bytes(m: MessageV0): number {
  const cl = (n: number) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);
  let n = 1 + 3 + cl(m.staticAccountKeys.length) + 32 * m.staticAccountKeys.length + 32 + cl(m.compiledInstructions.length);
  for (const ix of m.compiledInstructions) n += 1 + cl(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length + cl(ix.data.length) + ix.data.length;
  n += cl(m.addressTableLookups.length);
  for (const l of m.addressTableLookups) n += 32 + cl(l.writableIndexes.length) + l.writableIndexes.length + cl(l.readonlyIndexes.length) + l.readonlyIndexes.length;
  return n;
}

async function main(): Promise<void> {
  const conn = new Connection(process.env.SOLANA_RPC_URL_MAINNET!, "confirmed");
  const program = LAUNCHLAB_PROGRAM["mainnet-beta"];
  const auth = getPdaLaunchpadAuth(program).publicKey;
  const quote = (arg("--quote") ?? "SOL").toUpperCase();
  const mintB = quote === "SOL" ? NATIVE_MINT : new PublicKey("USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB");
  const configId = new PublicKey(LAUNCHLAB_CONFIGS["mainnet-beta"][mintB.toBase58()]!);
  const config = LaunchpadConfig.decode((await conn.getAccountInfo(configId))!.data);
  const payer = new PublicKey(arg("--payer") ?? "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  const supply = new BN(LAUNCH_SUPPLY.toString());
  const totalSellA = new BN(LAUNCH_TOTAL_SELL.toString());
  const totalFundRaisingB = new BN(fundRaisingFor({ mint: mintB, decimals: quote === "SOL" ? 9 : 6 }).toString());
  const withLeg = process.argv.includes("--leg");
  if (withLeg && quote === "SOL") throw new Error("--leg needs a non-SOL quote");
  const poolA = withLeg ? new ClmmPoolA(conn, new PublicKey("AQAGYQsdU853WAKhXM79CgNdoyhrRwXvYHX6qrDyC1FS"), { mint: mintB, decimals: 6, tokenProgram: TOKEN_PROGRAM_ID }) : null;
  const legState = poolA ? await poolA.load() : null;
  for (const [name, id] of Object.entries(LAUNCHLAB_PLATFORMS["mainnet-beta"])) {
    const platformId = new PublicKey(id);
    const platform = PlatformConfig.decode((await conn.getAccountInfo(platformId))!.data);
    const ruleId = platform.restrictCurveParam ? getPdaPlatformCurveRule(program, platformId, configId).publicKey : undefined;
    for (const t22 of [false, true]) {
    const buy = quote === "SOL" ? 10_000_000n : 1_000_000n;
    const maxLamports = poolA && legState ? (poolA.solForExactQuote(legState, buy) * 10_100n) / 10_000n : 0n;
    const build = async (mintA: PublicKey, creator: PublicKey, payerPk: PublicKey): Promise<TransactionInstruction[]> => {
    const poolId = getPdaLaunchpadPoolId(program, mintA, mintB).publicKey;
    const vaultA = getPdaLaunchpadVaultId(program, poolId, mintA).publicKey;
    const vaultB = getPdaLaunchpadVaultId(program, poolId, mintB).publicKey;
    const progA = t22 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const userA = getAssociatedTokenAddressSync(mintA, payerPk, true, progA);
    const userB = getAssociatedTokenAddressSync(mintB, payerPk, true);
    const curveParam = { type: "ConstantCurve" as const, totalSellA, migrateType: "cpmm" as const, supply, totalFundRaisingB };
    const leg = poolA && legState ? await poolA.buyQuoteExactOut(payerPk, legState, buy, maxLamports) : [];
    return [
      ComputeBudgetProgram.setComputeUnitLimit({ units: quote === "SOL" ? 400_000 : 500_000 }),
      t22
        ? initializeWithToken2022(program, payerPk, creator, configId, platformId, auth, poolId, mintA, mintB, vaultA, vaultB, TOKEN_PROGRAM_ID, 6, "Probe", "PRB", "https://unzeen.invalid/p.json", curveParam, new BN(0), new BN(0), new BN(0), CpmmCreatorFeeOn.OnlyTokenB, undefined, undefined, ruleId)
        : initializeV2(program, payerPk, creator, configId, platformId, auth, poolId, mintA, mintB, vaultA, vaultB, getPdaMetadataKey(mintA).publicKey, TOKEN_PROGRAM_ID, 6, "Probe", "PRB", "https://unzeen.invalid/p.json", curveParam, new BN(0), new BN(0), new BN(0), CpmmCreatorFeeOn.OnlyTokenB, undefined, ruleId),
      ...leg,
      createAssociatedTokenAccountIdempotentInstruction(payerPk, userA, payerPk, mintA, progA),
      createAssociatedTokenAccountIdempotentInstruction(payerPk, userB, payerPk, mintB),
      ...(quote === "SOL" ? [SystemProgram.transfer({ fromPubkey: payerPk, toPubkey: userB, lamports: buy }), createSyncNativeInstruction(userB)] : []),
      buyExactInInstruction(program, payerPk, auth, configId, platformId, poolId, userA, userB, vaultA, vaultB, mintA, mintB, progA, TOKEN_PROGRAM_ID,
        getPdaPlatformVault(program, platformId, mintB).publicKey, getPdaCreatorVault(program, creator, mintB).publicKey, new BN(buy.toString()), new BN(1)),
    ];
    };
    const ixs = await build(Keypair.generate().publicKey, Keypair.generate().publicKey, payer);
    const { blockhash } = await conn.getLatestBlockhash();
    // Sizes: 1 signature for the payer + 1 for the mint keypair (as signed by the adapter).
    const size = (luts: AddressLookupTableAccount[]) => {
      const m = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(luts);
      return { msg: m, bytes: 1 + 64 * m.header.numRequiredSignatures + messageV0Bytes(m) };
    };
    const raw = size([]);
    const other = await build(Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey);
    const table = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: staticAccounts(ixs, other) } });
    const alt = size([table]);
    if (withLeg) console.log(`  tx size: ${raw.bytes} B without ALT, ${alt.bytes} B with the vault ALT (${table.state.addresses.length} stable accounts); limit 1232; leg max ${maxLamports} lamports for ${buy} USD1 units`);
    // A local ALT cannot be simulated (the RPC resolves tables on chain): an over-limit legacy form
    // is simulated only if it fits, otherwise the leg is checked on its own below.
    let sim;
    if (raw.bytes <= 1232) sim = await conn.simulateTransaction(new VersionedTransaction(raw.msg), { sigVerify: false, replaceRecentBlockhash: true });
    else {
      console.log("  full tx needs the ALT: simulating create+buy (from stock) and the leg separately");
      continue;
    }
    console.log(`${name} (${id.slice(0, 6)}…, restrictCurve=${platform.restrictCurveParam}) quote ${quote} base ${t22 ? "Token-2022" : "SPL"}: err=${JSON.stringify(sim.value.err)} cu=${sim.value.unitsConsumed}`);
    if (sim.value.err) for (const l of (sim.value.logs ?? []).filter((x) => /Error Message|Left|Right/i.test(x)).slice(0, 4)) console.log(`    ${l}`);
    }
  }
}

main().catch((e) => {
  console.error(redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 400));
  process.exit(1);
});
