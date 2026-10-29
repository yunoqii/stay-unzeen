// What the current origin trades on (API v0.18 PoolInfo.chain): native coin and its decimals, address format,
// explorer. Static defaults come from lib/network.ts; the pool's own PoolInfo.chain overrides them once loaded.

import { useSyncExternalStore } from "react";
import { DEFAULT_NETWORK, getNetwork, nativeOf, NETWORK_CONFIG, subscribeNative, useNetwork, type NativeCoin, type Network } from "@/lib/network";
import { isSolanaAddress } from "@/lib/trade";
import { isEvmAddress } from "@/lib/evm";

export { nativeOf, rememberChain } from "@/lib/network";

export const nativeDecimals = (n: Network = getNetwork()) => nativeOf(n).decimals;
export const nativeSymbol = (n: Network = getNetwork()) => nativeOf(n).symbol;

/** Native coin of the selected network, reactive to the network switch and to PoolInfo.chain. */
export function useNative(): NativeCoin {
  useNetwork();
  return useSyncExternalStore(subscribeNative, () => nativeOf(), () => NETWORK_CONFIG[DEFAULT_NETWORK].native);
}

/** A token mint / account address of this origin: base58 (Solana) or 0x (Robinhood Chain). */
export function isChainAddress(s: string, n: Network = getNetwork()): boolean {
  return NETWORK_CONFIG[n].chain === "hood" ? isEvmAddress(s) : isSolanaAddress(s);
}

export const addressKind = (n: Network = getNetwork()) => (NETWORK_CONFIG[n].chain === "hood" ? "0x" : "Solana");
