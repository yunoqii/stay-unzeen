// Hold denominations of sealed bids (docs/API.md v0.6). The server only ever sees the tier; the exact
// amount is inside the time-locked ciphertext.

const ZAT = BigInt(100_000_000);

const sorted = (tiers: readonly string[]) =>
  tiers
    .filter((t) => /^\d+$/.test(t))
    .map((t) => BigInt(t))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Smallest tier >= amount, or null when the amount is above the largest tier. */
export function holdTierFor(amountZat: bigint, tiers: readonly string[]): bigint | null {
  for (const t of sorted(tiers)) if (t >= amountZat) return t;
  return null;
}

/**
 * Largest hold a creator may use: the smallest tier that covers creatorMaxLamports at the buy rate.
 * null = no cap known (every tier allowed); if no tier covers it, the largest tier.
 */
export function creatorMaxTier(tiers: readonly string[], creatorMaxLamports: string | null | undefined, lamportsPerZecBuy: string | undefined): bigint | null {
  if (!creatorMaxLamports || !/^\d+$/.test(creatorMaxLamports) || !lamportsPerZecBuy || !/^[1-9]\d*$/.test(lamportsPerZecBuy)) return null;
  const rate = BigInt(lamportsPerZecBuy);
  const needZat = (BigInt(creatorMaxLamports) * ZAT + rate - BigInt(1)) / rate;
  const list = sorted(tiers);
  return list.find((t) => t >= needZat) ?? list[list.length - 1] ?? null;
}

export type BidCheck =
  | { ok: true; holdZat: bigint }
  | { ok: false; reason: "empty" | "below_minimum" | "above_max" | "creator_cap" | "insufficient_balance" | "tier_too_small" };

/** Client-side mirror of the server's checks, so the button says why before anything is signed. */
export function checkBid(input: {
  amountZat: bigint | null;
  holdZat: bigint | null;
  tiers: readonly string[];
  minActionZat: string;
  balanceZat: bigint | null;
  creatorCapZat: bigint | null;
}): BidCheck {
  const { amountZat, tiers } = input;
  if (amountZat === null || amountZat <= BigInt(0)) return { ok: false, reason: "empty" };
  if (amountZat < BigInt(input.minActionZat)) return { ok: false, reason: "below_minimum" };
  const auto = holdTierFor(amountZat, tiers);
  if (auto === null) return { ok: false, reason: "above_max" };
  const hold = input.holdZat ?? auto;
  if (hold < amountZat || !sorted(tiers).includes(hold)) return { ok: false, reason: "tier_too_small" };
  if (input.creatorCapZat !== null && hold > input.creatorCapZat) return { ok: false, reason: "creator_cap" };
  if (input.balanceZat !== null && input.balanceZat < hold) return { ok: false, reason: "insufficient_balance" };
  return { ok: true, holdZat: hold };
}
