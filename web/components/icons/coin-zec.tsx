// Zcash mark: the "Z" in a circle. Source: Zcash brand kit, https://z.cash/brand/
// (zcash-logo.svg, z.cash/wp-content/uploads/2023/03). Circle and Z merged into one even-odd path so the Z is
// a cut-out (works on any background); no other change. Brand yellow #F4B728 = our accent (--zec).
import { coinFrame, type CoinProps } from "./coin-base";

export function CoinZec(props: CoinProps) {
  return (
    <svg {...coinFrame(props, "0 0 65 65")}>
      <path
        fill="var(--color-zec, #F4B728)"
        fillRule="evenodd"
        d="M32.5 0a32.5 32.5 0 1 1 0 65a32.5 32.5 0 0 1 0-65ZM29.591 13v5.146H21v6.2h13.33L21 41.974v4.667h8.591v5.113h5.279v-5.113h8.59v-6.2H30.131L43.46 22.813v-4.667h-8.59V13Z"
      />
    </svg>
  );
}
