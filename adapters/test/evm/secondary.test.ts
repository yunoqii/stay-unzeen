import { describe, expect, it } from "vitest";
import { BaseError, RawContractError, createPublicClient, custom, decodeAbiParameters, decodeFunctionData, encodeErrorResult, getAddress, type Address, type PublicClient } from "viem";
import { hoodMainnet } from "../../src/evm/chain";
import { classifyEvmError } from "../../src/evm/errors";
import { EvmExecutor } from "../../src/evm/executor";
import { EvmFeeCache } from "../../src/evm/fees";
import { EvmKeyring } from "../../src/evm/keys";
import { LIFI_DIAMOND_4663, LifiClient, type Fetch } from "../../src/evm/lifi";
import { universalRouterAbi } from "../../src/evm/pons/abi/universal-router.generated";
import { PonsFeeSweeper, type PonsFeeTarget } from "../../src/evm/pons/creator";
import { PONS_ERROR_ABI } from "../../src/evm/pons/adapter";
import { encodeV4ExactInSingle, poolIdOf, ponsPoolKey, V4_EVENTS_ABI } from "../../src/evm/pons/v4";
import { EvmWithdrawer, parseEvmRecipient, roundDownSig } from "../../src/evm/withdraw";
import { readOnlyAdapter, TEST_MNEMONIC } from "./cases";

const TOKEN = getAddress("0xcd70e319f13d4611f2e5f5d603c52724bcea3300");
const HOOK = getAddress("0xe5e702641ea86f4ae6cc3cdaed2b886f976be044");
const VAULT = getAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
const ETH: Address = "0x0000000000000000000000000000000000000000";

describe("Uniswap v4 route", () => {
  it("pool key: ETH is currency0, Pons hook, snapshotted fee / tick spacing", () => {
    const k = ponsPoolKey(TOKEN, 0, 200, HOOK);
    expect(k).toEqual({ currency0: ETH, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK });
    expect(poolIdOf(k)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(poolIdOf(k)).not.toBe(poolIdOf({ ...k, tickSpacing: 60 }));
  });

  it("execute(V4_SWAP: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL) decodes back to the request", () => {
    const key = ponsPoolKey(TOKEN, 0, 200, HOOK);
    const data = encodeV4ExactInSingle({ key, zeroForOne: false, amountIn: 1234n, minOut: 999n, deadline: 1_900_000_000n });
    const d = decodeFunctionData({ abi: universalRouterAbi, data });
    expect(d.functionName).toBe("execute");
    const [commands, inputs, deadline] = d.args as readonly [`0x${string}`, readonly `0x${string}`[], bigint];
    expect(commands).toBe("0x10");
    expect(deadline).toBe(1_900_000_000n);
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]!);
    expect(actions).toBe("0x060c0f");
    const [swap] = decodeAbiParameters(
      [{ type: "tuple", components: [{ name: "poolKey", type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "minHopPriceX36", type: "uint256" }, { name: "hookData", type: "bytes" }] }],
      params[0]!,
    );
    expect(swap.zeroForOne).toBe(false);
    expect(swap.amountIn).toBe(1234n);
    expect(swap.amountOutMinimum).toBe(999n);
    expect(swap.poolKey.hooks).toBe(HOOK);
    const [settleCur, settleAmt] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[1]!);
    const [takeCur, takeMin] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[2]!);
    expect([settleCur, settleAmt]).toEqual([TOKEN, 1234n]); // sell: pay token
    expect([takeCur, takeMin]).toEqual([ETH, 999n]); // receive ETH
    expect(() => encodeV4ExactInSingle({ key, zeroForOne: true, amountIn: 1n << 128n, minOut: 0n, deadline: 1n })).toThrow(/uint128/);
  });

  it("router slippage revert maps to slippage", () => {
    const e = classifyEvmError(Object.assign(new Error("x"), {}), undefined);
    expect(e.code).toBe("internal");
    const data = encodeErrorResult({ abi: V4_EVENTS_ABI, errorName: "V4TooLittleReceived", args: [10n, 5n] });
    const err = new BaseError("estimate", { cause: new RawContractError({ data }) });
    expect(classifyEvmError(err, "preflight", undefined, PONS_ERROR_ABI).apiCode).toBe("slippage");
  });
});

