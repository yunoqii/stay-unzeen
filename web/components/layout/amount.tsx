"use client";

import { formatUsd } from "@/lib/display";
import { useDisplay } from "@/lib/display-store";
import { formatSol } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePeek } from "@/components/portfolio/peek";

/**
 * A SOL-priced figure (price, market cap, volume, trade size of a SOL pair) in the display unit:
 * "≈ 0.22 ZEC" by default, "0.4 SOL" with the native pick. Pair amounts (ZEC, USDC) never come through here.
 */
export function SolAmount({
  sol,
  format = formatSol,
  className,
  unitClassName = "text-faint-foreground",
  hideUnit,
}: {
  sol: number;
  format?: (n: number) => string;
  className?: string;
  unitClassName?: string;
  hideUnit?: boolean;
}) {
  const d = useDisplay();
  const v = d.sol(sol);
  return (
    <>
      {d.converted && <span className="text-faint-foreground">≈&nbsp;</span>}
      <span className={cn("tabular", className)}>{v === null ? "—" : format(v)}</span>
      {!hideUnit && (
        <>
          {" "}
          <span className={unitClassName}>{d.unit}</span>
        </>
      )}
    </>
  );
}

/**
 * "≈ $X" next to a ZEC amount of your own (balance, position). Only while Peek is open: under the veil there
 * is nothing at all, not even a placeholder, so the hint cannot hint at the size.
 */
export function UsdHint({ zec, sol, className }: { zec?: number | null; sol?: number | null; className?: string }) {
  const { shown } = usePeek();
  const d = useDisplay();
  if (!shown) return null;
  const usd = typeof zec === "number" ? d.usd(zec) : typeof sol === "number" ? d.usdOfSol(sol) : null;
  // Nothing to say about an empty balance.
  if (usd === null || !(Math.abs(usd) > 0)) return null;
  return <span className={cn("tabular text-xs text-faint-foreground", className)}>≈ {formatUsd(usd)}</span>;
}
