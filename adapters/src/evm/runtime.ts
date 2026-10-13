import { createPublicClient, type LocalAccount, type PublicClient } from "viem";
import { hoodChain, hoodTransport, RateLimiter, type HoodConfig } from "./chain";
import { EvmExecutor } from "./executor";
import { EvmFeeCache } from "./fees";
import type { EvmKeyring } from "./keys";
import { PonsAdapter, PONS_ERROR_ABI } from "./pons/adapter";
import { PONS_V2_MAINNET, type PonsDeployment } from "./pons/addresses";

export interface HoodClients {
  read: PublicClient;
  send: PublicClient;
}

/** Read and send clients, each behind its own rate limiter. */
export function hoodClients(cfg: HoodConfig): HoodClients {
  const chain = hoodChain(cfg.network);
  const read = createPublicClient({ chain, transport: hoodTransport(cfg.rpcUrl, new RateLimiter(cfg.maxRps)) }) as PublicClient;
  const send =
    cfg.sendRpcUrl === cfg.rpcUrl
      ? read
      : (createPublicClient({ chain, transport: hoodTransport(cfg.sendRpcUrl, new RateLimiter(cfg.maxRps)) }) as PublicClient);
  return { read, send };
}

/** Fee cache reading the latest base fee from `read`. */
export function hoodFeeCache(cfg: HoodConfig, read: PublicClient): EvmFeeCache {
  return new EvmFeeCache(cfg.maxFeeFloorWei, async () => (await read.getBlock({ blockTag: "latest" })).baseFeePerGas ?? 0n);
}

export function hoodExecutor(cfg: HoodConfig, clients: HoodClients = hoodClients(cfg), fees?: EvmFeeCache): EvmExecutor {
  return new EvmExecutor({
    read: clients.read,
    send: clients.send,
    chainId: cfg.chainId,
    fees: fees ?? hoodFeeCache(cfg, clients.read),
    allowSend: cfg.allowSend,
    errorAbi: PONS_ERROR_ABI,
  });
}

/**
 * Pons adapter for a network. Pons exists on mainnet only: on testnet the
 * adapter is returned null (venue unavailable there).
 */
export function hoodPonsAdapter(
  cfg: HoodConfig,
  executor: EvmExecutor,
  keyring: EvmKeyring,
  vault: LocalAccount = keyring.vault(0),
  deployment: PonsDeployment = PONS_V2_MAINNET,
): PonsAdapter | null {
  if (cfg.chainId !== deployment.chainId) return null;
  return new PonsAdapter({ executor, keyring, vault, deployment });
}
