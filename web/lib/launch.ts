// Launch form rules (docs/API.md "Правила исполнения действий", create): checked here so the button
// says what is wrong before anything is signed; core checks the same and answers 400/422 anyway.

import type { PoolInfo, Quote } from "@/lib/api/types";
import { formatZec, parseUnits, ZEC_DECIMALS } from "@/lib/format";
import { maxInitialBuyZat } from "@/lib/launch-rules";

export const NAME_MAX = 32;
export const SYMBOL_MAX = 10;
/** The whole data URL, as it goes into the body (docs/API.md: up to 512 KiB). */
export const IMAGE_MAX_BYTES = 512 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

const IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export interface MetaInput {
  name: string;
  symbol: string;
  image: string | null;
}

export type MetaErrors = Partial<Record<keyof MetaInput, string>>;

export function validateMeta(m: MetaInput): MetaErrors {
  const e: MetaErrors = {};
  const name = m.name.trim();
  if (!name) e.name = "Give it a name.";
  else if ([...name].length > NAME_MAX) e.name = `At most ${NAME_MAX} characters.`;
  if (!m.symbol) e.symbol = "Pick a ticker.";
  else if (!/^[A-Za-z0-9]+$/.test(m.symbol)) e.symbol = "Letters and digits only.";
  else if (m.symbol.length > SYMBOL_MAX) e.symbol = `At most ${SYMBOL_MAX} characters.`;
  if (m.image !== null) {
    if (m.image.length > IMAGE_MAX_BYTES) e.image = "Image is over 512 KB. Use a smaller PNG, JPEG or WebP.";
    else if (!IMAGE_RE.test(m.image)) e.image = "Use a PNG, JPEG or WebP image.";
  }
  return e;
}

/** Ticker as typed: upper case, letters and digits only, capped. */
export const normalizeSymbol = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, SYMBOL_MAX);

export type InitialBuy =
  | { ok: true; zat: bigint | null }
  | { ok: false; error: string };

/**
 * Optional first buy of `create`, in ZEC. Empty = no first buy. Capped at maxInitialBuyZat (launchRules
 * at the pool's buy rate); at least minActionZat when set.
 *
 * v0.13: SOL, USDC and USD1 pairs use the venue's lamport cap (the ledger keeps them in lamports). A ZEC pair
 * is capped on its own ZEC curve, which the pool does not publish: no client-side cap, the server answers
 * 422 creator_cap above it.
 */
export function checkInitialBuy(value: string, pool: Pick<PoolInfo, "launchRules" | "rate" | "minActionZat" | "quotes"> | null, venue?: string, quote: Quote = "SOL"): InitialBuy {
  const v = value.trim();
  if (!v) return { ok: true, zat: null };
  let zat: bigint;
  try {
    zat = BigInt(parseUnits(v, ZEC_DECIMALS));
  } catch {
    return { ok: false, error: "Enter an amount in ZEC, up to 8 decimals." };
  }
  if (zat === BigInt(0)) return { ok: true, zat: null };
  if (pool && zat < BigInt(pool.minActionZat)) return { ok: false, error: `At least ${formatZec(pool.minActionZat)} ZEC, or leave it empty.` };
  if (quote === "ZEC") {
    // v0.17: the pool publishes the ZEC-pair cap per venue (ZEC SPL units = zatoshis). Not published: the server checks it.
    const capZec = maxInitialBuyZat(pool, venue, "ZEC");
    if (capZec !== null && zat > capZec) return { ok: false, error: `Up to ${formatZec(capZec.toString())} ZEC on the ZEC curve: the creator can hold at most the capped share of supply.` };
    return { ok: true, zat };
  }
  const max = maxInitialBuyZat(pool, venue);
  if (max === null) return { ok: false, error: "The pool has not published its first-buy limit yet. Launch without a first buy, or try again shortly." };
  if (zat > max) return { ok: false, error: `Up to ${formatZec(max.toString())} ZEC: the creator can hold at most the capped share of supply.` };
  return { ok: true, zat };
}

/**
 * v0.17 (A4): a Bags launch answers 503 venue_unavailable until the relayer has recorded the Bags curve
 * (no first buy without price protection). Say so, instead of a generic "venue unavailable".
 */
export const BAGS_NO_CURVE_TEXT =
  "Bags isn't ready for launches yet: the pool is still loading its Bags curve, and won't place a first buy without price protection. Nothing was charged. Try again in a few minutes, or pick another venue.";

export function isBagsNotReady(err: { code: string; status?: number }, venue: string): boolean {
  return venue === "bags" && err.code === "venue_unavailable";
}
