// Creator fee claims (docs/API.md v0.7, v0.11, v0.14). Fees of SOL / USDC / USD1 pairs are owed in
// lamports, fees of ZEC pairs in zatoshis (credited 1:1, no SOL rate). `claim` credits
// floor(lamports × 1e8 / lamportsPerZecSell) + zat, and the pool minimum (minClaimZat) applies to that sum.

import type { PoolInfo } from "@/lib/api/types";
import { lamportsToZat } from "@/lib/trade";

const N0 = BigInt(0);
const uint = (v: string | undefined | null): bigint => (v && /^\d+$/.test(v) ? BigInt(v) : N0);

export interface ClaimAmount {
  lamports: bigint;
  zat: bigint;
  /** ZEC the claim credits (lamports at the sell rate + zat); null when lamports are owed and no rate is known. */
  totalZat: bigint | null;
}

export function claimAmount(lamports: string | bigint | undefined, zat: string | bigint | undefined, sellRate: bigint | null): ClaimAmount {
  const l = typeof lamports === "bigint" ? lamports : uint(lamports);
  const z = typeof zat === "bigint" ? zat : uint(zat);
  const fromLamports = l === N0 ? N0 : sellRate && sellRate > N0 ? lamportsToZat(l, sellRate) : null;
  return { lamports: l, zat: z, totalZat: fromLamports === null ? null : fromLamports + z };
}

/** Claim threshold: PoolInfo.minClaimZat (v0.11), else minActionZat; null before /api/pool loads. */
export function minClaimZat(pool: Pick<PoolInfo, "minClaimZat" | "minActionZat"> | null | undefined): bigint | null {
  if (!pool) return null;
  const v = pool.minClaimZat ?? pool.minActionZat;
  return /^\d+$/.test(v) ? BigInt(v) : null;
}

/**
 * The Claim button is on when something is owed and its ZEC sum reaches the minimum. Without a rate the
 * lamport part can't be valued: then allow it if the zat part alone reaches the minimum, or leave the
 * decision to the server (it answers below_minimum).
 */
export function canClaim(a: ClaimAmount, min: bigint | null): boolean {
  if (a.lamports === N0 && a.zat === N0) return false;
  if (min === null) return true;
  if (a.totalZat !== null) return a.totalZat > N0 && a.totalZat >= min;
  return a.zat >= min || a.lamports > N0;
}
