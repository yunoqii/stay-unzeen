import { Connection, Keypair } from "@solana/web3.js";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { buildRelayer } from "../src/relayer/runtime";

const MAIN = { SOLANA_CLUSTER: "mainnet-beta", UNZEEN_ALLOW_MAINNET: "yes", SOLANA_RPC_URL_MAINNET: "https://mainnet.helius-rpc.com/?api-key=k" };

function build(env: NodeJS.ProcessEnv) {
  const cfg = loadConfig(MAIN);
  const db = new pg.Pool();
  const warns: string[] = [];
  const rt = buildRelayer({
    cfg,
    connection: new Connection("http://127.0.0.1:1"),
    network: "mainnet-beta",
    keys: { store: {} as never, vaults: [Keypair.generate()], creatorSeed: Buffer.alloc(64, 1) },
    db,
    lockDb: db,
    env,
    warn: (m) => warns.push(m),
    mintVaults: {} as never,
    creatorCounter: { next: async () => 0 } as never,
    creatorRegistry: null,
  });
  void db.end();
  return { rt, warns };
}

describe("mainnet relayer wiring", () => {
  it("GAP-3: METEORA_DBC_CONFIG_MAINNET from env -> venue meteora-dbc served; absent -> off", () => {
    const pk = Keypair.generate().publicKey.toBase58();
    expect(build({ ...MAIN, METEORA_DBC_CONFIG_MAINNET: pk }).rt.meteora).not.toBeNull();
    expect(build({ ...MAIN }).rt.meteora).toBeNull();
  });
  it("GAP-5: http://127.0.0.1 metadata base on mainnet -> no store, a precise warning", () => {
    const { rt, warns } = build({ ...MAIN, UNZEEN_METADATA_BASE_URL: "http://127.0.0.1:8090/media" });
    expect(rt.metadata).toBeNull();
    expect(warns.some((w) => /UNZEEN_METADATA_BASE_URL refused on mainnet \(not https\)/.test(w))).toBe(true);
    expect(warns.some((w) => /^no metadata store/.test(w))).toBe(false);
    expect(build({ ...MAIN, UNZEEN_METADATA_BASE_URL: "https://api.unzeen.xyz/media" }).rt.metadata).not.toBeNull();
  });
});
