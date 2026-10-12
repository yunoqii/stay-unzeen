import os from "node:os";
import path from "node:path";
import { Connection, type Commitment } from "@solana/web3.js";
import { PKG_ROOT, maskUrl, resolveRpcUrl, type ResolvedRpc } from "./env";

export type SolanaCluster = "devnet" | "testnet" | "mainnet-beta" | "localnet";

export interface AdapterConfig {
  cluster: SolanaCluster;
  rpcUrl: string;
  /** Where the RPC URL came from (variable name, never the value). */
  rpcSource: ResolvedRpc["source"];
  keysDir: string;
  priorityMicroLamports: number;
  commitment: Commitment;
}

/**
 * Reads the adapter config from `env` (call `loadRepoEnv()` first to pick up
 * the repo-root `.env`).
 *
 * - cluster: SOLANA_CLUSTER, else UNZEEN_SOLANA_CLUSTER (shared with core), else devnet.
 * - RPC: SOLANA_RPC_URL_DEVNET / SOLANA_RPC_URL_MAINNET, else SOLANA_RPC_URL, else public.
 * - keys: SOLANA_KEYS_DIR, default `$UNZEEN_HOME/<cluster>/solana`
 *   (UNZEEN_HOME defaults to ~/.unzeen, same root as core; outside the repo
 *   and ~/Desktop, which may sync to iCloud). Deliberately NOT
 *   `UNZEEN_KEYS_DIR`: that is core's Zcash key dir in the shared root `.env`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  const cluster = (env.SOLANA_CLUSTER?.trim() || env.UNZEEN_SOLANA_CLUSTER?.trim() || "devnet") as SolanaCluster;
  if (!["devnet", "testnet", "mainnet-beta", "localnet"].includes(cluster)) {
    throw new Error(`SOLANA_CLUSTER must be devnet|testnet|mainnet-beta|localnet, got "${cluster}"`);
  }
  if (cluster === "mainnet-beta" && env.UNZEEN_ALLOW_MAINNET !== "yes") {
    throw new Error("mainnet-beta is disabled; set UNZEEN_ALLOW_MAINNET=yes only with the lead's approval");
  }
  const rpc = resolveRpcUrl(cluster, env);
  const keysDir = solanaKeysDir(cluster, env);
  const priorityMicroLamports = Number(env.SOLANA_PRIORITY_MICROLAMPORTS ?? 0) || 0;
  return { cluster, rpcUrl: rpc.url, rpcSource: rpc.source, keysDir, priorityMicroLamports, commitment: "confirmed" };
}

export function solanaKeysDir(cluster: SolanaCluster, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.SOLANA_KEYS_DIR?.trim();
  if (explicit) return path.resolve(PKG_ROOT, expandHome(explicit));
  const home = expandHome(env.UNZEEN_HOME?.trim() || path.join(os.homedir(), ".unzeen"));
  return path.resolve(home, cluster, "solana");
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** One-line description safe for logs (RPC credentials masked). */
export function describeConfig(cfg: AdapterConfig): string {
  return `cluster=${cfg.cluster} rpc=${maskUrl(cfg.rpcUrl)} (from ${cfg.rpcSource})`;
}

export function makeConnection(cfg: AdapterConfig): Connection {
  return new Connection(cfg.rpcUrl, { commitment: cfg.commitment });
}

export function explorerTxUrl(signature: string, cluster: SolanaCluster): string {
  const q = cluster === "mainnet-beta" ? "" : `?cluster=${cluster === "localnet" ? "custom" : cluster}`;
  return `https://explorer.solana.com/tx/${signature}${q}`;
}

export function explorerAddressUrl(address: string, cluster: SolanaCluster): string {
  const q = cluster === "mainnet-beta" ? "" : `?cluster=${cluster === "localnet" ? "custom" : cluster}`;
  return `https://explorer.solana.com/address/${address}${q}`;
}
