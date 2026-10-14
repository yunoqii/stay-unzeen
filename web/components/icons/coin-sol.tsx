// Solana mark: three slanted bars. Source: Solana brand kit, https://solana.com/branding
// (solanaLogoMark.svg, 101×88). Simplified for 12–16 px: the corner rounding is dropped (the bar outlines are
// the official ones), and the purple-green gradient is replaced by currentColor (our only accent is yellow).
import { cn } from "@/lib/utils";
import { coinFrame, type CoinProps } from "./coin-base";

export function CoinSol({ className, ...props }: CoinProps) {
  return (
    <svg {...coinFrame({ ...props, className: cn("text-muted-foreground", className) }, "0 0 101 88", 101 / 88)}>
      <path fill="currentColor" d="M20 0H101L81 21.8H0ZM0 33.1H81L101 54.9H20ZM20 66.2H101L81 88H0Z" />
    </svg>
  );
}
