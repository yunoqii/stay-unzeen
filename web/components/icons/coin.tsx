import { CoinEth } from "./coin-eth";
import { CoinSol } from "./coin-sol";
import { CoinZec } from "./coin-zec";
import type { CoinProps } from "./coin-base";

/** The coin mark for a ticker, or nothing for anything else (USDC, token symbols). */
export function CoinIcon({ symbol, ...props }: CoinProps & { symbol: string }) {
  if (symbol === "ZEC") return <CoinZec {...props} />;
  if (symbol === "SOL") return <CoinSol {...props} />;
  if (symbol === "ETH") return <CoinEth {...props} />;
  return null;
}
