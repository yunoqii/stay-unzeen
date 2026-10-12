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
 * chain_id from the pool, checked against what the user selected. A pool that answers with the
 * wrong cluster or a Zcash byte that disagrees with its own `network` is refused: signing for the
 * wrong chain would freeze the deposit.
 */
export function poolChainId(pool: PoolInfo, network: Network): ChainId {
  if (!/^[0-9a-f]{4}$/i.test(pool.chainId)) throw new PoolMismatchError(`bad chainId "${pool.chainId}"`);
  const z = parseInt(pool.chainId.slice(0, 2), 16);
  const s = parseInt(pool.chainId.slice(2, 4), 16);
  const expectZ = pool.network === "main" ? 1 : 2;
  if (z !== expectZ) throw new PoolMismatchError(`chainId Zcash byte ${z} does not match pool network "${pool.network}"`);
  if (s !== NETWORK_CONFIG[network].solanaCluster)
    throw new PoolMismatchError(`chainId Solana byte ${s} does not match ${NETWORK_CONFIG[network].label}`);
  const prefix = pool.network === "main" ? /^u1/ : /^utest1/;
  if (!prefix.test(pool.address)) throw new PoolMismatchError("pool address is not a Unified Address for its network");
  return [z, s] as unknown as ChainId;
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