describe("LI.FI fallback validation", () => {
  const good = () => ({
    tool: "kyberswap",
    action: { fromToken: { address: ETH }, toToken: { address: TOKEN }, fromAddress: VAULT, toAddress: VAULT, fromAmount: "1000" },
    estimate: { approvalAddress: LIFI_DIAMOND_4663, toAmount: "500", toAmountMin: "480" },
    transactionRequest: { to: LIFI_DIAMOND_4663, data: "0x736eac0b00", value: "0x3e8", chainId: 4663 },
  });
  const req = { fromToken: ETH, toToken: TOKEN, fromAmount: 1000n, vault: VAULT, minOut: 400n };
  const client = new LifiClient(async () => ({ ok: true, status: 200, json: async () => good() }));

  it("accepts only the pinned Diamond, this vault, these tokens, the exact value", () => {
    expect(client.validate(good(), req).toAmountMin).toBe(480n);
    const mut = (f: (b: ReturnType<typeof good>) => void) => {
      const b = good();
      f(b);
      return () => client.validate(b, req);
    };
    expect(mut((b) => (b.transactionRequest.to = "0x1111111111111111111111111111111111111111"))).toThrow(/target/);
    expect(mut((b) => (b.estimate.approvalAddress = "0x1111111111111111111111111111111111111111"))).toThrow(/spender/);
    expect(mut((b) => (b.action.toAddress = "0x1111111111111111111111111111111111111111"))).toThrow(/addresses/);
    expect(mut((b) => (b.transactionRequest.value = "0x3e9"))).toThrow(/value/);
    expect(mut((b) => (b.transactionRequest.chainId = 1))).toThrow(/chain/);
    expect(mut((b) => (b.action.toToken.address = "0x1111111111111111111111111111111111111111"))).toThrow(/tokens/);
    expect(() => client.validate(good(), { ...req, minOut: 481n })).toThrow(/minimum/);
  });

  it("sends only the vault address (no integrator, no recipient other than the vault)", async () => {
    let url = "";
    const f: Fetch = async (u) => {
      url = u;
      return { ok: true, status: 200, json: async () => good() };
    };
    await new LifiClient(f).quote(req);
    const q = new URL(url).searchParams;
    expect(q.get("fromAddress")).toBe(VAULT);
    expect(q.has("toAddress")).toBe(false);
    expect(q.has("integrator")).toBe(false);
    const addrs = url.match(/0x[0-9a-fA-F]{40}/g)!.map((a) => getAddress(a));
    expect(new Set(addrs)).toEqual(new Set([ETH, TOKEN, VAULT]));
  });

  it("HTTP errors map to API codes", async () => {
    const e404 = await new LifiClient(async () => ({ ok: false, status: 404, json: async () => ({ message: "No available quotes" }) })).quote(req).catch((x) => x);
    expect(e404.code).toBe("graduated");
    const eNet = await new LifiClient(async () => Promise.reject(new Error("ECONNRESET"))).quote(req).catch((x) => x);
    expect(eNet.code).toBe("venue_unavailable");
  });
});

