import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, describeConfig, solanaKeysDir } from "../src/config";
import { loadRepoEnv, maskUrl, redactSecrets, resolveRpcUrl } from "../src/env";

const HELIUS = "https://devnet.helius-rpc.com/?api-key=00000000-1111-2222-3333-444444444444";

describe("env / RPC", () => {
  it("picks the per-network RPC, then SOLANA_RPC_URL, then public", () => {
    const env = { SOLANA_RPC_URL_DEVNET: HELIUS, SOLANA_RPC_URL_MAINNET: "https://m.example/x", SOLANA_RPC_URL: "https://g.example" };
    expect(resolveRpcUrl("devnet", env)).toEqual({ url: HELIUS, source: "SOLANA_RPC_URL_DEVNET" });
    expect(resolveRpcUrl("mainnet-beta", env).source).toBe("SOLANA_RPC_URL_MAINNET");
    expect(resolveRpcUrl("devnet", { SOLANA_RPC_URL: "https://g.example" }).source).toBe("SOLANA_RPC_URL");
    expect(resolveRpcUrl("devnet", {})).toEqual({ url: "https://api.devnet.solana.com", source: "public" });
  });

  it("masks api keys in URLs and free text", () => {
    expect(maskUrl(HELIUS)).toBe("https://devnet.helius-rpc.com?***");
    expect(maskUrl("https://user:pw@rpc.example/secret-path")).toBe("https://***@rpc.example/***");
    const msg = `failed to fetch ${HELIUS}: 429`;
    const red = redactSecrets(msg, [HELIUS]);
    expect(red).not.toContain("00000000-1111");
    expect(redactSecrets("GET https://x.io/?api-key=abc123&y=1", [])).toBe("GET https://x.io/?api-key=***&y=1");
  });

  it("describeConfig never prints the key", () => {
    const cfg = loadConfig({ SOLANA_RPC_URL_DEVNET: HELIUS, SOLANA_KEYS_DIR: "/tmp/k" });
    expect(describeConfig(cfg)).not.toContain("00000000");
    expect(describeConfig(cfg)).toContain("SOLANA_RPC_URL_DEVNET");
  });

  it("loads .env without overriding the real environment", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unz-env-"));
    const f = path.join(dir, ".env");
    fs.writeFileSync(f, "A=from_file\nB=from_file\n");
    const env: NodeJS.ProcessEnv = { A: "real" };
    expect(loadRepoEnv(env, [f, path.join(dir, "missing")])).toEqual([f]);
    expect(env).toEqual({ A: "real", B: "from_file" });
    fs.rmSync(dir, { recursive: true });
  });

  it("keys default to ~/.unzeen/<cluster>/solana, never UNZEEN_KEYS_DIR", () => {
    expect(solanaKeysDir("devnet", { UNZEEN_KEYS_DIR: "/core/keys" })).toBe(
      path.join(os.homedir(), ".unzeen", "devnet", "solana"),
    );
    expect(solanaKeysDir("devnet", { UNZEEN_HOME: "/srv/u" })).toBe("/srv/u/devnet/solana");
    expect(solanaKeysDir("devnet", { SOLANA_KEYS_DIR: "/k" })).toBe("/k");
  });

  it("refuses mainnet without explicit approval", () => {
    expect(() => loadConfig({ SOLANA_CLUSTER: "mainnet-beta" })).toThrow(/disabled/);
  });
});
