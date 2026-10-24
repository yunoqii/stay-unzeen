// Marks of the launch pairs that have no coin component yet: USDC and USD1. Inline SVG (no request to
// any host), monochrome currentColor like the SOL and ETH marks (our only accent is yellow).
//
// USDC: Circle's USDC mark (Circle brand assets, usdc.svg, 2000x2000): the disc with the dollar sign and the
// two side arcs. The blue fill is dropped; disc, "$" and arcs are merged into one even-odd path so the sign
// and arcs are cut-outs.
// USD1: World Liberty Financial brand assets (https://docs.worldlibertyfinancial.com/resources/brand-assets,
// usd1.svg, 500x500): the outer ring and the "1" are the official outlines; the gold gradients and the
// wing pattern (lost at 12-16 px) are dropped, the "1" is cut out of the inner disc.
import type { Quote } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { coinFrame, type CoinProps } from "./coin-base";
import { CoinEth } from "./coin-eth";
import { CoinSol } from "./coin-sol";
import { CoinZec } from "./coin-zec";

const USDC_DISC = "M1000 0a1000 1000 0 1 1 0 2000a1000 1000 0 0 1 0-2000Z";
const USDC_SIGN =
  "M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z";
const USDC_ARCS =
  "M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5zM1229.17 295.83c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67z";

export function CoinUsdc({ className, ...props }: CoinProps) {
  return (
    <svg {...coinFrame({ ...props, className: cn("text-muted-foreground", className) }, "0 0 2000 2000")}>
      <path fill="currentColor" fillRule="evenodd" d={`${USDC_DISC}${USDC_SIGN}${USDC_ARCS}`} />
    </svg>
  );
}

const USD1_RING =
  "M250 475C374.264 475 475 374.264 475 250C475 125.736 374.264 25 250 25C125.736 25 25 125.736 25 250C25 374.264 125.736 475 250 475ZM250 500C388.071 500 500 388.071 500 250C500 111.929 388.071 0 250 0C111.929 0 0 111.929 0 250C0 388.071 111.929 500 250 500Z";
const USD1_DISC = "M250 41a209 209 0 1 1 0 418a209 209 0 0 1 0-418Z";
// The official "1" (front face): stem and flag.
const USD1_ONE =
  "M266 105V386H232.8V149.98C231.48 151.06 230.14 152.12 228.8 153.17C219.2 160.67 209.47 166.69 199.6 171.24C190.32 175.26 181.03 177.28 171.75 177.28C171.25 177.28 170.75 177.28 170.25 177.26C170.17 177.27 170.08 177.26 170 177.26V146.35C170.35 146.38 170.71 146.38 171.07 146.38C176.44 146.38 182.76 144.49 190 140.73C197.74 136.72 205.74 131.5 214 125.07C222.27 118.65 229.47 111.96 235.6 105H266Z";

export function CoinUsd1({ className, ...props }: CoinProps) {
  return (
    <svg {...coinFrame({ ...props, className: cn("text-muted-foreground", className) }, "0 0 500 500")}>
      <path fill="currentColor" fillRule="evenodd" d={USD1_RING} />
      <path fill="currentColor" fillRule="evenodd" d={`${USD1_DISC}${USD1_ONE}`} />
    </svg>
  );
}

/** The mark of a launch pair's quote ("SOL" stands for the chain's native coin: ETH on Robinhood Chain). */
export function QuoteCoin({ quote, native = "SOL", ...props }: CoinProps & { quote: Quote; native?: string }) {
  if (quote === "ZEC") return <CoinZec {...props} />;
  if (quote === "USDC") return <CoinUsdc {...props} />;
  if (quote === "USD1") return <CoinUsd1 {...props} />;
  return native === "ETH" ? <CoinEth {...props} /> : <CoinSol {...props} />;
}