describe("EVM withdraw rules", () => {
  it("rounds down to 3 significant digits like core", () => {
    expect(roundDownSig(0n)).toBe(0n);
    expect(roundDownSig(999n)).toBe(999n);
    expect(roundDownSig(123_456n)).toBe(123_000n);
    expect(roundDownSig(10n ** 27n - 1n)).toBe(999n * 10n ** 24n);
  });

  it("recipient: EIP-55 when mixed case, no zero address", () => {
    expect(parseEvmRecipient("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")).toBe(VAULT);
    expect(parseEvmRecipient(VAULT)).toBe(VAULT);
    expect(() => parseEvmRecipient("0xF39fd6e51aad88f6f4ce6ab8827279cfffb92266")).toThrow(/checksum/);
    expect(() => parseEvmRecipient("0x" + "0".repeat(40))).toThrow(/zero/);
    expect(() => parseEvmRecipient("vault")).toThrow(/EVM address/);
  });

  it("read-only network: refused before any RPC; unrounded and pool recipients refused", async () => {
    const calls: string[] = [];
    const client = createPublicClient({
      chain: hoodMainnet,
      transport: custom({
        async request({ method }) {
          calls.push(method);
          if (method === "eth_getCode") return "0x";
          throw new Error(method);
        },
      }),
    }) as PublicClient;
    const kr = new EvmKeyring(TEST_MNEMONIC);
    const mk = (allowSend: boolean) =>
      new EvmWithdrawer({
        executor: new EvmExecutor({ read: client, chainId: 4663, fees: new EvmFeeCache(1n, async () => 1n), allowSend }),
        funder: kr.funder(),
        isPoolAddress: (a) => a === kr.vault(1).address,
      });
    expect((await mk(false).withdrawToken({ vault: kr.vault(0), token: TOKEN, to: kr.vault(2).address, amount: 100n }).catch((e) => e)).code).toBe("venue_unavailable");
    expect(calls).toEqual([]);
    const w = mk(true);
    expect((await w.withdrawToken({ vault: kr.vault(0), token: TOKEN, to: kr.vault(2).address, amount: 1234n }).catch((e) => e)).message).toMatch(/3 significant/);
    expect((await w.withdrawToken({ vault: kr.vault(0), token: TOKEN, to: kr.vault(1).address, amount: 1230n }).catch((e) => e)).message).toMatch(/pool address/);
    expect((await w.withdrawEth({ vault: kr.vault(0), to: kr.funder().address, amount: 1230n }).catch((e) => e)).message).toMatch(/pool address/);
    expect(() => new EvmWithdrawer({ executor: w["ex"], funder: kr.funder(), gasDropWei: 1n })).toThrow(RangeError);
  });
});

describe("fee sweeper policy", () => {
  const base: PonsFeeTarget = {
    creatorIndex: 0,
    token: TOKEN,
    creator: VAULT,
    phase: 2,
    curvePending: 0n,
    poolPendingEth: 0n,
    poolPendingToken: 0n,
    escrow: 0n,
    balance: 0n,
  };
  const sw = new PonsFeeSweeper({
    adapter: readOnlyAdapter(createPublicClient({ chain: hoodMainnet, transport: custom({ request: async () => "0x" }) }) as PublicClient),
    executor: new EvmExecutor({ read: createPublicClient({ chain: hoodMainnet, transport: custom({ request: async () => "0x" }) }) as PublicClient, chainId: 4663, fees: new EvmFeeCache(1n, async () => 1n), allowSend: false }),
    keyring: new EvmKeyring(TEST_MNEMONIC),
    pickVault: () => new EvmKeyring(TEST_MNEMONIC).vault(0),
    minCollectWei: 1000n,
    keepWei: 100n,
  });

  it("pool ETH counts only when no memecoin conversion (operator-only) is pending", () => {
    expect(sw.collectable({ ...base, poolPendingEth: 900n })).toBe(900n);
    expect(sw.collectable({ ...base, poolPendingEth: 900n, poolPendingToken: 1n })).toBe(0n);
    expect(sw.collectable({ ...base, curvePending: 10n, escrow: 20n, balance: 150n })).toBe(80n);
  });

  it("below threshold: nothing is sent", async () => {
    const o = await sw.sweepOne({ ...base, escrow: 10n });
    expect(o.skipped).toBe("below_threshold");
    expect(o.steps).toEqual([]);
  });
});
