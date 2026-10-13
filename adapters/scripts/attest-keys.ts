/**
 * Prints the PUBLIC attestation keys of this network and their SOL balance
 * (docs/RUNBOOK.md GAP3), so the operator knows what to fund before a run:
 *   pnpm keys:attest
 * - verify: Verify operator key (m/44'/501'/2147483645'/2'), public on /verify;
 * - fair:   fair-launch key    (m/44'/501'/2147483645'/3'), internal until 28.10.
 * - rebal:  rebalance address  (m/44'/501'/2147483645'/4'), RELAYER v7: 1Click delivers SOL
 *           here, `fund_vaults` spreads it over the vaults (UNZEEN_REBALANCE_SOL_ADDRESS).
 * All derived from the creator master seed. Nothing secret is printed.
 * Fund them from an external wallet, NEVER from a pool vault (RELAYER v5:
 * a vault -> attestation key transfer would link the pool to the signer).
 */
import { loadConfig, makeConnection } from "../src/config";
import { deriveAttestKeypair } from "../src/attest";
import { deriveRebalanceKeypair } from "../src/rebalance";
import { loadRepoEnv, redactSecrets } from "../src/env";
import { openKeys, relayerNetwork } from "../src/relayer/runtime";

loadRepoEnv();

async function main(): Promise<void> {
  const cfg = loadConfig();
  const network = relayerNetwork(cfg);
  const keys = await openKeys(cfg, process.env, (m) => console.error(`[keys:attest] WARN ${m}`));
  const connection = makeConnection(cfg);
  console.log(`network ${network}`);
  const rows = [
    ["verify", deriveAttestKeypair(keys.creatorSeed, "verify").publicKey],
    ["fair", deriveAttestKeypair(keys.creatorSeed, "fair").publicKey],
    // RELAYER v7: rebalance address (1Click delivers SOL here; fund_vaults spreads it). Put it in
    // the scanner's UNZEEN_REBALANCE_SOL_ADDRESS. Never fund attestation keys from it.
    ["rebal", deriveRebalanceKeypair(keys.creatorSeed).publicKey],
  ] as const;
  for (const [purpose, pk] of rows) {
    const lamports = await connection.getBalance(pk, "confirmed").catch(() => null);
    const sol = lamports === null ? "unknown (RPC error)" : `${(lamports / 1e9).toFixed(9)} SOL`;
    const low = purpose !== "rebal" && lamports !== null && lamports < 1_000_000 ? "  <- below 0.001 SOL: its attest jobs will fail" : "";
    console.log(`${purpose.padEnd(6)} ${pk.toBase58()}  ${sol}${low}`);
  }
}

main().catch((e) => {
  console.error(`[keys:attest] fatal: ${redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  process.exit(1);
});
