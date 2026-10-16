"use client";

import { formatRate } from "@/lib/display";
import { useRates } from "@/lib/display-store";
import { timeAgo } from "@/lib/format";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { useNative } from "@/lib/chain";
import { DisplaySwitch } from "./display-switch";
import { CoinIcon } from "@/components/icons/coin";

/**
 * Public reference prices (ZEC, SOL, ETH in USD and ZEC/SOL), refreshed in the background every minute.
 * Display only: a trade always runs at the pool's own quote.
 */
export function RatesStrip() {
  const { rates, loading } = useRates();
  const now = useNow(10_000);
  const usd = rates?.source === "rates" || rates?.source === "offline" ? rates : null;
  const offline = rates?.source === "offline";
  const eth = useNative().symbol === "ETH";

  return (
    <div className="border-b border-border/60">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
        <dl
          aria-label="Reference prices"
          aria-busy={loading}
          className="-mx-1 flex w-full min-w-0 items-center gap-x-4 overflow-x-auto px-1 font-mono text-[11px] whitespace-nowrap text-faint-foreground [mask-image:linear-gradient(to_right,black_88%,transparent)] [scrollbar-width:none] sm:w-auto sm:flex-1 sm:gap-x-5 sm:[mask-image:none]"
        >
          <Rate label="ZEC" value={usd ? `$${formatRate(usd.zecUsd)}` : null} accent loading={loading} />
          {eth ? (
            <>
              <Rate label="ETH" value={usd ? `$${formatRate(usd.ethUsd, 0)}` : null} loading={loading} />
              <Rate label="SOL" value={usd ? `$${formatRate(usd.solUsd)}` : null} loading={loading} />
              <Rate label="ZEC/ETH" value={rates?.zecEth ? formatRate(rates.zecEth, 6) : null} loading={loading} />
            </>
          ) : (
            <>
              <Rate label="SOL" value={usd ? `$${formatRate(usd.solUsd)}` : null} loading={loading} />
              <Rate label="ETH" value={usd ? `$${formatRate(usd.ethUsd, 0)}` : null} loading={loading} />
              <Rate label="ZEC/SOL" value={rates?.zecSol ? formatRate(rates.zecSol, 4) : null} loading={loading} />
            </>
          )}
          {offline ? (
            <span className="text-faint-foreground/80" title="Our rates API is out of reach from this demo, so these are fixed reference values. Trades use the pool's own quote.">
              offline rates
            </span>
          ) : rates && rates.ts > 0 && now !== null && (
            <span className="text-faint-foreground/80" title="Public reference rate, refreshed every minute. Trades use the pool's own quote.">
              ≈ {timeAgo(rates.ts, now)} ago
            </span>
          )}
        </dl>
        <div className="flex items-center gap-2 text-[11px] text-faint-foreground">
          <span>Prices in</span>
          <DisplaySwitch size="xs" />
        </div>
      </div>
    </div>
  );
}

function Rate({ label, value, accent, loading }: { label: string; value: string | null; accent?: boolean; loading: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <dt className={cn("inline-flex items-center gap-1", accent && "text-zec/80")}>
        <CoinIcon symbol={label} size={12} />
        {label}
      </dt>
      <dd className={cn("tabular", value ? "text-muted-foreground" : "text-faint-foreground/60")}>{value ?? (loading ? "···" : "—")}</dd>
    </div>
  );
}
