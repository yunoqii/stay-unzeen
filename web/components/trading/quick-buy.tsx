"use client";

import { useState } from "react";
import { Lightning } from "@phosphor-icons/react";
import { toast } from "sonner";
import type { TokenListItem } from "@/lib/api/types";

export type QuickBuyToken = Pick<TokenListItem, "mint" | "symbol" | "venue" | "status" | "decimals" | "priceSol" | "quote" | "curve">;
import { ApiError, errorText } from "@/lib/api/client";
import { lastRate, submitAction } from "@/lib/activity";
import { useKeyState } from "@/lib/crypto/session";
import { useDefaultExec, withExec } from "@/lib/exec";
import { formatCompact, unitsToNumber } from "@/lib/format";
import { useNetwork } from "@/lib/network";
import { buildQuickBuy } from "@/lib/quick-buy";
import { useTradeSettings } from "@/lib/trade-settings";
import { cn } from "@/lib/utils";
import { usePool } from "@/hooks/use-pool";
import { usePortfolio } from "@/hooks/use-portfolio";

/**
 * "Buy 0.1" on a card, with your first preset and your default execution. Instant trade off (default): the
 * first tap shows what it would sign, the second signs. Instant trade on: the first tap signs.
 */
export function QuickBuy({ token, className }: { token: QuickBuyToken; className?: string }) {
  const network = useNetwork();
  const key = useKeyState();
  const { pool } = usePool();
  const { portfolio } = usePortfolio();
  const settings = useTradeSettings(network);
  const exec = useDefaultExec(network);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (key.status !== "unlocked") return null;
  const preset = settings.buyPresets[0];
  const plan = buildQuickBuy({
    token,
    preset,
    pool,
    last: lastRate(network, "buy"),
    slippageBps: settings.slippageBps,
    balanceZat: portfolio ? BigInt(portfolio.zecBalance) : null,
  });

  const sign = async () => {
    if (!plan.ok || busy) return;
    setBusy(true);
    try {
      await submitAction(network, withExec(plan.action, exec), { op: "buy", mint: token.mint, symbol: token.symbol, decimals: token.decimals, amount: plan.zecIn.toString() });
      toast(`Buy $${token.symbol} signed`, { description: `${preset} ZEC · ${exec === "now" ? "now" : exec === "max" ? "max privacy batch" : "next batch"}. On-chain it reads “unzeen”.` });
    } catch (e) {
      toast.error(`Buy $${token.symbol}`, { description: errorText(e instanceof ApiError ? e : new ApiError("internal", String(e))) });
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  const click = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!plan.ok) return;
    if (settings.oneTap || armed) void sign();
    else setArmed(true);
  };

  return (
    <button
      type="button"
      onClick={click}
      onBlur={() => setArmed(false)}
      disabled={!plan.ok || busy}
      title={plan.ok ? undefined : plan.reason}
      aria-label={armed ? `Confirm: buy $${token.symbol} for ${preset} ZEC` : `Buy $${token.symbol} for ${preset} ZEC`}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        armed ? "border-zec bg-zec text-background" : "border-border hover:border-zec/60 hover:text-zec",
        className,
      )}
    >
      <Lightning size={12} weight={armed ? "fill" : "regular"} aria-hidden />
      {busy ? "Signing…" : armed && plan.ok ? `Confirm ≈ ${formatCompact(unitsToNumber(plan.quote.tokensOut.toString(), token.decimals))}` : `Buy ${preset}`}
    </button>
  );
}
