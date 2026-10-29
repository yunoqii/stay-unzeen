// Devnet <-> Mainnet (docs/FRONTEND.md, network section). Every network has its own API, explorer links,
// unz1 chain id, and its own anon key + session. Default: devnet; mainnet when the build has no devnet.
//
// NEXT_PUBLIC_DEVNET=0 drops Devnet from the build: not listed, not selectable, a stored "devnet" choice
// falls back to Mainnet. Unset = Devnet on (dev server, tests); production builds read web/.env.production.
//
// API v0.18: a network is one origin = one (Zcash net, trading chain) pair. "hood" is Robinhood Chain mainnet
// (EVM 4663, chainId 0111): only in builds with NEXT_PUBLIC_HOOD=1; otherwise it does not exist at all.

import { useSyncExternalStore } from "react";

export type Network = "devnet" | "mainnet" | "hood";
export type Chain = "solana" | "hood";

/** Robinhood Chain is compiled in only with NEXT_PUBLIC_HOOD=1 (default off). */
export const HOOD_BUILD = process.env.NEXT_PUBLIC_HOOD === "1";

/** Devnet is compiled in unless NEXT_PUBLIC_DEVNET=0 (Mainnet-only site). */
export const DEVNET_BUILD = process.env.NEXT_PUBLIC_DEVNET !== "0";

export const NETWORKS: readonly Network[] = [
  ...(DEVNET_BUILD ? (["devnet"] as const) : []),
  "mainnet",
  ...(HOOD_BUILD ? (["hood"] as const) : []),
];
export const DEFAULT_NETWORK: Network = DEVNET_BUILD ? "devnet" : "mainnet";

/** True when `v` is a network this build offers. */
export const isNetwork = (v: unknown): v is Network => typeof v === "string" && (NETWORKS as readonly string[]).includes(v);

export interface NativeCoin {
  symbol: "SOL" | "ETH";
  /** Base units of the *Lamports / solAmount fields: lamports (9) or wei (18). */
  decimals: 9 | 18;
}

export interface NetworkConfig {
  id: Network;
  label: string;
  /** REST base, empty = same origin. */
  apiUrl: string;
  /** WS base, empty = derived from apiUrl / page origin. */
  wsUrl: string;
  /** unz1 / HTTP-signature chain_id, lower-case hex (v0.18: 0202, 0101, 0111; 0212 unused in the UI). */
  chainIdHex: "0202" | "0101" | "0111";
  /** Solscan query suffix. */
  explorerQuery: string;
  realFunds: boolean;
  chain: Chain;
  /** Static default of PoolInfo.chain.native (the server's answer wins, lib/chain.ts). */
  native: NativeCoin;
  /** Zcash side of this origin. */
  zcash: "main" | "test";
  evmChainId?: 4663;
}

const strip = (u: string | undefined) => (u ?? "").replace(/\/$/, "");

// NEXT_PUBLIC_* must be referenced literally so Next can inline them.
export const NETWORK_CONFIG: Record<Network, NetworkConfig> = {
  devnet: {
    id: "devnet",
    label: "Devnet",
    apiUrl: strip(process.env.NEXT_PUBLIC_API_URL_DEVNET ?? process.env.NEXT_PUBLIC_API_URL),
    wsUrl: strip(process.env.NEXT_PUBLIC_WS_URL_DEVNET),
    chainIdHex: "0202",
    explorerQuery: "?cluster=devnet",
    realFunds: false,
    chain: "solana",
    native: { symbol: "SOL", decimals: 9 },
    zcash: "test",
  },
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    apiUrl: strip(process.env.NEXT_PUBLIC_API_URL_MAINNET),
    wsUrl: strip(process.env.NEXT_PUBLIC_WS_URL_MAINNET),
    chainIdHex: "0101",
    explorerQuery: "",
    realFunds: true,
    chain: "solana",
    native: { symbol: "SOL", decimals: 9 },
    zcash: "main",
  },
  // Without the build flag the entry is an inert copy of mainnet (never listed, never selectable): no hood
  // names or URLs in a default build.
  hood:
    process.env.NEXT_PUBLIC_HOOD === "1"
      ? {
          id: "hood",
          label: "Mainnet",
          apiUrl: strip(process.env.NEXT_PUBLIC_API_URL_HOOD),
          wsUrl: strip(process.env.NEXT_PUBLIC_WS_URL_HOOD),
          chainIdHex: "0111",
          explorerQuery: "",
          realFunds: true,
          chain: "hood",
          native: { symbol: "ETH", decimals: 18 },
          zcash: "main",
          evmChainId: 4663,
        }
      : {
          id: "hood",
          label: "Mainnet",
          apiUrl: "",
          wsUrl: "",
          chainIdHex: "0101",
          explorerQuery: "",
          realFunds: true,
          chain: "solana",
          native: { symbol: "SOL", decimals: 9 },
          zcash: "main",
        },
};

