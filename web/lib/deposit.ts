// Top up without telling the server: the browser builds and signs the unz1 deposit memo and the
// ZIP-321 URI from public GET /api/pool. The server learns about the deposit only when the note
// lands on chain (docs/API.md, Top up section).

import type { PoolInfo } from "@/lib/api/types";
import type { ChainId, Unz1Fields } from "@/lib/crypto/unz1";
import { randomNonce } from "@/lib/crypto/unz1";
import { NETWORK_CONFIG, type Network } from "@/lib/network";
import { buildZip321 } from "@/lib/zip321";

/** Recommended by docs/API.md: no refund receiver, expiry now + 24 h (unix seconds). */
export const DEPOSIT_TTL_SEC = 24 * 60 * 60;

export class PoolMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolMismatchError";
  }
}

/**
 * chain_id from the pool, checked against the selected network. v0.3 allows only "0202"
 * (Zcash testnet + Solana devnet) and "0101" (mainnet + mainnet-beta). Anything else, or a pool
 * whose `network` / address disagrees, is refused: a memo signed for the wrong chain is frozen.
 */
export function poolChainId(pool: PoolInfo, network: Network): ChainId {
  const cfg = NETWORK_CONFIG[network];
  if (pool.chainId.toLowerCase() !== cfg.chainIdHex)
    throw new PoolMismatchError(`pool chainId "${pool.chainId}" is not ${cfg.label} (${cfg.chainIdHex})`);
  if (pool.network !== (cfg.realFunds ? "main" : "test"))
    throw new PoolMismatchError(`pool network "${pool.network}" does not match ${cfg.label}`);
  const prefix = pool.network === "main" ? /^u1/ : /^utest1/;
  if (!prefix.test(pool.address)) throw new PoolMismatchError("pool address is not a Unified Address for its network");
  return [parseInt(cfg.chainIdHex.slice(0, 2), 16), parseInt(cfg.chainIdHex.slice(2), 16)] as unknown as ChainId;
}

export function depositFields(nowSec: number = Math.floor(Date.now() / 1000), nonce: bigint = randomNonce()): Unz1Fields {
  return {
    op: "deposit",
    venue: "none",
    minOut: BigInt(0),
    nonce,
    expiry: nowSec + DEPOSIT_TTL_SEC,
    target: { kind: "none" },
  };
}

export function depositUri(pool: PoolInfo, amountZat: string, memo: string): string {
  return buildZip321({ address: pool.address, amountZat, memo });
}
