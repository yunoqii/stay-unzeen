/**
 * Snapshots the public pump.fun Global + FeeConfig accounts from the cluster
 * into test/fixtures so the quote tests run offline against real parameters.
 *   pnpm tsx scripts/snapshot-params.ts
 */
import fs from "node:fs";
import path from "node:path";
import { GLOBAL_PDA, PUMP_FEE_CONFIG_PDA } from "@pump-fun/pump-sdk";
import { loadConfig, makeConnection } from "../src/config";
import { loadRepoEnv } from "../src/env";

async function main(): Promise<void> {
  loadRepoEnv();
const cfg = loadConfig();
  const conn = makeConnection(cfg);
  const [g, f] = await conn.getMultipleAccountsInfo([GLOBAL_PDA, PUMP_FEE_CONFIG_PDA]);
  if (!g || !f) throw new Error("Global / FeeConfig not found");
  const out = {
    cluster: cfg.cluster,
    takenAt: new Date().toISOString(),
    global: { address: GLOBAL_PDA.toBase58(), owner: g.owner.toBase58(), data: g.data.toString("base64") },
    feeConfig: { address: PUMP_FEE_CONFIG_PDA.toBase58(), owner: f.owner.toBase58(), data: f.data.toString("base64") },
  };
  const file = path.resolve(__dirname, "../test/fixtures/pump-params.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
