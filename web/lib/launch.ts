// Launch form rules (docs/API.md "Правила исполнения действий", create): checked here so the button
// says what is wrong before anything is signed; core checks the same and answers 400/422 anyway.

import type { PoolInfo } from "@/lib/api/types";
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
 */
export function checkInitialBuy(value: string, pool: Pick<PoolInfo, "launchRules" | "rate" | "minActionZat"> | null, venue?: string): InitialBuy {
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
  const max = maxInitialBuyZat(pool, venue);
  if (max === null) return { ok: false, error: "The pool has not published its first-buy limit yet. Launch without a first buy, or try again shortly." };
  if (zat > max) return { ok: false, error: `Up to ${formatZec(max.toString())} ZEC: the creator can hold at most the capped share of supply.` };
  return { ok: true, zat };
}
