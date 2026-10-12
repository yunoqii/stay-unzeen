"use client";

import Link from "next/link";
import { forwardRef, memo } from "react";
import { motion } from "motion/react";
import { ArrowUpRight } from "@phosphor-icons/react";
import type { FeedEvent } from "@/lib/api/types";
import { formatCompact, formatSol, lamportsToSol, timeAgo, unitsToNumber } from "@/lib/format";
import { explorerTx, useNetwork } from "@/lib/network";
import { cn } from "@/lib/utils";
import { CountUp } from "@/components/motion/count-up";
import { ScrambleText } from "@/components/motion/scramble-text";
import { VenueTag } from "@/components/tokens/venue-tag";

const VERB: Record<FeedEvent["kind"], string> = {
  buy: "bought",
  sell: "sold",
  create: "launched",
};

interface Props {
  event: FeedEvent;
  now: number | null;
  /** Fresh = arrived over the socket; animate it in. */
  fresh: boolean;
  dense?: boolean;
}

const FeedItemInner = forwardRef<HTMLLIElement, Props>(function FeedItem({ event, now, fresh, dense }, ref) {
  const tokenNum = unitsToNumber(event.tokenAmount, event.decimals);
  const solNum = lamportsToSol(event.solAmount);
  const network = useNetwork();
  const isBuy = event.kind === "buy";
  const isSell = event.kind === "sell";

  return (
    <motion.li
      ref={ref}
      layout="position"
      initial={fresh ? { opacity: 0, filter: "blur(12px)", y: -10 } : false}
      animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
      exit={{ opacity: 0, filter: "blur(8px)", transition: { duration: 0.2 } }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], layout: { type: "spring", bounce: 0, duration: 0.4 } }}
      className="group relative"
    >
      <div
        className={cn(
          "flex items-start gap-3 border-b border-border/60 transition-colors duration-150 hover:bg-feed-row-hover sm:gap-4",
          dense ? "px-3 py-3" : "px-4 py-4 sm:px-5",
        )}
      >
        <Presence kind={event.kind} />

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "leading-snug tracking-tight text-pretty text-muted-foreground",
              dense ? "text-[15px]" : "text-[17px] sm:text-xl",
            )}
          >
            {fresh ? (
              <ScrambleText text="unzeen" className="text-foreground/90" />
            ) : (
              <span className="text-foreground/90">unzeen</span>
            )}{" "}
            {VERB[event.kind]}{" "}
            {event.kind !== "create" && (
              <>
                <Num fresh={fresh} value={tokenNum} format={formatCompact} className="font-medium text-foreground" />{" "}
              </>
            )}
            <Link
              href={`/token/${event.mint}`}
              className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
            >
              ${event.symbol}
            </Link>{" "}
            {event.kind === "create" ? "with" : "for"}{" "}
            <Num
              fresh={fresh}
              value={solNum}
              format={formatSol}
              className={cn("font-medium", isBuy && "text-buy", isSell && "text-sell", event.kind === "create" && "text-zec")}
            />{" "}
            <span className="text-faint-foreground">SOL</span>
          </p>

          <div className="mt-1.5 flex items-center gap-2 text-xs text-faint-foreground">
            <VenueTag venue={event.venue} />
            <span aria-hidden>·</span>
            <a
              href={explorerTx(event.solanaTx, network)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 font-mono transition-colors hover:text-muted-foreground"
              aria-label="View transaction on Solscan"
            >
              {event.solanaTx.slice(0, 6)}
              <ArrowUpRight size={11} weight="light" />
            </a>
          </div>
        </div>

        <time
          dateTime={new Date(event.ts).toISOString()}
          className="tabular shrink-0 pt-1 font-mono text-xs text-faint-foreground"
          suppressHydrationWarning
        >
          {now === null ? "" : timeAgo(event.ts, now)}
        </time>
      </div>
    </motion.li>
  );
});

export const FeedItem = memo(FeedItemInner);

function Num({
  fresh,
  value,
  format,
  className,
}: {
  fresh: boolean;
  value: number;
  format: (n: number) => string;
  className?: string;
}) {
  return fresh ? (
    <CountUp value={value} format={format} className={cn("tabular", className)} />
  ) : (
    <span className={cn("tabular", className)}>{format(value)}</span>
  );
}

/** No avatars, ever: a blurred silhouette tinted by the action. */
function Presence({ kind }: { kind: FeedEvent["kind"] }) {
  return (
    <span aria-hidden className="relative mt-1 grid size-8 shrink-0 place-items-center">
      <span
        className={cn(
          "absolute inset-0 rounded-full blur-[6px]",
          kind === "buy" && "bg-buy/25",
          kind === "sell" && "bg-sell/25",
          kind === "create" && "bg-zec/30",
        )}
      />
      <span className="relative size-4 rounded-full bg-[radial-gradient(circle_at_50%_35%,#3a3a42,#0b0b0d_70%)] ring-1 ring-white/10" />
    </span>
  );
}
