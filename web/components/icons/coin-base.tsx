import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

export interface CoinProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  /** px; 12–16 next to text. */
  size?: number;
}

/** Shared frame: decorative (the ticker text next to it stays), sits on the text baseline. */
export function coinFrame({ size = 14, className, ...rest }: CoinProps, viewBox: string, aspect = 1) {
  return {
    width: Math.round(size * aspect * 100) / 100,
    height: size,
    viewBox,
    "aria-hidden": true as const,
    focusable: "false" as const,
    className: cn("inline-block shrink-0 align-[-0.14em]", className),
    ...rest,
  };
}
