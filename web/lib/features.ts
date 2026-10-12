// On-demand features. Runtime switch = what the server says (PoolInfo.features); build switch =
// whether the code is in the bundle at all.

import type { PoolInfo } from "@/lib/api/types";

/**
 * The sealed-bid launch is compiled in only with NEXT_PUBLIC_FAIR_LAUNCH_BUILD=1 (then as a lazy chunk,
 * loaded only when the server reports the feature on). Default: not in the build at all, no chunk to
 * find in /_next/static (review F4: a public deploy must not depend on someone remembering "=0").
 */
export const SEALED_BUILD = process.env.NEXT_PUBLIC_FAIR_LAUNCH_BUILD === "1";

/** The server reports the sealed-bid launch on, and this build carries it. */
export const sealedOn = (pool: PoolInfo | null | undefined): boolean => SEALED_BUILD && pool?.features?.fairLaunch === true;
