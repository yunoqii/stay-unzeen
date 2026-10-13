"use client";

import Link from "next/link";
import { ArrowDown, WarningCircle } from "@phosphor-icons/react";
import { ApiError, errorText } from "@/lib/api/client";
import { formatZec } from "@/lib/format";
import type { Quote } from "@/lib/api/types";
import { cn } from "@/lib/utils";

export function ErrorNote({ error, minAction, pair }: { error: ApiError; minAction: bigint | null; pair?: Quote }) {
  let text = errorText(error);
  // v0.13: on a non-SOL pair the pool settles in that asset; a shortfall there is the pool's, never your balance's.
  if (error.code === "pool_liquidity" && pair && pair !== "SOL")
    text = `The pool can't fill ${pair}-paired trades right now. Nothing left your balance. Try again in a few minutes, or a smaller amount.`;
  if (error.code === "below_minimum" && minAction !== null) text = `Below the pool minimum of ${formatZec(minAction.toString())} ZEC worth. Try a larger amount.`;
  if (error.code === "slippage") text = "The price moved past your limit. Raise max slippage or try a smaller amount.";
  return (
    <div role="alert" className="flex gap-2 rounded-xl border border-sell/30 bg-sell/5 px-3 py-2.5 text-sm text-pretty">
      <WarningCircle size={16} weight="light" className="mt-0.5 shrink-0 text-sell" aria-hidden />
      <div>
        <p className="text-foreground/90">{text}</p>
        {error.code === "insufficient_balance" && (
          <Link href="/pay" className="mt-1 inline-flex items-center gap-1 text-xs text-zec underline-offset-4 hover:underline">
            <ArrowDown size={12} weight="bold" aria-hidden />
            Top up
          </Link>
        )}
      </div>
    </div>
  );
}

export function Chip({
  active,
  className,
  ...props
}: React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "tabular inline-flex h-9 items-center rounded-full border px-3 text-xs sm:h-8 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40",
        active ? "border-zec/50 bg-zec/10 text-foreground" : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
        className,
      )}
    />
  );
}
