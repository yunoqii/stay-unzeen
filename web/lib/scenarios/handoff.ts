// Opening the builder for a token ("Automate" on a token page, a holding in the portfolio) hands the mint
// over in memory, never in the URL: /scenarios?mint=… would tell the web server which token this browser
// wants to automate. Client-side navigation keeps this module alive; a reload simply forgets it.

let seed: { mint: string; at: number } | null = null;
const TTL_MS = 60_000;

export function handOffMint(mint: string) {
  seed = { mint, at: Date.now() };
}

/** The handed-over mint (still there until cleared; safe to read twice in a strict-mode render). */
export function peekHandOff(): string | null {
  return seed && Date.now() - seed.at < TTL_MS ? seed.mint : null;
}

export function clearHandOff() {
  seed = null;
}
