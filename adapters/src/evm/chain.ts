import os from "node:os";
import path from "node:path";
import { defineChain, http, type Chain, type Transport } from "viem";
import { PKG_ROOT, maskUrl } from "../env";

/**
 * Robinhood Chain (Arbitrum Orbit / Nitro L2), docs/analysis/robinhood-chain.md §1.
 * Feature flag: the whole EVM side is off unless `UNZEEN_HOOD=on`.
 */

export type HoodNetwork = "mainnet" | "testnet";

export const HOOD_CHAIN_ID: Record<HoodNetwork, number> = { mainnet: 4663, testnet: 46630 };

export const HOOD_PUBLIC_RPC: Record<HoodNetwork, string> = {
  mainnet: "https://rpc.mainnet.chain.robinhood.com",
  testnet: "https://rpc.testnet.chain.robinhood.com",
};

export const hoodMainnet: Chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [HOOD_PUBLIC_RPC.mainnet] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const hoodTestnet: Chain = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [HOOD_PUBLIC_RPC.testnet] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

export function hoodChain(network: HoodNetwork): Chain {
  return network === "mainnet" ? hoodMainnet : hoodTestnet;
}

export interface HoodConfig {
  network: HoodNetwork;
  chainId: number;
  /** Read RPC (eth_call, logs, receipts). */
  rpcUrl: string;
  rpcSource: "HOOD_RPC_URL_MAINNET" | "HOOD_RPC_URL_TESTNET" | "public";
  /** Send RPC (eth_sendRawTransaction); defaults to rpcUrl. */
  sendRpcUrl: string;
  /** Requests per second towards each RPC (token bucket). */
  maxRps: number;
  /** Encrypted EVM key dir, `$UNZEEN_HOME/hood-<network>/evm` by default. */
  keysDir: string;
  /**
   * Sends allowed? Testnet: yes. Mainnet: only with UNZEEN_ALLOW_HOOD_MAINNET=yes
   * (lead's explicit approval); until then the adapter is read-only there
   * (eth_call / simulations).
   */
  allowSend: boolean;
  /** Pool-wide fee profile floor: maxFeePerGas, wei (HOOD_MAX_FEE_WEI, default 0.2 gwei = 10x the 0.02 gwei minimum). */
  maxFeeFloorWei: bigint;
}

export function hoodEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.UNZEEN_HOOD?.trim() === "on";
}

/**
 * Reads the Robinhood config (call `loadRepoEnv()` first).
 * - network: HOOD_NETWORK (testnet|mainnet), default testnet.
 * - RPC: HOOD_RPC_URL_MAINNET / HOOD_RPC_URL_TESTNET, else the public endpoint
 *   (rate-limited: the public mainnet RPC sits behind a Cloudflare challenge
 *   after ~10 fast requests). HOOD_SEND_RPC_URL_<NET> optional (read and send
 *   at different providers, same rule as Solana).
 * - keys: HOOD_KEYS_DIR, default `$UNZEEN_HOME/hood-<network>/evm`.
 */
export function loadHoodConfig(env: NodeJS.ProcessEnv = process.env): HoodConfig {
  const network = (env.HOOD_NETWORK?.trim() || "testnet") as HoodNetwork;
  if (network !== "mainnet" && network !== "testnet") throw new Error(`HOOD_NETWORK must be mainnet|testnet, got "${network}"`);
  const varName = network === "mainnet" ? "HOOD_RPC_URL_MAINNET" : "HOOD_RPC_URL_TESTNET";
  const specific = env[varName]?.trim();
  const rpcUrl = specific || HOOD_PUBLIC_RPC[network];
  const sendRpcUrl = env[network === "mainnet" ? "HOOD_SEND_RPC_URL_MAINNET" : "HOOD_SEND_RPC_URL_TESTNET"]?.trim() || rpcUrl;
  const rpsRaw = env.HOOD_RPC_MAX_RPS?.trim();
  // Public endpoints get a conservative default; keyed providers a higher one.
  const maxRps = rpsRaw ? Number(rpsRaw) : specific ? 20 : 4;
  if (!Number.isFinite(maxRps) || maxRps <= 0) throw new Error("HOOD_RPC_MAX_RPS must be > 0");
  const feeRaw = env.HOOD_MAX_FEE_WEI?.trim();
  const maxFeeFloorWei = feeRaw ? BigInt(feeRaw) : 200_000_000n;
  if (maxFeeFloorWei <= 0n) throw new Error("HOOD_MAX_FEE_WEI must be > 0");
  return {
    network,
    chainId: HOOD_CHAIN_ID[network],
    rpcUrl,
    rpcSource: specific ? varName : "public",
    sendRpcUrl,
    maxRps,
    keysDir: hoodKeysDir(network, env),
    allowSend: network === "testnet" || env.UNZEEN_ALLOW_HOOD_MAINNET?.trim() === "yes",
    maxFeeFloorWei,
  };
}

export function hoodKeysDir(network: HoodNetwork, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HOOD_KEYS_DIR?.trim();
  if (explicit) return path.resolve(PKG_ROOT, expandHome(explicit));
  const home = expandHome(env.UNZEEN_HOME?.trim() || path.join(os.homedir(), ".unzeen"));
  return path.resolve(home, `hood-${network}`, "evm");
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function describeHoodConfig(cfg: HoodConfig): string {
  return `hood network=${cfg.network} chainId=${cfg.chainId} rpc=${maskUrl(cfg.rpcUrl)} (from ${cfg.rpcSource}) send=${cfg.allowSend ? "on" : "OFF (read-only)"}`;
}

/** HOOD_* values that carry credentials (for `redactSecrets`). */
export function hoodSecretUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  return ["HOOD_RPC_URL_MAINNET", "HOOD_RPC_URL_TESTNET", "HOOD_SEND_RPC_URL_MAINNET", "HOOD_SEND_RPC_URL_TESTNET"]
    .map((k) => env[k]?.trim() ?? "")
    .filter((v) => v.length > 0);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Token bucket: at most `rps` requests per second, burst `burst`. FIFO. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly rps: number,
    readonly burst = Math.max(1, Math.ceil(rps)),
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!(rps > 0)) throw new RangeError("rps must be > 0");
    this.tokens = this.burst;
    this.last = this.now();
  }

  take(): Promise<void> {
    const run = this.queue.then(async () => {
      for (;;) {
        const t = this.now();
        this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rps);
        this.last = t;
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        await this.sleep(Math.ceil(((1 - this.tokens) / this.rps) * 1000));
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** Wraps a viem transport so every JSON-RPC request first takes a token. */
export function rateLimited(inner: Transport, limiter: RateLimiter): Transport {
  return ((params) => {
    const t = inner(params);
    return {
      ...t,
      request: (async (args: unknown) => {
        await limiter.take();
        return (t.request as (a: unknown) => Promise<unknown>)(args);
      }) as typeof t.request,
    };
  }) as Transport;
}

/** HTTP transport with the limiter, no batching (some providers reject batches), short retries. */
export function hoodTransport(url: string, limiter: RateLimiter): Transport {
  return rateLimited(http(url, { batch: false, retryCount: 2, retryDelay: 300, timeout: 15_000 }), limiter);
}
