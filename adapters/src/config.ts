import os from "node:os";
import path from "node:path";
import { Connection, type Commitment } from "@solana/web3.js";
import { PKG_ROOT, maskUrl, resolveRpcUrl, type ResolvedRpc } from "./env";
import { SWQOS_MIN_TIP_LAMPORTS, senderUrl } from "./sender";

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
  /**
   * URL for `getPriorityFeeEstimate` (SOLANA_PRIORITY_FEE_URL, default
   * SOLANA_RPC_URL_MAINNET on mainnet). Independent of the main RPC: moving
   * reads elsewhere never silently switches the fee estimate (rpc-providers P5).
   */
  priorityFeeUrl: string | null;
  /** Mainnet: Helius Sender URL (SOLANA_SENDER_URL, default SWQOS-only + api key of SOLANA_RPC_URL_MAINNET); null elsewhere. */
  senderUrl: string | null;
  /** Pool-wide Sender tip, lamports (SOLANA_SENDER_TIP_LAMPORTS, default and minimum 5000). */
  senderTipLamports: bigint;
  /** Min interval between sends (SOLANA_SEND_MIN_INTERVAL_MS, default 1000: Helius Free 1 tx/s). */
  sendMinIntervalMs: number;
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
  const priorityFeeUrl = env.SOLANA_PRIORITY_FEE_URL?.trim() || (cluster === "mainnet-beta" ? env.SOLANA_RPC_URL_MAINNET?.trim() || null : null);
  const priorityFeeSource = feeSource(cluster, priorityFeeUrl, env.SOLANA_PRIORITY_FEE_SOURCE);
  const priorityMaxMicroLamports = Number(env.SOLANA_PRIORITY_MAX_MICROLAMPORTS ?? 0) || 1_000_000;
  const senderTipLamports = BigInt(env.SOLANA_SENDER_TIP_LAMPORTS?.trim() || SWQOS_MIN_TIP_LAMPORTS);
  if (senderTipLamports < SWQOS_MIN_TIP_LAMPORTS) throw new Error(`SOLANA_SENDER_TIP_LAMPORTS must be >= ${SWQOS_MIN_TIP_LAMPORTS}`);
  const interval = env.SOLANA_SEND_MIN_INTERVAL_MS?.trim();
  const sendMinIntervalMs = interval ? Number(interval) : 1_000;
  if (!Number.isFinite(sendMinIntervalMs) || sendMinIntervalMs < 0) throw new Error("SOLANA_SEND_MIN_INTERVAL_MS must be >= 0");
  return {
    cluster,
    rpcUrl: rpc.url,
    rpcSource: rpc.source,
    keysDir,
    priorityMicroLamports,
    priorityFeeSource,
    priorityMaxMicroLamports,
    priorityFeeUrl,
    senderUrl: cluster === "mainnet-beta" ? senderUrl(env.SOLANA_SENDER_URL, env.SOLANA_RPC_URL_MAINNET) : null,
    senderTipLamports,
    sendMinIntervalMs,
    commitment: "confirmed",
  };
}

/**
 * helius: getPriorityFeeEstimate on `priorityFeeUrl` (mainnet only: Helius
 * devnet answers "Method not found"); rpc: standard
 * getRecentPrioritizationFees; fixed: constant. Chosen from the fee URL
 * itself, never from the host of the main RPC (rpc-providers P5).
 */
function feeSource(cluster: SolanaCluster, feeUrl: string | null, explicit: string | undefined): AdapterConfig["priorityFeeSource"] {
  const v = explicit?.trim();
  if (v) {
    if (v !== "helius" && v !== "rpc" && v !== "fixed") throw new Error(`SOLANA_PRIORITY_FEE_SOURCE must be helius|rpc|fixed, got "${v}"`);
    if (v === "helius" && !feeUrl) throw new Error("SOLANA_PRIORITY_FEE_SOURCE=helius needs SOLANA_PRIORITY_FEE_URL (or SOLANA_RPC_URL_MAINNET)");
    return v;
  }
  if (cluster === "localnet") return "fixed";
  return cluster === "mainnet-beta" && feeUrl ? "helius" : "rpc";
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
