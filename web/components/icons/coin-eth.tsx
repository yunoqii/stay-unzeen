// Ethereum mark: the octahedron ("diamond"). Source: ethereum.org brand assets, https://ethereum.org/assets
// (eth-diamond-black.svg, 1920×1920). Same five facets and opacities; viewBox cropped to the glyph and the
// fill set to currentColor (monochrome, our only accent is yellow).
import { cn } from "@/lib/utils";
import { coinFrame, type CoinProps } from "./coin-base";

export function CoinEth({ className, ...props }: CoinProps) {
  return (
    <svg {...coinFrame({ ...props, className: cn("text-muted-foreground", className) }, "420 80 1080 1760", 1080 / 1760)}>
      <g fill="currentColor">
        <path d="m959.8 730.9-539.8 245.4 539.8 319.1 539.9-319.1z" opacity=".6" />
        <path d="m420.2 976.3 539.8 319.1v-564.5-650.3z" opacity=".45" />
        <path d="m960 80.6v650.3 564.5l539.8-319.1z" opacity=".8" />
        <path d="m420 1078.7 539.8 760.7v-441.8z" opacity=".45" />
        <path d="m959.8 1397.6v441.8l540.2-760.7z" opacity=".8" />
      </g>
    </svg>
  );
}
