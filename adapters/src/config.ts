import path from "node:path";
import { Connection, clusterApiUrl, type Commitment } from "@solana/web3.js";

export type SolanaCluster = "devnet" | "testnet" | "mainnet-beta" | "localnet";

export interface AdapterConfig {
  cluster: SolanaCluster;
  rpcUrl: string;
  keysDir: string;
  priorityMicroLamports: number;
  commitment: Commitment;
}

// src/ (tsx, vitest) and dist/ (build) are both one level below the package root.
const PKG_ROOT = path.resolve(__dirname, "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  const cluster = (env.SOLANA_CLUSTER?.trim() || "devnet") as SolanaCluster;
  if (!["devnet", "testnet", "mainnet-beta", "localnet"].includes(cluster)) {
    throw new Error(`SOLANA_CLUSTER must be devnet|testnet|mainnet-beta|localnet, got "${cluster}"`);
  }
  if (cluster === "mainnet-beta" && env.UNZEEN_ALLOW_MAINNET !== "yes") {
    throw new Error("mainnet-beta is disabled; set UNZEEN_ALLOW_MAINNET=yes only with the lead's approval");
  }
  const rpcUrl =
    env.SOLANA_RPC_URL?.trim() || (cluster === "localnet" ? "http://127.0.0.1:8899" : clusterApiUrl(cluster));
  const keysDir = path.resolve(PKG_ROOT, env.UNZEEN_KEYS_DIR?.trim() || "keys");
  const priorityMicroLamports = Number(env.SOLANA_PRIORITY_MICROLAMPORTS ?? 0) || 0;
  return { cluster, rpcUrl, keysDir, priorityMicroLamports, commitment: "confirmed" };
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
