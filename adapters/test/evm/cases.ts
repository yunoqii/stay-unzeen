import type { Address, Hex, PublicClient } from "viem";
import { EvmExecutor } from "../../src/evm/executor";
import { EvmFeeCache } from "../../src/evm/fees";
import { EvmKeyring } from "../../src/evm/keys";
import { MemoryCreatorIndexCounter } from "../../src/keys";
import { ponsV2CurveAbi } from "../../src/evm/pons/abi/curve";
import { PonsAdapter, PONS_ERROR_ABI } from "../../src/evm/pons/adapter";
import { quoteBuy, quoteSell, snipeTaxBps, type BuyQuote, type SellQuote } from "../../src/evm/pons/math";

/** Public Hardhat/Anvil test mnemonic: tests only, never holds value. */
export const TEST_MNEMONIC = "test test test test test test test test test test test junk";

export function readOnlyAdapter(client: PublicClient): PonsAdapter {
  const ex = new EvmExecutor({
    read: client,
    chainId: 4663,
    fees: new EvmFeeCache(200_000_000n, async () => 20_000_000n),
    allowSend: false,
    errorAbi: PONS_ERROR_ABI,
  });
  const kr = new EvmKeyring(TEST_MNEMONIC, new MemoryCreatorIndexCounter());
  return new PonsAdapter({ executor: ex, keyring: kr, funders: { pick: async () => kr.funder(0) } });
}

export interface RealBuyCase {
  hash: Hex;
  curve: Address;
  recipient: Address;
  blockNumber: string;
  quoteIn: string;
  tokensOut: string;
  fee: string;
  tax: string;
  refund: string;
}

export interface RealSellCase {
  hash: Hex;
  curve: Address;
  blockNumber: string;
  tokensIn: string;
  quoteOut: string;
  fee: string;
  tax: string;
}

/** Prices a real mainnet buy from the curve state one block before it. */
export async function priceRealBuy(adapter: PonsAdapter, client: PublicClient, c: RealBuyCase): Promise<BuyQuote> {
  const bn = BigInt(c.blockNumber);
  const { state } = await adapter.curveState(c.curve, bn - 1n);
  const blk = await client.getBlock({ blockNumber: bn });
  const exempt = await client.readContract({ address: c.curve, abi: ponsV2CurveAbi, functionName: "snipeTaxExempt", args: [c.recipient], blockNumber: bn - 1n });
  // A buy's `quoteIn` in the event is `spent`; with no refund it equals the sent value.
  return quoteBuy(state, BigInt(c.quoteIn) + BigInt(c.refund), snipeTaxBps(state, exempt, blk.timestamp));
}

export async function priceRealSell(adapter: PonsAdapter, c: RealSellCase): Promise<SellQuote> {
  const { state } = await adapter.curveState(c.curve, BigInt(c.blockNumber) - 1n);
  return quoteSell(state, BigInt(c.tokensIn));
}