export const CHAIN_LABEL: Record<Chain, string> = { solana: "Solana", hood: process.env.NEXT_PUBLIC_HOOD === "1" ? "Robinhood" : "" };

export const chainOf = (n: Network = getNetwork()): Chain => NETWORK_CONFIG[n].chain;

const STORAGE_KEY = "unzeen.network";

let current: Network | null = null;
const listeners = new Set<() => void>();

function read(): Network {
  if (typeof window === "undefined") return DEFAULT_NETWORK;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isNetwork(v) ? v : DEFAULT_NETWORK;
  } catch {
    return DEFAULT_NETWORK;
  }
}

/** Current network (client). On the server always the default. */
export function getNetwork(): Network {
  if (current === null) current = read();
  return current;
}

let lastSolana: Network | null = null;
/** The Solana network to go back to from Robinhood Chain (last one used in this tab, else the default). */
export function lastSolanaNetwork(): Network {
  const cur = getNetwork();
  return NETWORK_CONFIG[cur].chain === "solana" ? cur : (lastSolana ?? DEFAULT_NETWORK);
}

export function setNetwork(n: Network) {
  if (!isNetwork(n)) n = DEFAULT_NETWORK;
  const prev = getNetwork();
  if (n === prev) return;
  if (NETWORK_CONFIG[prev].chain === "solana") lastSolana = prev;
  current = n;
  try {
    window.localStorage.setItem(STORAGE_KEY, n);
  } catch {
    /* private mode: keep in memory */
  }
  listeners.forEach((l) => l());
}

export function subscribeNetwork(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      current = read();
      l();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export function useNetwork(): Network {
  return useSyncExternalStore(subscribeNetwork, getNetwork, () => DEFAULT_NETWORK);
}

export function networkConfig(n: Network = getNetwork()): NetworkConfig {
  return NETWORK_CONFIG[n];
}

/** Robinhood Chain mainnet (4663) explorer. */
const HOOD_EXPLORER = process.env.NEXT_PUBLIC_HOOD === "1" ? "https://robinhoodchain.blockscout.com" : "";

export function explorerTx(sig: string, n: Network = getNetwork()): string {
  if (NETWORK_CONFIG[n].chain === "hood") return `${HOOD_EXPLORER}/tx/${sig}`;
  return `https://solscan.io/tx/${sig}${NETWORK_CONFIG[n].explorerQuery}`;
}

export function explorerAccount(addr: string, n: Network = getNetwork()): string {
  if (NETWORK_CONFIG[n].chain === "hood") return `${HOOD_EXPLORER}/address/${addr}`;
  return `https://solscan.io/account/${addr}${NETWORK_CONFIG[n].explorerQuery}`;
}

/** Name of the explorer for link labels. */
export const explorerName = (n: Network = getNetwork()) => (NETWORK_CONFIG[n].chain === "hood" ? "Blockscout" : "Solscan");

// ---- native coin of an origin: static default, then PoolInfo.chain (v0.18) once a pool answer came in ----

const nativeFromPool: Partial<Record<Network, NativeCoin>> = {};
const nativeListeners = new Set<() => void>();

/** Called with every PoolInfo: the server's chain wins over the static default. */
export function rememberChain(n: Network, chain: { native?: { symbol: "SOL" | "ETH"; decimals: 9 | 18 } } | undefined) {
  if (!chain?.native) return;
  const cur = nativeFromPool[n];
  if (cur && cur.symbol === chain.native.symbol && cur.decimals === chain.native.decimals) return;
  nativeFromPool[n] = { symbol: chain.native.symbol, decimals: chain.native.decimals };
  nativeListeners.forEach((l) => l());
}

export function nativeOf(n: Network = getNetwork()): NativeCoin {
  return nativeFromPool[n] ?? NETWORK_CONFIG[n].native;
}

export function subscribeNative(l: () => void): () => void {
  nativeListeners.add(l);
  const un = subscribeNetwork(l);
  return () => {
    nativeListeners.delete(l);
    un();
  };
}
