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
  /**
   * Fixed raw priority price (SOLANA_PRIORITY_MICROLAMPORTS). With the relayer
   * it only seeds / replaces the background estimate (src/fees.ts); every tx
   * gets the same quantized value either way.
   */
  priorityMicroLamports: number;
  /** Where the pool-wide price comes from (SOLANA_PRIORITY_FEE_SOURCE). */
  priorityFeeSource: "helius" | "rpc" | "fixed";
  /** Clamp, µlamports per CU (SOLANA_PRIORITY_MAX_MICROLAMPORTS). */
  priorityMaxMicroLamports: number;
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
  const priorityFeeSource = feeSource(cluster, rpc.url, env.SOLANA_PRIORITY_FEE_SOURCE);
  const priorityMaxMicroLamports = Number(env.SOLANA_PRIORITY_MAX_MICROLAMPORTS ?? 0) || 1_000_000;
  return {
    cluster,
    rpcUrl: rpc.url,
    rpcSource: rpc.source,
    keysDir,
    priorityMicroLamports,
    priorityFeeSource,
    priorityMaxMicroLamports,
    commitment: "confirmed",
  };
}

/**
 * helius: Helius RPC on mainnet (getPriorityFeeEstimate is not served on
 * Helius devnet); rpc: standard getRecentPrioritizationFees; fixed: constant.
 */
function feeSource(cluster: SolanaCluster, rpcUrl: string, explicit: string | undefined): AdapterConfig["priorityFeeSource"] {
  const v = explicit?.trim();
  if (v) {
    if (v !== "helius" && v !== "rpc" && v !== "fixed") throw new Error(`SOLANA_PRIORITY_FEE_SOURCE must be helius|rpc|fixed, got "${v}"`);
    return v;
  }
  let host = "";
  try {
    host = new URL(rpcUrl).host;
  } catch {
    /* invalid URL fails later in Connection */
  }
  if (cluster === "localnet") return "fixed";
  return cluster === "mainnet-beta" && host.endsWith("helius-rpc.com") ? "helius" : "rpc";
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
