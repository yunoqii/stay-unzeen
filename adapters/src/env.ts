import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * Environment loading for the adapters / relayer.
 *
 * Secrets (RPC URLs with api keys, DATABASE_URL) come only from the repo-root
 * `.env` (git-ignored) or the process environment. Values are never printed:
 * use `maskUrl` / `redactSecrets` for anything that reaches a log.
 */

/** adapters/ (src/ and dist/ are both one level below it). */
export const PKG_ROOT = path.resolve(__dirname, "..");
/** Repository root (adapters/..). */
export const REPO_ROOT = path.resolve(PKG_ROOT, "..");

/**
 * Loads `<repo>/.env` (and `adapters/.env` if present) into `env` without
 * overriding variables that are already set (the real environment wins, like
 * `node --env-file`). Returns the files that were read (paths only).
 */
export function loadRepoEnv(
  env: NodeJS.ProcessEnv = process.env,
  files: readonly string[] = [path.join(REPO_ROOT, ".env"), path.join(PKG_ROOT, ".env")],
): string[] {
  const loaded: string[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const parsed = parseEnv(fs.readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (env[k] === undefined) env[k] = v;
    }
    loaded.push(file);
  }
  return loaded;
}

export type RpcCluster = "devnet" | "testnet" | "mainnet-beta" | "localnet";

export const PUBLIC_RPC_URL: Record<RpcCluster, string> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export interface ResolvedRpc {
  url: string;
  /** Which variable it came from (for diagnostics; never the value). */
  source: "SOLANA_RPC_URL_DEVNET" | "SOLANA_RPC_URL_MAINNET" | "SOLANA_RPC_URL" | "public";
}

/**
 * RPC per network: SOLANA_RPC_URL_DEVNET / SOLANA_RPC_URL_MAINNET, then
 * SOLANA_RPC_URL, then the public endpoint of the cluster.
 */
export function resolveRpcUrl(cluster: RpcCluster, env: NodeJS.ProcessEnv = process.env): ResolvedRpc {
  const specific =
    cluster === "devnet" ? "SOLANA_RPC_URL_DEVNET" : cluster === "mainnet-beta" ? "SOLANA_RPC_URL_MAINNET" : null;
  if (specific) {
    const v = env[specific]?.trim();
    if (v) return { url: v, source: specific };
  }
  const generic = env.SOLANA_RPC_URL?.trim();
  if (generic) return { url: generic, source: "SOLANA_RPC_URL" };
  return { url: PUBLIC_RPC_URL[cluster], source: "public" };
}

/**
 * Printable form of a URL that may carry credentials: scheme + host only;
 * userinfo, path and query are replaced by `***` (Helius puts the api key in
 * the query, others in the path).
 */
export function maskUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "<invalid url>";
  }
  const auth = u.username || u.password ? "***@" : "";
  const hasPath = u.pathname !== "" && u.pathname !== "/";
  return `${u.protocol}//${auth}${u.host}${hasPath ? "/***" : ""}${u.search ? "?***" : ""}`;
}

const KEYISH_PARAM = /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|auth)=)[^&\s"']+/gi;

/**
 * Removes secrets from free text (error messages): every known secret URL is
 * masked, and any `api-key=`/`token=` query value is replaced by `***`.
 */
export function redactSecrets(text: string, secrets: readonly string[] = knownSecretUrls()): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join(maskUrl(s));
  }
  return out.replace(KEYISH_PARAM, "$1***");
}

/** Secret-bearing env values that must never reach logs. */
export function knownSecretUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    "SOLANA_RPC_URL_DEVNET",
    "SOLANA_RPC_URL_MAINNET",
    "SOLANA_RPC_URL",
    "SOLANA_READ_RPC_URL_DEVNET",
    "SOLANA_READ_RPC_URL_MAINNET",
    "SOLANA_READ_WS_URL_DEVNET",
    "SOLANA_READ_WS_URL_MAINNET",
    "SOLANA_INDEX_RPC_URL_DEVNET",
    "SOLANA_INDEX_RPC_URL_MAINNET",
    "SOLANA_PRIORITY_FEE_URL",
    "SOLANA_SENDER_URL",
    "SHYFT_API_KEY",
    "DATABASE_URL",
    "DATABASE_URL_RELAYER",
    "DATABASE_URL_INDEXER",
    "PINATA_JWT",
  ]
    .map((k) => env[k]?.trim() ?? "")
    .filter((v) => v.length > 0);
}
