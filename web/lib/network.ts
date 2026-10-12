// Devnet <-> Mainnet (docs/FRONTEND.md, network section). Every network has its own API, explorer links,
// unz1 chain id, and its own anon key + session. Default: devnet.

import { useSyncExternalStore } from "react";

export type Network = "devnet" | "mainnet";
export const NETWORKS: readonly Network[] = ["devnet", "mainnet"];
export const DEFAULT_NETWORK: Network = "devnet";

export interface NetworkConfig {
  id: Network;
  label: string;
  /** REST base, empty = same origin. */
  apiUrl: string;
  /** WS base, empty = derived from apiUrl / page origin. */
  wsUrl: string;
  /** unz1 chain_id: [Zcash 1 main | 2 test, Solana 1 mainnet-beta | 2 devnet]. */
  chainId: readonly [1 | 2, 1 | 2];
  /** Solscan query suffix. */
  explorerQuery: string;
  realFunds: boolean;
}

const strip = (u: string | undefined) => (u ?? "").replace(/\/$/, "");

// NEXT_PUBLIC_* must be referenced literally so Next can inline them.
export const NETWORK_CONFIG: Record<Network, NetworkConfig> = {
  devnet: {
    id: "devnet",
    label: "Devnet",
    apiUrl: strip(process.env.NEXT_PUBLIC_API_URL_DEVNET ?? process.env.NEXT_PUBLIC_API_URL),
    wsUrl: strip(process.env.NEXT_PUBLIC_WS_URL_DEVNET),
    chainId: [2, 2],
    explorerQuery: "?cluster=devnet",
    realFunds: false,
  },
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    apiUrl: strip(process.env.NEXT_PUBLIC_API_URL_MAINNET),
    wsUrl: strip(process.env.NEXT_PUBLIC_WS_URL_MAINNET),
    chainId: [1, 1],
    explorerQuery: "",
    realFunds: true,
  },
};

const STORAGE_KEY = "unzeen.network";

let current: Network | null = null;
const listeners = new Set<() => void>();

function read(): Network {
  if (typeof window === "undefined") return DEFAULT_NETWORK;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "mainnet" || v === "devnet" ? v : DEFAULT_NETWORK;
  } catch {
    return DEFAULT_NETWORK;
  }
}

/** Current network (client). On the server always the default. */
export function getNetwork(): Network {
  if (current === null) current = read();
  return current;
}

export function setNetwork(n: Network) {
  if (n === getNetwork()) return;
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

export function explorerTx(sig: string, n: Network = getNetwork()): string {
  return `https://solscan.io/tx/${sig}${NETWORK_CONFIG[n].explorerQuery}`;
}

export function explorerAccount(addr: string, n: Network = getNetwork()): string {
  return `https://solscan.io/account/${addr}${NETWORK_CONFIG[n].explorerQuery}`;
}
