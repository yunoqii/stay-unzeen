import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { AdapterError } from "../../errors";
import { classifyEvmError } from "../errors";
import { universalRouterAbi } from "./abi/universal-router.generated";
import { v4QuoterAbi } from "./abi/v4-quoter.generated";

/**
 * Uniswap v4 on Robinhood Chain (developers.uniswap.org/docs/protocols/v4/deployments,
 * cross-checked: PoolManager / Permit2 / PositionManager are what the Pons factory
 * itself points at). A graduated Pons launch trades in ONE pool whose key the
 * factory snapshots: ETH (currency0) / token, fee = launch.poolFee (0),
 * tickSpacing = launch.tickSpacing (200), hooks = PonsV2MemeHook. The hook skims
 * its fee + creator tax from the OUTPUT side in afterSwap; the V4Quoter runs the
 * real swap (hook included) and reverts with the result, so its quote is exact.
 */
export const UNISWAP_V4_4663 = {
  poolManager: getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951"),
  universalRouter: getAddress("0x8876789976decbfcbbbe364623c63652db8c0904"),
  quoter: getAddress("0x8dc178efb8111bb0973dd9d722ebeff267c98f94"),
  stateView: getAddress("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"),
  permit2: getAddress("0x000000000022d473030f116ddee9f6b43ac78ba3"),
} as const;

export type UniswapV4Deployment = { [K in keyof typeof UNISWAP_V4_4663]: Address };

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

const NATIVE: Address = "0x0000000000000000000000000000000000000000";

/** Pool of a graduated native-quote Pons launch (ETH sorts first as address(0)). */
export function ponsPoolKey(token: Address, poolFee: number, tickSpacing: number, memeHook: Address): PoolKey {
  return { currency0: NATIVE, currency1: getAddress(token), fee: poolFee, tickSpacing, hooks: getAddress(memeHook) };
}

/** PoolId = keccak256(abi.encode(PoolKey)). */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

/** IV4Router.ExactInputSingleParams of the deployed router (has `minHopPriceX36`). */
const EXACT_IN_SINGLE = [
  {
    type: "tuple",
    components: [
      { name: "poolKey", type: "tuple", components: POOL_KEY_COMPONENTS },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "minHopPriceX36", type: "uint256" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

/** Universal Router command / v4 actions (Commands.sol, Actions.sol of the verified router). */
export const V4_SWAP = 0x10;
export const ACTION = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f } as const;

const U128_MAX = (1n << 128n) - 1n;

/** `execute(commands, inputs, deadline)` calldata for one exact-input single-pool swap. */
export function encodeV4ExactInSingle(p: { key: PoolKey; zeroForOne: boolean; amountIn: bigint; minOut: bigint; deadline: bigint }): Hex {
  if (p.amountIn <= 0n || p.amountIn > U128_MAX || p.minOut < 0n || p.minOut > U128_MAX) {
    throw new AdapterError("bad_request", "amount out of uint128 range");
  }
  const currencyIn = p.zeroForOne ? p.key.currency0 : p.key.currency1;
  const currencyOut = p.zeroForOne ? p.key.currency1 : p.key.currency0;
  const actions = encodePacked(["uint8", "uint8", "uint8"], [ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE_ALL, ACTION.TAKE_ALL]);
  const params: Hex[] = [
    encodeAbiParameters(EXACT_IN_SINGLE, [
      { poolKey: p.key, zeroForOne: p.zeroForOne, amountIn: p.amountIn, amountOutMinimum: p.minOut, minHopPriceX36: 0n, hookData: "0x" },
    ]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyIn, p.amountIn]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyOut, p.minOut]),
  ];
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params]);
  return encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [encodePacked(["uint8"], [V4_SWAP]), [input], p.deadline],
  });
}

/** Exact quote through V4Quoter (eth_call; the hook's skim included). */
export async function quoteV4ExactIn(read: PublicClient, quoter: Address, key: PoolKey, zeroForOne: boolean, amountIn: bigint, blockNumber?: bigint): Promise<bigint> {
  try {
    const { result } = await read.simulateContract({
      address: quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    return (result as readonly [bigint, bigint])[0];
  } catch (e) {
    throw classifyEvmError(e, "preflight");
  }
}

/** Pool initialized? (StateView.getSlot0 sqrtPriceX96 != 0). */
export async function v4PoolExists(read: PublicClient, stateView: Address, id: Hex): Promise<boolean> {
  const [sqrtPriceX96] = await read.readContract({
    address: stateView,
    abi: STATE_VIEW_ABI,
    functionName: "getSlot0",
    args: [id],
  });
  return sqrtPriceX96 !== 0n;
}

export const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);

/** v4-core IPoolManager.Swap (amounts from the swapper's side: negative = paid) + the Pons hook skim. */
export const V4_EVENTS_ABI = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event HookFeeCollected(bytes32 indexed poolId, address currency, uint256 feeAmount, uint256 taxAmount)",
  "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
  "error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)",
  "error DeadlinePassed(uint256 deadline)",
  "error AllowanceExpired(uint256 deadline)",
  "error InsufficientAllowance(uint256 amount)",
]);
