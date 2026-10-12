// On-demand features. Runtime switch = what the server says (PoolInfo.features); build switch =
// whether the code is in the bundle at all.

import type { PoolInfo } from "@/lib/api/types";

/**
 * NEXT_PUBLIC_FAIR_LAUNCH_BUILD=0 strips the sealed-bid launch code from the build entirely (no lazy
 * chunk to find in /_next/static). Default: compiled in as a lazy chunk, loaded only when the server
 * reports the feature on.
 */
export const SEALED_BUILD = process.env.NEXT_PUBLIC_FAIR_LAUNCH_BUILD !== "0";

/** The server reports the sealed-bid launch on, and this build carries it. */
export const sealedOn = (pool: PoolInfo | null | undefined): boolean => SEALED_BUILD && pool?.features?.fairLaunch === true;
