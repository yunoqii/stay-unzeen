// One-tap buy from a card (Pulse, watchlist): the same quote and the same checks as the trade panel, so a card
// can never sign what the panel would refuse. SOL pairs only (cards show SOL-paired curve tokens and graduated
// ones; other pairs open the token page instead).

import type { PoolInfo, SignedAction, SolRateUsed, TokenListItem } from "@/lib/api/types";
import { formatZec, parseUnits, ZEC_DECIMALS } from "@/lib/format";
import { curveFor, quoteBuy, quoteRate, type BuyQuote } from "@/lib/trade";
import { tokenQuote } from "@/lib/quotes";

export type QuickBuy = { ok: true; action: Extract<SignedAction, { op: "buy" }>; quote: BuyQuote; zecIn: bigint } | { ok: false; reason: string };

export function buildQuickBuy(args: {
  token: Pick<TokenListItem, "mint" | "venue" | "status" | "decimals" | "priceSol" | "quote" | "curve">;
  preset: string;
  pool: PoolInfo | null;
  last: SolRateUsed | null;
  slippageBps: number;
  balanceZat: bigint | null;
}): QuickBuy {
  const { token, preset, pool, last, slippageBps, balanceZat } = args;
  if (!pool) return { ok: false, reason: "Loading the pool…" };
  if (tokenQuote(token as TokenListItem) !== "SOL") return { ok: false, reason: "Open the token to trade this pair." };
  let zecIn: bigint;
  try {
    zecIn = BigInt(parseUnits(preset, ZEC_DECIMALS));
  } catch {
    return { ok: false, reason: "Bad preset." };
  }
  const min = BigInt(pool.minActionZat);
  if (zecIn < min) return { ok: false, reason: `The pool minimum is ${formatZec(min.toString())} ZEC.` };
  if (balanceZat !== null && zecIn > balanceZat) return { ok: false, reason: "More than your ZEC balance." };
  const graduated = token.status === "graduated";
  const venue = graduated && token.venue !== "jupiter" ? "jupiter" : token.venue;
  const curve = !graduated && venue === token.venue ? curveFor(token, pool, venue) : null;
  const quote = quoteBuy(zecIn, quoteRate(last, pool, "buy"), token.priceSol, token.decimals, slippageBps, curve);
  // Never sign without a price limit (v0.25: minOut 0 -> 400).
  if (!quote || quote.minOut <= BigInt(0)) return { ok: false, reason: "No price to set a limit against yet." };
  return { ok: true, zecIn, quote, action: { op: "buy", venue, mint: token.mint, zecIn: zecIn.toString(), minOut: quote.minOut.toString() } };
}
