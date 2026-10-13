import type { Quote } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const TITLE: Record<Quote, string> = {
  SOL: "Paired with SOL",
  ZEC: "Paired with ZEC (ZEC SPL, bridged): paid in ZEC, priced in ZEC",
  USDC: "Paired with USDC",
  USD1: "Paired with USD1",
};

/**
 * The curve's pair as a small mono tag: "/ZEC". SOL pairs are the default and get no tag unless
 * `showSol` (filters, pickers). ZEC carries the accent: it is the pair that never touches a SOL rate.
 */
export function QuoteBadge({ quote, showSol = false, className }: { quote: Quote | undefined; showSol?: boolean; className?: string }) {
  const q = quote ?? "SOL";
  if (q === "SOL" && !showSol) return null;
  return (
    <span
      title={TITLE[q]}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-[5px] border px-1.5 font-mono text-[10px] leading-none tracking-wide",
        q === "ZEC" ? "border-zec/45 bg-zec/[0.07] text-zec" : "border-border-strong text-muted-foreground",
        className,
      )}
    >
      <span aria-hidden className="mr-px opacity-60">
        /
      </span>
      {q}
      <span className="sr-only"> pair</span>
    </span>
  );
}
