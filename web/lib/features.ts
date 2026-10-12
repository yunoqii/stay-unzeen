// Feature flags that follow backend capabilities. Build-time env only (NEXT_PUBLIC_*), no remote config:
// fetching flags from a third party would leak the visitor's IP.

/**
 * Full on-chain trade feed per mint (not only unzeen trades) and Helius-backed metrics (dev history,
 * first blocks). Switched on after the Helius Developer upgrade (~day 9). Until then the Whales / Dev
 * filters are disabled and those safety rows read "Not available yet".
 */
export const FULL_TRADES = process.env.NEXT_PUBLIC_FEATURE_FULL_TRADES === "1";
